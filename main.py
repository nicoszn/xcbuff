"""
Freebuff FFmpeg API — main.py
Entry point for the FastAPI service. Exposes FFmpeg-powered video operations
via a clean REST API.

Operations:
- convert        — transcode to a target format/codec/resolution
- split          — cut a segment by time range
- merge          — concatenate multiple inputs
- extract        — pull audio, a single track, frames, or metadata
- aspect_ratio   — pad/resize to a target aspect ratio
- compress       — reduce file size via CRF/bitrate tuning
- metadata       — read file metadata without transcoding
- probe          — low-level FFprobe JSON output
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
import uuid
from pathlib import Path
from typing import Annotated

from fastapi import FastAPI, File, HTTPException, Query, UploadFile
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, Field

app = FastAPI(
    title="FFmpeg API",
    description="FFmpeg video operations exposed over HTTP.",
    version="1.0.0",
)

# ---------------------------------------------------------------------------
# Configuration — adjust via env vars or keep defaults.
# ---------------------------------------------------------------------------
FFMPEG_BIN = os.getenv("FFMPEG_BIN", "ffmpeg")
FFPROBE_BIN = os.getenv("FFPROBE_BIN", "ffprobe")
UPLOAD_DIR = Path(os.getenv("UPLOAD_DIR", "/tmp/ffmpeg_uploads"))
OUTPUT_DIR = Path(os.getenv("OUTPUT_DIR", "/tmp/ffmpeg_outputs"))
TEMP_DIR = Path(os.getenv("TEMP_DIR", "/tmp/ffmpeg_temp"))

MAX_UPLOAD_MB = int(os.getenv("MAX_UPLOAD_MB", "500"))

for _d in (UPLOAD_DIR, OUTPUT_DIR, TEMP_DIR):
    _d.mkdir(parents=True, exist_ok=True)


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------
class ConvertRequest(BaseModel):
    format: str = Field(default="mp4", description="Target container format")
    video_codec: str = Field(default="libx264", description="Video codec")
    audio_codec: str = Field(default="aac", description="Audio codec")
    crf: int = Field(default=23, ge=0, le=51, description="Constant rate factor")
    preset: str = Field(default="medium", description="Encoding preset")
    resolution: str | None = Field(
        default=None, description="Scale to WxH, e.g. 1280x720"
    )
    fps: int | None = Field(default=None, description="Target frame rate")
    bitrate: str | None = Field(
        default=None, description="Video bitrate, e.g. 1000k"
    )
    audio_bitrate: str | None = Field(
        default=None, description="Audio bitrate, e.g. 128k"
    )
    keep_original: bool = Field(
        default=False, description="Keep original audio/video streams where possible"
    )


class SplitRequest(BaseModel):
    start: str = Field(description="Start time (HH:MM:SS or seconds)")
    end: str = Field(description="End time (HH:MM:SS or seconds)")
    format: str = Field(default="mp4", description="Output container")
    video_codec: str = Field(default="copy", description="Video codec")
    audio_codec: str = Field(default="copy", description="Audio codec")


class MergeRequest(BaseModel):
    format: str = Field(default="mp4", description="Output container")
    video_codec: str = Field(default="copy", description="Video codec")
    audio_codec: str = Field(default="copy", description="Audio codec")


class ExtractAudioRequest(BaseModel):
    format: str = Field(default="mp3", description="Audio output format")
    audio_codec: str = Field(default="libmp3lame", description="Audio codec")
    bitrate: str = Field(default="192k", description="Audio bitrate")


class AspectRatioRequest(BaseModel):
    width: int = Field(ge=1, description="Target width")
    height: int = Field(ge=1, description="Target height")
    method: str = Field(
        default="pad",
        pattern="^(pad|scale|crop)$",
        description="pad = add black bars, scale = stretch, crop = center crop",
    )
    video_codec: str = Field(default="libx264", description="Video codec")
    crf: int = Field(default=23, ge=0, le=51, description="Constant rate factor")


class CompressRequest(BaseModel):
    crf: int = Field(default=28, ge=0, le=51, description="Higher = smaller, lower = better quality")
    preset: str = Field(default="slow", description="Encoding preset")
    audio_bitrate: str = Field(default="128k", description="Audio bitrate")
    format: str = Field(default="mp4", description="Output container")
    max_size_mb: int | None = Field(
        default=None, ge=1, description="Target max size (approximate — iterative)"
    )


class MetadataResponse(BaseModel):
    format: dict
    streams: list[dict]
    duration_sec: float | None = None
    size_bytes: int | None = None
    bitrate_kbps: float | None = None


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _run_ffmpeg(
    args: list[str],
    *,
    input_path: Path | None = None,
    output_path: Path | None = None,
    timeout_sec: int = 600,
) -> Path:
    """Run ffmpeg with the given CLI args and return the output path."""
    if shutil.which(FFMPEG_BIN) is None:
        raise HTTPException(status_code=500, detail="ffmpeg not found on PATH")

    cmd = [FFMPEG_BIN, *args]
    try:
        proc = subprocess.run(
            cmd,
            input=None,
            capture_output=True,
            text=True,
            timeout=timeout_sec,
        )
    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=504, detail="FFmpeg operation timed out")

    if proc.returncode != 0:
        raise HTTPException(
            status_code=500,
            detail=f"FFmpeg failed: {proc.stderr.strip() or proc.stdout.strip()}",
        )

    if output_path and not output_path.exists():
        raise HTTPException(status_code=500, detail="Output file was not created")
    return output_path or input_path  # pragma: no cover


def _run_ffprobe(path: Path) -> dict:
    """Return parsed JSON from ffprobe -print_format json -show_format -show_streams."""
    if shutil.which(FFPROBE_BIN) is None:
        raise HTTPException(status_code=500, detail="ffprobe not found on PATH")
    try:
        proc = subprocess.run(
            [FFPROBE_BIN, "-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", str(path)],
            capture_output=True,
            text=True,
            timeout=60,
        )
    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=504, detail="FFprobe timed out")
    if proc.returncode != 0:
        raise HTTPException(status_code=500, detail=f"FFprobe failed: {proc.stderr.strip()}")
    try:
        return json.loads(proc.stdout)
    except json.JSONDecodeError:
        raise HTTPException(status_code=500, detail="Failed to parse ffprobe output")


def _probe(path: Path) -> MetadataResponse:
    data = _run_ffprobe(path)
    fmt = data.get("format", {})
    streams = data.get("streams", [])
    duration = float(fmt.get("duration", 0)) if fmt.get("duration") else None
    size = int(fmt.get("size", 0)) if fmt.get("size") else None
    bitrate = (float(fmt.get("bit_rate", 0)) / 1000) if fmt.get("bit_rate") else None
    return MetadataResponse(
        format=fmt,
        streams=streams,
        duration_sec=duration,
        size_bytes=size,
        bitrate_kbps=bitrate,
    )


def _save_upload(file: UploadFile, prefix: str) -> Path:
    ext = Path(file.filename or "upload").suffix if file.filename else ""
    safe_name = f"{prefix}_{uuid.uuid4().hex}{ext}"
    dest = UPLOAD_DIR / safe_name
    try:
        content = file.file.read()
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Failed to read uploaded file: {e}")
    if len(content) > MAX_UPLOAD_MB * 1024 * 1024:
        raise HTTPException(status_code=413, detail=f"File too large (max {MAX_UPLOAD_MB}MB)")
    dest.write_bytes(content)
    return dest


def _cleanup(path: Path) -> None:
    try:
        if path.exists():
            path.unlink()
    except OSError:
        pass


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@app.get("/health")
async def health() -> dict:
    """Liveness check."""
    return {"status": "ok", "ffmpeg": shutil.which(FFMPEG_BIN) is not None}


@app.get("/metadata/{file_id}")
async def get_metadata(file_id: str) -> MetadataResponse:
    """Read metadata for a previously uploaded file."""
    path = UPLOAD_DIR / file_id
    if not path.exists():
        raise HTTPException(status_code=404, detail="File not found")
    return _probe(path)


@app.get("/probe/{file_id}")
async def probe_file(file_id: str) -> dict:
    """Raw ffprobe JSON for a previously uploaded file."""
    path = UPLOAD_DIR / file_id
    if not path.exists():
        raise HTTPException(status_code=404, detail="File not found")
    return _run_ffprobe(path)


@app.post("/upload")
async def upload_file(file: UploadFile = File(...)) -> dict:
    """Upload a video/audio file and get back a file_id to use with other endpoints."""
    saved = _save_upload(file, "upload")
    meta = _probe(saved)
    return {
        "file_id": saved.name,
        "filename": file.filename,
        "content_type": file.content_type,
        "duration_sec": meta.duration_sec,
        "size_bytes": meta.size_bytes,
        "streams": [
            {"index": s.get("index"), "codec_type": s.get("codec_type"), "codec_name": s.get("codec_name")}
            for s in meta.streams
        ],
    }


@app.post("/convert")
async def convert_video(
    file: UploadFile = File(...),
    request: ConvertRequest = None,  # Pydantic reads body if multipart not used
) -> dict:
    """
    Convert/transcode a video to a target format.
    Accepts a multipart upload with an optional JSON body for options,
    or a plain JSON body plus a `file` field reference when using the
    uploaded-file workflow.
    """
    # Try to read options from body if it looks like JSON (non-multipart)
    if request is None:
        request = ConvertRequest()

    input_path = _save_upload(file, "convert")
    try:
        out_name = f"converted_{uuid.uuid4().hex}.{request.format}"
        out_path = OUTPUT_DIR / out_name

        args = ["-y", "-i", str(input_path)]

        # Codec / quality
        if request.video_codec and request.video_codec != "copy":
            args += ["-c:v", request.video_codec]
        if request.audio_codec and request.audio_codec != "copy":
            args += ["-c:a", request.audio_codec]
        args += ["-crf", str(request.crf), "-preset", request.preset]

        if request.bitrate:
            args += ["-b:v", request.bitrate]
        if request.audio_bitrate:
            args += ["-b:a", request.audio_bitrate]
        if request.fps:
            args += ["-r", str(request.fps)]
        if request.resolution:
            args += ["-vf", f"scale={request.resolution}"]

        args += ["-movflags", "+faststart", "-map", "0", str(out_path)]

        _run_ffmpeg(args, input_path=input_path, output_path=out_path)
        return {"file_id": out_path.name, "output_path": str(out_path), "format": request.format}
    finally:
        _cleanup(input_path)


@app.post("/split")
async def split_video(
    file: UploadFile = File(...),
    request: SplitRequest = None,
) -> dict:
    """Cut a video segment from start to end time."""
    if request is None:
        request = SplitRequest()
    input_path = _save_upload(file, "split")
    try:
        out_name = f"split_{uuid.uuid4().hex}.{request.format}"
        out_path = OUTPUT_DIR / out_name
        args = [
            "-y", "-i", str(input_path),
            "-ss", request.start, "-to", request.end,
            "-c:v", request.video_codec, "-c:a", request.audio_codec,
            "-map", "0", str(out_path),
        ]
        _run_ffmpeg(args, input_path=input_path, output_path=out_path)
        return {"file_id": out_path.name, "output_path": str(out_path)}
    finally:
        _cleanup(input_path)


@app.post("/merge")
async def merge_videos(
    files: list[UploadFile] = File(..., description="Multiple video files to concatenate"),
    request: MergeRequest = None,
) -> dict:
    """
    Merge multiple video files. For formats/codecs that differ, re-encodes
    using the concat demuxer via a temporary file list.
    """
    if request is None:
        request = MergeRequest()

    inputs = []
    try:
        for idx, f in enumerate(files):
            inputs.append(_save_upload(f, f"merge_{idx}"))

        out_name = f"merged_{uuid.uuid4().hex}.{request.format}"
        out_path = OUTPUT_DIR / out_name

        # Build a concat file list
        list_path = TEMP_DIR / f"concat_{uuid.uuid4().hex}.txt"
        list_path.write_text("\n".join(f"file '{p.as_posix()}'" for p in inputs))

        args = [
            "-y", "-f", "concat", "-safe", "0", "-i", str(list_path),
            "-c:v", request.video_codec, "-c:a", request.audio_codec,
            "-map", "0", str(out_path),
        ]
        _run_ffmpeg(args, output_path=out_path)
        return {"file_id": out_path.name, "output_path": str(out_path), "merged_count": len(inputs)}
    finally:
        for p in inputs:
            _cleanup(p)
        _cleanup(list_path)


@app.post("/extract/audio")
async def extract_audio(
    file: UploadFile = File(...),
    request: ExtractAudioRequest = None,
) -> dict:
    """Extract the audio track to a separate audio file."""
    if request is None:
        request = ExtractAudioRequest()
    input_path = _save_upload(file, "extract_audio")
    try:
        out_name = f"audio_{uuid.uuid4().hex}.{request.format}"
        out_path = OUTPUT_DIR / out_name
        args = [
            "-y", "-i", str(input_path),
            "-vn",
            "-c:a", request.audio_codec,
            "-b:a", request.bitrate,
            str(out_path),
        ]
        _run_ffmpeg(args, input_path=input_path, output_path=out_path)
        return {"file_id": out_path.name, "output_path": str(out_path), "format": request.format}
    finally:
        _cleanup(input_path)


@app.post("/extract/metadata")
async def extract_metadata(
    file: UploadFile = File(...),
) -> MetadataResponse:
    """Extract metadata from the uploaded file without transcoding."""
    input_path = _save_upload(file, "extract_metadata")
    try:
        return _probe(input_path)
    finally:
        _cleanup(input_path)


@app.post("/extract/frames")
async def extract_frames(
    file: UploadFile = File(...),
    interval_sec: float = Query(1.0, ge=0.1, description="Capture a frame every N seconds"),
    format: str = Query("png", description="Image format for extracted frames"),
) -> dict:
    """Extract frames from the video at a regular interval."""
    input_path = _save_upload(file, "extract_frames")
    try:
        out_dir = TEMP_DIR / f"frames_{uuid.uuid4().hex}"
        out_dir.mkdir(parents=True, exist_ok=True)
        # Use image2 muxer to write one file per frame
        args = [
            "-y", "-i", str(input_path),
            "-vf", f"fps=1/{interval_sec}",
            "-q:v", "2",
            str(out_dir / f"frame_%04d.{format}"),
        ]
        _run_ffmpeg(args, input_path=input_path, output_path=out_dir / "dummy")
        frames = sorted(out_dir.iterdir())
        # Move results to OUTPUT_DIR for persistence
        persisted = [OUTPUT_DIR / p.name for p in frames]
        for src, dst in zip(frames, persisted):
            shutil.move(str(src), str(dst))
        _cleanup(out_dir)
        return {
            "file_ids": [p.name for p in persisted],
            "count": len(persisted),
            "interval_sec": interval_sec,
            "format": format,
        }
    finally:
        _cleanup(input_path)


@app.post("/aspect_ratio")
async def aspect_ratio_convert(
    file: UploadFile = File(...),
    request: AspectRatioRequest = None,
) -> dict:
    """
    Convert video to a specific aspect ratio by padding, scaling, or cropping.
    """
    if request is None:
        request = AspectRatioRequest()
    input_path = _save_upload(file, "aspect_ratio")
    try:
        out_name = f"aspect_{uuid.uuid4().hex}.mp4"
        out_path = OUTPUT_DIR / out_name

        if request.method == "pad":
            vf = f"pad={request.width}:{request.height}:(ow-iw)/2:(oh-ih)/2"
        elif request.method == "crop":
            vf = f"crop={request.width}:{request.height}:(iw-{request.width})/2:(ih-{request.height})/2"
        else:  # scale
            vf = f"scale={request.width}:{request.height}"

        args = [
            "-y", "-i", str(input_path),
            "-vf", vf,
            "-c:v", request.video_codec,
            "-crf", str(request.crf),
            "-c:a", "copy",
            "-movflags", "+faststart",
            str(out_path),
        ]
        _run_ffmpeg(args, input_path=input_path, output_path=out_path)
        return {
            "file_id": out_path.name,
            "output_path": str(out_path),
            "width": request.width,
            "height": request.height,
            "method": request.method,
        }
    finally:
        _cleanup(input_path)


@app.post("/compress")
async def compress_video(
    file: UploadFile = File(...),
    request: CompressRequest = None,
) -> dict:
    """
    Compress a video by re-encoding at a higher CRF and slower preset.
    When max_size_mb is provided, iteratively adjusts CRF until the target
    size is reached (within a small margin).
    """
    if request is None:
        request = CompressRequest()
    input_path = _save_upload(file, "compress")
    try:
        out_name = f"compressed_{uuid.uuid4().hex}.{request.format}"
        out_path = OUTPUT_DIR / out_name

        crf = request.crf
        max_iter = 6

        for _ in range(max_iter):
            args = [
                "-y", "-i", str(input_path),
                "-c:v", "libx264",
                "-preset", request.preset,
                "-crf", str(crf),
                "-b:a", request.audio_bitrate,
                "-movflags", "+faststart",
                str(out_path),
            ]
            _run_ffmpeg(args, input_path=input_path, output_path=out_path)
            size_mb = out_path.stat().st_size / (1024 * 1024)
            if request.max_size_mb is None:
                break
            if size_mb <= request.max_size_mb * 1.05:
                break
            # Increase CRF to reduce size further (step of 4)
            crf = min(crf + 4, 51)

        meta = _probe(out_path)
        return {
            "file_id": out_path.name,
            "output_path": str(out_path),
            "crf_used": crf,
            "size_mb": round(out_path.stat().st_size / (1024 * 1024), 2),
            "duration_sec": meta.duration_sec,
        }
    finally:
        _cleanup(input_path)


@app.get("/output/{file_id}")
async def download_output(file_id: str) -> Response:
    """Download a previously generated output file."""
    path = OUTPUT_DIR / file_id
    if not path.exists():
        raise HTTPException(status_code=404, detail="Output file not found")
    return Response(
        content=path.read_bytes(),
        media_type="application/octet-stream",
        headers={"Content-Disposition": f"attachment; filename={file_id}"},
    )


# ---------------------------------------------------------------------------
# Startup
# ---------------------------------------------------------------------------
def _check_tools() -> None:
    if shutil.which(FFMPEG_BIN) is None:
        print("WARNING: ffmpeg not found on PATH — video endpoints will return 500")
    if shutil.which(FFPROBE_BIN) is None:
        print("WARNING: ffprobe not found on PATH — metadata endpoints will return 500")


_check_tools()
