/* ── FFmpeg API — Alpine.js Application ───────────────────────────── */

function ffmpegApiBase() {
  // Prefer an explicit API origin if Freebuff serves UI and API separately.
  if (window.FFMPEG_API_URL) return window.FFMPEG_API_URL;
  return window.location.origin;
}

document.addEventListener('alpine:init', () => {
  Alpine.store('ffmpeg', {
    // ── State ────────────────────────────────────────────────────────
    files: [],
    outputs: [],
    loading: false,
    progressPct: 0,
    logs: [],
    lastResult: null,
    toast: { show: false, msg: '', cls: '' },
    statusText: 'checking',
    statusDot: 'ok',
    statusChip: '',

    // ── Operation options ───────────────────────────────────────────
    convert: {
      format: 'mp4',
      video_codec: 'libx264',
      audio_codec: 'aac',
      crf: 23,
      preset: 'medium',
      resolution: '',
      fps: null,
      bitrate: '',
      audio_bitrate: '',
      crfLabel: 'CRF 23',
    },
    split: { start: '00:00:00', end: '00:00:10' },
    extract: { audioFormat: 'mp3', frameInterval: 1, frameFormat: 'png' },
    aspect: { width: 1920, height: 1080, method: 'pad', crf: 23 },
    compress: { crf: 28, preset: 'slow', audio_bitrate: '128k', format: 'mp4', maxSizeMb: '' },

    // ── API Base ─────────────────────────────────────────────────────
    api(path) {
      return ffmpegApiBase() + path;
    },

    // ── Health check ─────────────────────────────────────────────────
    async ping() {
      try {
        const r = await fetch(this.api('/health'), { cache: 'no-store' });
        if (!r.ok) throw new Error('unhealthy');
        const j = await r.json();
        this.statusText = j.status === 'ok' ? 'api ok' : 'degraded';
        this.statusDot = j.ffmpeg ? 'ok' : 'err';
        this.statusChip = j.ffmpeg
          ? 'margin-left:auto'
          : 'margin-left:auto;color:var(--danger)';
        if (!j.ffmpeg) this.log('ffmpeg not found on the server — endpoints will fail', 'err');
      } catch (e) {
        this.statusText = 'unreachable';
        this.statusDot = 'err';
        this.statusChip = 'margin-left:auto;color:var(--danger)';
        this.log('api unreachable: ' + (e.message || ''), 'err');
      }
    },

    // ── File selection ───────────────────────────────────────────────
    onFilesSelected(e) {
      const items = Array.from(e.target.files || []);
      for (const f of items) {
        this.files.push({ id: crypto.randomUUID(), name: f.name, size: f.size, file: f });
      }
      this.log(items.length + ' file(s) added', 'ok');
      e.target.value = '';
    },

    // ── Generic POST helper ──────────────────────────────────────────
    async post(path, body, isForm = false) {
      this.loading = true;
      this.progressPct = 10;
      this.log('→ ' + path, 'dim');
      try {
        const opts = {
          method: 'POST',
          headers: isForm ? {} : { 'Content-Type': 'application/json' },
          body: isForm ? body : JSON.stringify(body),
          mode: 'cors',
        };
        const r = await fetch(this.api(path), opts);
        this.progressPct = 80;
        const text = await r.text();
        let json = null;
        try { json = JSON.parse(text); } catch(_) {}
        if (!r.ok) {
          const detail = json?.detail || text || r.statusText;
          throw new Error(String(detail));
        }
        this.progressPct = 100;
        this.log('← ok', 'ok');
        return json || text;
      } catch (e) {
        this.log('← ' + e.message, 'err');
        throw e;
      } finally {
        this.loading = false;
        setTimeout(() => { this.progressPct = 0; }, 600);
      }
    },

    // ── Convert ──────────────────────────────────────────────────────
    async convert() {
      if (!this.files.length) return this.error('upload a file first');
      const file = this.files[0].file;
      const fd = new FormData();
      fd.append('file', file);
      const opts = {
        format: this.convert.format,
        video_codec: this.convert.video_codec,
        audio_codec: this.convert.audio_codec || 'aac',
        crf: Number(this.convert.crf),
        preset: this.convert.preset,
        resolution: this.convert.resolution || null,
        fps: this.convert.fps ? Number(this.convert.fps) : null,
        bitrate: this.convert.bitrate || null,
        audio_bitrate: this.convert.audio_bitrate || null,
        keep_original: false,
      };
      try {
        const res = await this.post('/convert', fd, true);
        await this.keepOutput(res);
      } catch (e) { this.error(e.message); }
    },

    // ── Split ────────────────────────────────────────────────────────
    async split() {
      if (!this.files.length) return this.error('upload a file first');
      const file = this.files[0].file;
      const fd = new FormData();
      fd.append('file', file);
      const opts = { start: this.split.start, end: this.split.end, format: 'mp4', video_codec: 'copy', audio_codec: 'copy' };
      try {
        const res = await this.post('/split', fd, true);
        await this.keepOutput(res);
      } catch (e) { this.error(e.message); }
    },

    // ── Merge ────────────────────────────────────────────────────────
    async merge() {
      if (this.files.length < 2) return this.error('upload at least 2 files');
      const fd = new FormData();
      for (const f of this.files) fd.append('files', f.file);
      const opts = { format: 'mp4', video_codec: 'copy', audio_codec: 'copy' };
      try {
        const res = await this.post('/merge', fd, true);
        await this.keepOutput(res);
      } catch (e) { this.error(e.message); }
    },

    // ── Extract audio ────────────────────────────────────────────────
    async extractAudio() {
      if (!this.files.length) return this.error('upload a file first');
      const file = this.files[0].file;
      const fd = new FormData();
      fd.append('file', file);
      const opts = { format: this.extract.audioFormat, audio_codec: audioCodecFor(this.extract.audioFormat), bitrate: '192k' };
      try {
        const res = await this.post('/extract/audio', fd, true);
        await this.keepOutput(res);
      } catch (e) { this.error(e.message); }
    },

    // ── Extract frames ───────────────────────────────────────────────
    async extractFrames() {
      if (!this.files.length) return this.error('upload a file first');
      const file = this.files[0].file;
      const fd = new FormData();
      fd.append('file', file);
      try {
        const res = await this.post(
          '/extract/frames?interval_sec=' + this.extract.frameInterval + '&format=' + this.extract.frameFormat,
          fd,
          true
        );
        this.lastResult = {
          kind: 'file',
          name: res.count + ' frames',
          meta: { count: res.count, format: res.format, interval_sec: res.interval_sec },
        };
        this.log('frames extracted: ' + res.count, 'ok');
      } catch (e) { this.error(e.message); }
    },

    // ── Extract metadata ─────────────────────────────────────────────
    async extractMetadata() {
      if (!this.files.length) return this.error('upload a file first');
      const file = this.files[0].file;
      const fd = new FormData();
      fd.append('file', file);
      try {
        const meta = await this.post('/extract/metadata', fd, true);
        this.lastResult = {
          kind: 'metadata',
          meta: {
            duration_sec: fmtDur(meta.duration_sec),
            size_bytes: fmtBytes(meta.size_bytes),
            bitrate_kbps: meta.bitrate_kbps != null ? Math.round(meta.bitrate_kbps) + ' kbps' : null,
            streams: meta.streams.map(s => s.codec_type + ': ' + s.codec_name).join(', '),
          },
        };
      } catch (e) { this.error(e.message); }
    },

    // ── Aspect ratio ─────────────────────────────────────────────────
    async aspectRatio() {
      if (!this.files.length) return this.error('upload a file first');
      const file = this.files[0].file;
      const fd = new FormData();
      fd.append('file', file);
      const opts = {
        width: Number(this.aspect.width),
        height: Number(this.aspect.height),
        method: this.aspect.method,
        video_codec: 'libx264',
        crf: Number(this.aspect.crf),
      };
      try {
        const res = await this.post('/aspect_ratio', fd, true);
        await this.keepOutput(res);
      } catch (e) { this.error(e.message); }
    },

    // ── Compress ─────────────────────────────────────────────────────
    async compress() {
      if (!this.files.length) return this.error('upload a file first');
      const file = this.files[0].file;
      const fd = new FormData();
      fd.append('file', file);
      const opts = {
        crf: Number(this.compress.crf),
        preset: this.compress.preset || 'slow',
        audio_bitrate: this.compress.audio_bitrate || '128k',
        format: this.compress.format || 'mp4',
        max_size_mb: this.compress.maxSizeMb ? Number(this.compress.maxSizeMb) : null,
      };
      try {
        const res = await this.post('/compress', fd, true);
        await this.keepOutput(res);
      } catch (e) { this.error(e.message); }
    },

    // ── Output tracking ──────────────────────────────────────────────
    async keepOutput(res) {
      if (res.file_id) {
        this.outputs.push({ id: crypto.randomUUID(), name: res.file_id, size: 0 });
        this.lastResult = { kind: 'file', name: res.file_id };
        this.log('output: ' + res.file_id, 'ok');
      } else {
        this.lastResult = { kind: 'file', name: 'done', meta: res };
        this.log('done', 'ok');
      }
    },

    clearOutputs() {
      this.outputs = [];
      this.lastResult = null;
      this.log('outputs cleared', 'dim');
    },
    clearAll() {
      this.files = [];
      this.outputs = [];
      this.lastResult = null;
      this.log('cleared', 'dim');
    },

    // ── UI helpers ───────────────────────────────────────────────────
    error(msg) {
      this.toast = { show: true, msg, cls: 'err' };
      this.log(msg, 'err');
      setTimeout(() => { this.toast.show = false; }, 2600);
    },
    log(line, cls = '') {
      this.logs.push({ line, cls });
      if (this.logs.length > 120) this.logs.shift();
    },
    fmtBytes(b) {
      if (!b && b !== 0) return '';
      const u = ['B','KB','MB','GB'];
      let i = 0, v = Number(b);
      while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
      return v.toFixed(i ? 1 : 0) + ' ' + u[i];
    },
    fmtVal(v) {
      if (typeof v === 'number') return fmtBytes(v) || v;
      return v;
    },
  });
});

// ── Pure helpers (kept out of Alpine.store for clarity) ──────────────

function audioCodecFor(format) {
  return ({ mp3: 'libmp3lame', m4a: 'aac', wav: 'pcm_s16le', flac: 'flac', ogg: 'libvorbis' })[format] || 'aac';
}

function fmtDur(sec) {
  if (!sec && sec !== 0) return '';
  sec = Number(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h) return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  return `${m}:${String(s).padStart(2,'0')}`;
}
