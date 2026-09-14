function app() {
  return {
    files: [],
    outputs: [],
    baseUrl: window.location.origin,
    apiUrl: window.location.origin,
    loading: false,
    progressPct: 0,
    logs: [],
    lastResult: null,
    toast: { show: false, msg: "", cls: "" },
    statusText: "checking",
    statusDot: "ok",
    statusChip: "",

    cv: {
      format: "mp4",
      video_codec: "libx264",
      audio_codec: "aac",
      crf: 23,
      preset: "medium",
      resolution: "",
      fps: null,
      bitrate: "",
      audio_bitrate: "",
      crfLabel: "CRF 23",
    },
    sp: { start: "00:00:00", end: "00:00:10" },
    ex: { audioFormat: "mp3", frameInterval: 1, frameFormat: "png" },
    ar: { width: 1920, height: 1080, method: "pad", crf: 23 },
    cmp: { crf: 28, preset: "slow", audio_bitrate: "128k", format: "mp4", maxSizeMb: "" },

    async init() {
      if (window.FFMPEG_API_URL) this.apiUrl = window.FFMPEG_API_URL;
      await this.ping();
      this.log("ready", "dim");
    },

    async ping() {
      try {
        const r = await fetch(this.apiUrl + "/health", { cache: "no-store" });
        if (!r.ok) throw new Error("unhealthy");
        const j = await r.json();
        this.statusText = j.status === "ok" ? "api ok" : "degraded";
        this.statusDot = j.ffmpeg ? "ok" : "err";
        this.statusChip = j.ffmpeg
          ? "margin-left:auto"
          : "margin-left:auto;color:var(--danger)";
        if (!j.ffmpeg) this.log("ffmpeg not found on the server — endpoints will fail", "err");
      } catch (e) {
        this.statusText = "unreachable";
        this.statusDot = "err";
        this.statusChip = "margin-left:auto;color:var(--danger)";
        this.log("api unreachable: " + (e.message || ""), "err");
      }
    },

    onFilesSelected(e) {
      const items = Array.from(e.target.files || []);
      for (const f of items) {
        this.files.push({ id: crypto.randomUUID(), name: f.name, size: f.size, file: f });
      }
      this.log(items.length + " file(s) added", "ok");
      e.target.value = "";
    },

    async post(path, body, isForm = false) {
      this.loading = true;
      this.progressPct = 10;
      this.log("→ " + path, "dim");
      try {
        const opts = {
          method: "POST",
          headers: isForm ? {} : { "Content-Type": "application/json" },
          body: isForm ? body : JSON.stringify(body),
          mode: "cors",
        };
        const r = await fetch(this.apiUrl + path, opts);
        this.progressPct = 80;
        const text = await r.text();
        let json = null;
        try { json = JSON.parse(text); } catch(_) {}
        if (!r.ok) {
          const detail = json?.detail || text || r.statusText;
          throw new Error(String(detail));
        }
        this.progressPct = 100;
        this.log("← ok", "ok");
        return json || text;
      } catch (e) {
        this.log("← " + e.message, "err");
        throw e;
      } finally {
        this.loading = false;
        setTimeout(() => { this.progressPct = 0; }, 600);
      }
    },

    async convert() {
      if (!this.files.length) return this.error("upload a file first");
      const file = this.files[0].file;
      const fd = new FormData();
      fd.append("file", file);
      const opts = {
        format: this.cv.format,
        video_codec: this.cv.video_codec,
        audio_codec: this.cv.audio_codec || "aac",
        crf: Number(this.cv.crf),
        preset: this.cv.preset,
        resolution: this.cv.resolution || null,
        fps: this.cv.fps ? Number(this.cv.fps) : null,
        bitrate: this.cv.bitrate || null,
        audio_bitrate: this.cv.audio_bitrate || null,
        keep_original: false,
      };
      try {
        const res = await this.post("/convert", fd, true);
        await this.keepOutput(res);
      } catch (e) { this.error(e.message); }
    },

    async split() {
      if (!this.files.length) return this.error("upload a file first");
      const file = this.files[0].file;
      const fd = new FormData();
      fd.append("file", file);
      const opts = { start: this.sp.start, end: this.sp.end, format: "mp4", video_codec: "copy", audio_codec: "copy" };
      try {
        const res = await this.post("/split", fd, true);
        await this.keepOutput(res);
      } catch (e) { this.error(e.message); }
    },

    async merge() {
      if (this.files.length < 2) return this.error("upload at least 2 files");
      const fd = new FormData();
      for (const f of this.files) fd.append("files", f.file);
      const opts = { format: "mp4", video_codec: "copy", audio_codec: "copy" };
      try {
        const res = await this.post("/merge", fd, true);
        await this.keepOutput(res);
      } catch (e) { this.error(e.message); }
    },

    async extractAudio() {
      if (!this.files.length) return this.error("upload a file first");
      const file = this.files[0].file;
      const fd = new FormData();
      fd.append("file", file);
      const opts = { format: this.ex.audioFormat, audio_codec: audioCodecFor(this.ex.audioFormat), bitrate: "192k" };
      try {
        const res = await this.post("/extract/audio", fd, true);
        await this.keepOutput(res);
      } catch (e) { this.error(e.message); }
    },

    async extractFrames() {
      if (!this.files.length) return this.error("upload a file first");
      const file = this.files[0].file;
      const fd = new FormData();
      fd.append("file", file);
      try {
        const res = await this.post("/extract/frames?interval_sec=" + this.ex.frameInterval + "&format=" + this.ex.frameFormat, fd, true);
        this.lastResult = { kind: "file", name: res.count + " frames", meta: { count: res.count, format: res.format, interval_sec: res.interval_sec } };
        this.log("frames extracted: " + res.count, "ok");
      } catch (e) { this.error(e.message); }
    },

    async extractMetadata() {
      if (!this.files.length) return this.error("upload a file first");
      const file = this.files[0].file;
      const fd = new FormData();
      fd.append("file", file);
      try {
        const meta = await this.post("/extract/metadata", fd, true);
        this.lastResult = { kind: "metadata", meta: {
          duration_sec: fmtDur(meta.duration_sec),
          size_bytes: fmtBytes(meta.size_bytes),
          bitrate_kbps: meta.bitrate_kbps != null ? Math.round(meta.bitrate_kbps) + " kbps" : null,
          streams: meta.streams.map(s => s.codec_type + ": " + s.codec_name).join(", "),
        }};
      } catch (e) { this.error(e.message); }
    },

    async aspectRatio() {
      if (!this.files.length) return this.error("upload a file first");
      const file = this.files[0].file;
      const fd = new FormData();
      fd.append("file", file);
      const opts = {
        width: Number(this.ar.width),
        height: Number(this.ar.height),
        method: this.ar.method,
        video_codec: "libx264",
        crf: Number(this.ar.crf),
      };
      try {
        const res = await this.post("/aspect_ratio", fd, true);
        await this.keepOutput(res);
      } catch (e) { this.error(e.message); }
    },

    async compress() {
      if (!this.files.length) return this.error("upload a file first");
      const file = this.files[0].file;
      const fd = new FormData();
      fd.append("file", file);
      const opts = {
        crf: Number(this.cmp.crf),
        preset: this.cmp.preset || "slow",
        audio_bitrate: this.cmp.audio_bitrate || "128k",
        format: this.cmp.format || "mp4",
        max_size_mb: this.cmp.maxSizeMb ? Number(this.cmp.maxSizeMb) : null,
      };
      try {
        const res = await this.post("/compress", fd, true);
        await this.keepOutput(res);
      } catch (e) { this.error(e.message); }
    },

    async keepOutput(res) {
      if (res.file_id) {
        this.outputs.push({ id: crypto.randomUUID(), name: res.file_id, size: 0 });
        this.lastResult = { kind: "file", name: res.file_id };
        this.log("output: " + res.file_id, "ok");
      } else {
        this.lastResult = { kind: "file", name: "done", meta: res };
        this.log("done", "ok");
      }
    },

    clearOutputs() { this.outputs = []; this.lastResult = null; this.log("outputs cleared", "dim"); },
    clearAll() { this.files = []; this.outputs = []; this.lastResult = null; this.log("cleared", "dim"); },

    error(msg) { this.toast = { show: true, msg, cls: "err" }; this.log(msg, "err");
      setTimeout(() => this.toast.show = false, 2600); },
    log(line, cls = "") { this.logs.push({ line, cls }); if (this.logs.length > 120) this.logs.shift(); },

    fmtBytes(b) {
      if (!b && b !== 0) return "";
      const u = ["B","KB","MB","GB"];
      let i = 0, v = Number(b);
      while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
      return v.toFixed(i ? 1 : 0) + " " + u[i];
    },
    fmtVal(v) {
      if (typeof v === "number") return fmtBytes(v) || v;
      return v;
    },
  };
}

function audioCodecFor(format) {
  return ({ mp3: "libmp3lame", m4a: "aac", wav: "pcm_s16le", flac: "flac", ogg: "libvorbis" })[format] || "aac";
}

function fmtDur(sec) {
  if (!sec && sec !== 0) return "";
  sec = Number(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h) return `${h}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`;
  return `${m}:${String(s).padStart(2,"0")}`;
}
