/* Live Studio — video engine
 * Composites cameras, video files, labels and transitions on the GPU (WebGL2).
 * The output canvas is what gets streamed and recorded.
 */
(function () {
  'use strict';

  const VS = `#version 300 es
  in vec2 a_pos;
  uniform vec4 u_dst;   // x, y, w, h  (0..1, top-left origin)
  uniform vec4 u_src;   // u, v, w, h  (0..1, top-left origin)
  out vec2 v_uv;
  void main() {
    vec2 p = u_dst.xy + a_pos * u_dst.zw;
    gl_Position = vec4(p.x * 2.0 - 1.0, 1.0 - p.y * 2.0, 0.0, 1.0);
    v_uv = u_src.xy + a_pos * u_src.zw;
  }`;

  const FS = `#version 300 es
  precision highp float;
  in vec2 v_uv;
  out vec4 o;
  uniform sampler2D u_tex;
  uniform int u_mode;        // 0 = video with color correction, 1 = overlay (rgba), 2 = solid colour
  uniform vec4 u_solid;
  uniform float u_opacity;
  uniform float u_exposure;  // stops
  uniform float u_contrast;
  uniform float u_saturation;
  uniform float u_temp;      // -1 cool .. +1 warm
  uniform float u_tint;      // -1 green .. +1 magenta
  uniform float u_gamma;     // midtones
  uniform float u_black;     // black level
  uniform int u_zebra;
  uniform int u_keyOn;       // remove one background colour from an overlay (web pages)
  uniform vec3 u_keyColor;
  uniform float u_keyTol;
  uniform int u_bgra;        // web-page pictures arrive as BGRA with premultiplied alpha
  uniform float u_deint;     // 1080i camera seen as whole frames: blend each line with the next (one texel down) — no combing
  uniform int u_ck;          // green screen: remove the key colour from a camera / video (like OBS's chroma key)
  uniform vec2 u_ckC;        // key colour as Cb, Cr (BT.709)
  uniform vec3 u_ckP;        // strength (similarity), edge softness, spill
  uniform int u_matte;       // show the cut-out in black & white (setting up the green screen, Preview only)
  void main() {
    if (u_mode == 2) { o = vec4(u_solid.rgb, u_solid.a * u_opacity); return; }
    vec4 t = texture(u_tex, v_uv);
    if (u_deint > 0.0) t = 0.5 * (t + texture(u_tex, v_uv + vec2(0.0, u_deint)));
    if (u_bgra == 1) { t = vec4(t.b, t.g, t.r, t.a); if (t.a > 0.0) t.rgb = t.rgb / t.a; }
    if (u_mode == 1) {
      float a = t.a;
      if (u_keyOn == 1) { float d = distance(t.rgb, u_keyColor); a *= smoothstep(u_keyTol, u_keyTol + 0.12, d); }
      o = vec4(t.rgb, a * u_opacity); return;
    }
    vec3 c = t.rgb;
    float ka = 1.0;
    if (u_ck == 1) {
      vec2 cc = vec2(dot(c, vec3(-0.1146, -0.3854, 0.5)), dot(c, vec3(0.5, -0.4542, -0.0458)));
      float base = distance(cc, u_ckC) - u_ckP.x;
      ka = pow(clamp(base / max(u_ckP.y, 0.0001), 0.0, 1.0), 1.5);
      float sp = pow(clamp(base / max(u_ckP.z, 0.0001), 0.0, 1.0), 1.5);
      c = mix(vec3(dot(c, vec3(0.2126, 0.7152, 0.0722))), c, sp);
      if (u_matte == 1) { o = vec4(vec3(ka), u_opacity); return; }
    }
    vec3 lin = pow(max(c, 0.0), vec3(2.2));
    lin *= exp2(u_exposure);
    lin *= vec3(1.0 + u_temp * 0.22, 1.0 - u_tint * 0.16, 1.0 - u_temp * 0.22);
    c = pow(max(lin, 0.0), vec3(1.0 / 2.2));
    c = pow(max(c, 0.0), vec3(1.0 / max(u_gamma, 0.05)));
    c = (c - 0.5) * u_contrast + 0.5;
    if (u_black >= 0.0) c = c * (1.0 - u_black) + u_black;
    else c = (c + u_black) / (1.0 + u_black);
    float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
    c = mix(vec3(l), c, u_saturation);
    c = clamp(c, 0.0, 1.0);
    if (u_zebra == 1) {
      float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
      if (lum > 0.95 && mod(gl_FragCoord.x + gl_FragCoord.y, 14.0) < 7.0) c = mix(c, vec3(0.0), 0.65);
    }
    o = vec4(c, u_opacity * ka);
  }`;

  const NEUTRAL = { exposure: 0, contrast: 1, saturation: 1, temp: 0, tint: 0, gamma: 1, black: 0 };
  const FILL = { zoom: 1, x: 0.5, y: 0.5 };
  /* where the small picture of a shot goes: [x, y, w, h] as parts of the whole picture (0…1).
     p.rect = { x, y, w, h } (anywhere, any size); p.keep !== false keeps the 16:9 shape (h follows w).
     Older shows only have a corner and a size: same place as before. Always kept inside the picture. */
  function pipRect(p, W, H) {
    const A = (W / H) / (16 / 9);
    if (p.rect && isFinite(p.rect.w)) {
      const w = clamp(p.rect.w, 0.03, 1), h = p.keep !== false ? clamp(w * A, 0.03, 1) : clamp(p.rect.h, 0.03, 1);
      return [clamp(p.rect.x || 0, 0, 1 - w), clamp(p.rect.y || 0, 0, 1 - h), w, h];
    }
    const s = clamp(p.size || 0.3, 0.1, 0.9), w = s, h = clamp(s * A, 0.03, 1);
    const mx = 0.03, my = 0.03 * W / H, c = p.corner || 'tr';
    return [c.includes('r') ? 1 - w - mx : mx, c.includes('t') ? my : 1 - h - my, w, h];
  }
  /* green screen of a shot → key settings for drawing (null when off). Strength, softness and spill work like OBS's
     chroma key (similarity / smoothness / key colour spill reduction); the native engine gets the same numbers. */
  function keyCbCr(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || ''), n = m ? parseInt(m[1], 16) : 0x00ff00;
    const r = (n >> 16 & 255) / 255, g = (n >> 8 & 255) / 255, b = (n & 255) / 255;
    return [-0.1146 * r - 0.3854 * g + 0.5 * b, 0.5 * r - 0.4542 * g - 0.0458 * b];
  }
  const GREEN_DEF = { color: '#00ff00', strength: 0.55, soft: 0.2, spill: 0.35 };
  const ccCache = new WeakMap();
  function greenOf(shot) {
    const g = shot && shot.green;
    if (!g || !g.on || !shot.main || !shot.main.source) return null;
    let c = ccCache.get(g);
    if (!c || c.color !== g.color) { c = { color: g.color, cc: keyCbCr(g.color) }; ccCache.set(g, c); }
    const cc = c.cc;
    // the sliders are fractions of the way from the key colour to grey, so they mean the same for a bright
    // pure green and for the duller green a real screen has (picked from the picture)
    const R = Math.max(0.05, Math.hypot(cc[0], cc[1]));
    return { bg: g.bg || 'black', cb: cc[0], cr: cc[1], sim: R * clamp(g.strength ?? GREEN_DEF.strength, 0, 1), smooth: R * clamp(g.soft ?? GREEN_DEF.soft, 0.01, 1), spill: R * clamp(g.spill ?? GREEN_DEF.spill, 0.01, 1) };
  }
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const ease = t => t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;

  class Engine {
    constructor(opts = {}) {
      this.W = opts.width || 1920;
      this.H = opts.height || 1080;
      this.fps = opts.fps || 30;
      this.canvas = document.createElement('canvas');
      this.canvas.width = this.W;
      this.canvas.height = this.H;
      this.canvas.className = 'program-canvas';
      const gl = this.canvas.getContext('webgl2', {
        alpha: false, antialias: false, premultipliedAlpha: false,
        preserveDrawingBuffer: false, powerPreference: 'high-performance'
      });
      if (!gl) throw new Error('This computer\'s graphics driver does not support WebGL2.');
      this.gl = gl;
      this._initGL();

      this.sources = new Map();   // id -> { el, kind, tex, w, h, ready, fresh }
      this.colors = new Map();    // sourceId -> colour params
      this.labels = new Map();    // labelId -> { canvas, ctx, tex, alpha, target, data, dirty }
      this.webs = new Map();      // web overlay id -> { data, alpha, target }
      this.frames = new Map();    // smoothed framing per shot layer
      this.thumbs = new Map();    // shotId -> 2D canvas
      this.sourceViews = new Map(); // canvas -> sourceId (full uncropped source)
      this.layerViews = new Map();  // canvas -> { shot, part: 'main' (the shot without its small picture) | 'pip' (only the small picture, cropped) }
      this.previewCanvas = null;
      this.previewCtx = null;

      this.programId = null;
      this.previewId = null;
      this.trans = null;
      this.black = { v: 0, from: 0, to: 0, start: 0, dur: 1 };
      this.moveSpeed = 0.12;
      this.zebra = true;
      this.bypass = new Set();
      this.deint = new Set();     // sources that are interlaced (1080i) — blended in the classic engine
      this.getShot = () => null;
      this.onTransitionEnd = null;

      this.frameNo = 0;
      this.lastFrameAt = 0;
      this.lastThumbAt = 0;
      this.thumbEvery = 333;
      // Both off (1.28.3): on the real PC the frame sync held camera frames, starving the capture cards, and
      // uploading them took 8–9 ms a frame — far worse than the normal video path. Kept only for testing.
      this.cameraLock = false;
      this.frameSync = false;
      this._used = new Map();
      this.stats = { fps: 0, renderMs: 0, frames: 0, missed: 0, since: performance.now() };
      this._fpsCount = 0; this._fpsAt = performance.now();
      this._stream = null;
      this.running = false;
    }

    /* ---------- GL setup ---------- */
    _initGL() {
      const gl = this.gl;
      const sh = (type, src) => {
        const s = gl.createShader(type);
        gl.shaderSource(s, src); gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
        return s;
      };
      const p = gl.createProgram();
      gl.attachShader(p, sh(gl.VERTEX_SHADER, VS));
      gl.attachShader(p, sh(gl.FRAGMENT_SHADER, FS));
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
      this.prog = p;
      gl.useProgram(p);
      this.u = {};
      ['u_dst', 'u_src', 'u_tex', 'u_mode', 'u_solid', 'u_opacity', 'u_exposure', 'u_contrast', 'u_saturation',
        'u_temp', 'u_tint', 'u_gamma', 'u_black', 'u_zebra', 'u_keyOn', 'u_keyColor', 'u_keyTol', 'u_bgra', 'u_ck', 'u_ckC', 'u_ckP', 'u_matte', 'u_deint'].forEach(n => { this.u[n] = gl.getUniformLocation(p, n); });
      const vao = gl.createVertexArray();
      gl.bindVertexArray(vao);
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
      const loc = gl.getAttribLocation(p, 'a_pos');
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      gl.uniform1i(this.u.u_tex, 0);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    }

    _newTex() {
      const gl = this.gl;
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return t;
    }

    /* ---------- sources ---------- */
    setSource(id, el, kind) {
      this.removeSource(id);
      const s = { el, kind, tex: this._newTex(), w: 0, h: 0, ready: false, fresh: true, uploaded: false };
      if (kind === 'video' && el.requestVideoFrameCallback) {
        // only re-upload when the camera/video actually delivers a new frame
        const cb = (t, meta) => {
          if (s.sync) { if (this.sources.get(id) === s && s.rvfc) el.requestVideoFrameCallback(cb); return; } // the frame sync below is in charge
          const now = performance.now();
          s.fresh = true; s.count = (s.count || 0) + 1;
          if (meta && meta.presentedFrames) { if (s.pf && meta.presentedFrames > s.pf + 1) s.skipped = (s.skipped || 0) + (meta.presentedFrames - s.pf - 1); s.pf = meta.presentedFrames; }
          // how fast frames really arrive (the camera's own clock when it tells us), and gaps where it was late
          const ct = meta && meta.captureTime ? meta.captureTime : now;
          if (s.lastCt) {
            const d = ct - s.lastCt;
            if (d > 2 && d < 250) {
              s.iv = s.iv ? s.iv * 0.99 + d * 0.01 : d; s.win = Math.max(s.win || 0, d);
              if (s.iv && d > s.iv * 1.6 && el.srcObject) { s.late = (s.late || 0) + 1; s.worstGap = Math.max(s.worstGap || 0, d); s.gapLog = s.gapLog || []; s.gapLog.push(now); while (s.gapLog.length && now - s.gapLog[0] > 60000) s.gapLog.shift(); }
            }
          }
          s.lastCt = ct; s.lastFresh = now;
          if (this.sources.get(id) === s && s.rvfc) el.requestVideoFrameCallback(cb);
        };
        el.requestVideoFrameCallback(cb);
        s.rvfc = true;
        s.lastFresh = performance.now();
        el.addEventListener('seeked', () => { s.fresh = true; });
        el.addEventListener('loadeddata', () => { s.fresh = true; });
      }
      this.sources.set(id, s);
      if (kind === 'video' && el.srcObject && this.frameSync) this._startSync(id, s);
      return s;
    }
    /* Frame sync for live inputs: every camera frame is taken straight from the capture card as it arrives (not on
       the screen's refresh), kept in a small queue, and each program frame uses exactly the next one. Arrival jitter
       is absorbed by the queue (1–3 frames), so a camera picture is never shown twice or skipped just because it
       arrived a moment before or after the screen refresh. */
    _startSync(id, s) {
      if (typeof MediaStreamTrackProcessor !== 'function') return;
      const track = s.el.srcObject.getVideoTracks()[0];
      if (!track) return;
      let reader;
      try { reader = new MediaStreamTrackProcessor({ track, maxBufferSize: 4 }).readable.getReader(); } catch (e) { return; }
      s.q = []; s.sync = true; s.reader = reader;
      (async () => {
        try {
          for (;;) {
            const r = await reader.read();
            if (r.done) break;
            const f = r.value;
            if (this.sources.get(id) !== s || !s.sync) { f.close(); break; }
            const now = performance.now(), ts = f.timestamp / 1000; // the capture card's own clock
            s.count = (s.count || 0) + 1;
            if (s.lastCt !== undefined) {
              const d = ts - s.lastCt;
              if (d > 2 && d < 250) {
                s.iv = s.iv ? s.iv * 0.99 + d * 0.01 : d; s.win = Math.max(s.win || 0, d);
                if (d > s.iv * 1.6) { s.late = (s.late || 0) + 1; s.worstGap = Math.max(s.worstGap || 0, d); s.gapLog = s.gapLog || []; s.gapLog.push(now); while (s.gapLog.length && now - s.gapLog[0] > 60000) s.gapLog.shift(); }
              }
            }
            s.lastCt = ts; s.lastFresh = now;
            s.q.push(f);
            while (s.q.length > 4) { s.q.shift().close(); }
          }
        } catch (e) { /* the input went away */ }
        s.sync = false;
        for (const f of s.q || []) f.close();
        s.q = [];
      })();
    }
    /* a web page's picture: raw BGRA pixels sent in pieces (only what changed), uploaded straight to the graphics card */
    setRawSource(id) {
      this.removeSource(id);
      const s = { el: null, kind: 'raw', tex: this._newTex(), w: 0, h: 0, ready: false, uploaded: false, patches: [] };
      this.sources.set(id, s);
      return s;
    }
    rawPatch(id, f) {
      const s = this.sources.get(id);
      if (!s || s.kind !== 'raw') return;
      if (f.full) s.patches = [];          // a whole picture replaces anything still waiting
      s.patches.push(f);
      if (s.patches.length > 120) s.patches = s.patches.slice(-60); // never let a backlog build up
    }
    // a new picture for an existing picture source (the next slide): no gap, the old one shows until it is uploaded
    swapImage(id, el) {
      const s = this.sources.get(id);
      if (!s || s.kind !== 'image') return false;
      s.el = el; s.dirty = true;
      return true;
    }
    removeSource(id) {
      const s = this.sources.get(id);
      if (s) {
        if (s.reader) { s.sync = false; try { s.reader.cancel(); } catch (e) { /* */ } for (const f of s.q || []) f.close(); s.q = []; }
        this.gl.deleteTexture(s.tex); this.sources.delete(id);
      }
    }
    sourceSize(id) {
      const s = this.sources.get(id);
      if (!s) return null;
      if (s.kind === 'raw' || (s.sync && s.w && s.h)) return s.w && s.h ? { w: s.w, h: s.h } : null;
      const el = s.el;
      const w = el.videoWidth || el.naturalWidth || el.width || 0;
      const h = el.videoHeight || el.naturalHeight || el.height || 0;
      return w && h ? { w, h } : null;
    }
    setColor(id, params) { this.colors.set(id, Object.assign({}, NEUTRAL, params || {})); }

    _upload(id) {
      const s = this.sources.get(id);
      if (!s) return null;
      const el = s.el;
      const gl = this.gl;
      if (s.kind === 'raw') {
        if (!s.patches.length) return s;
        gl.bindTexture(gl.TEXTURE_2D, s.tex);
        for (const f of s.patches) {
          if (f.full || f.w !== s.w || f.h !== s.h) {
            if (!f.full) continue;           // a piece for a size we don't have yet: wait for the whole picture
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, f.w, f.h, 0, gl.RGBA, gl.UNSIGNED_BYTE, f.data);
            s.w = f.w; s.h = f.h; s.uploaded = true; s.ready = true;
          } else if (s.uploaded) {
            gl.texSubImage2D(gl.TEXTURE_2D, 0, f.x, f.y, f.rw, f.rh, gl.RGBA, gl.UNSIGNED_BYTE, f.data);
          }
        }
        s.patches = []; s.ver = (s.ver || 0) + 1;
        return s;
      }
      if (s.kind === 'video' && s.sync) {
        // frame sync: take exactly one frame from the queue for this program frame
        const q = s.q, cont = s.upFrame === this.frameNo - 1;
        s.upFrame = this.frameNo; s.popped = 0; s.dropNow = 0;
        if (!cont) while (q.length > 1) q.shift().close();            // just came into use: start from the newest
        else while (q.length > 3) { q.shift().close(); s.dropNow++; } // fell behind (e.g. a slow frame): catch up
        const f = q.shift();
        if (!f) return s;                                              // nothing new yet: keep showing the last one
        try {
          gl.bindTexture(gl.TEXTURE_2D, s.tex);
          const w = f.displayWidth, h = f.displayHeight;
          if (w !== s.w || h !== s.h || !s.uploaded) { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, f); s.w = w; s.h = h; }
          else gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, f);
          s.uploaded = true; s.ready = true; s.ver = (s.ver || 0) + 1; s.popped = 1;
        } catch (e) { /* keep the last picture */ }
        f.close();
        return s;
      }
      if (s.kind === 'video') {
        if (el.readyState < 2 || !el.videoWidth) { s.ready = false; return s; }
        if (s.rvfc && !s.fresh && s.uploaded) {
          // safety net: if frame callbacks stop arriving while playing, fall back to uploading every frame
          if (!el.paused && performance.now() - s.lastFresh > 1500) s.rvfc = false;
          else return s;
        }
      } else if (s.kind === 'image') {
        if (el.tagName === 'IMG' && !(el.complete && el.naturalWidth)) return s;
        if (s.uploaded && !s.dirty) return s;
      }
      const w = el.videoWidth || el.naturalWidth || el.width;
      const h = el.videoHeight || el.naturalHeight || el.height;
      gl.bindTexture(gl.TEXTURE_2D, s.tex);
      try {
        if (w !== s.w || h !== s.h || !s.uploaded) {
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, el);
          s.w = w; s.h = h;
        } else {
          gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, el);
        }
        s.uploaded = true; s.ready = true; s.fresh = false; s.dirty = false; s.ver = (s.ver || 0) + 1;
      } catch (e) { s.ready = false; }
      return s;
    }

    /* ---------- labels ---------- */
    setLabel(label, visible) {
      let L = this.labels.get(label.id);
      if (!L) {
        const c = document.createElement('canvas');
        c.width = this.W; c.height = this.H;
        L = { canvas: c, ctx: c.getContext('2d'), tex: this._newTex(), alpha: 0, target: 0, dirty: true, data: null };
        this.labels.set(label.id, L);
      }
      const key = JSON.stringify(label);
      if (L.key !== key) { L.data = Object.assign({}, label); L.key = key; L.dirty = true; }
      if (visible !== undefined) L.target = visible ? 1 : 0;
    }
    removeLabel(id) {
      const L = this.labels.get(id);
      if (L) { this.gl.deleteTexture(L.tex); this.labels.delete(id); }
    }
    setPreviewLabel(data) {
      if (!this.previewLabel) { const c = document.createElement('canvas'); c.width = this.W; c.height = this.H; this.previewLabel = { canvas: c, ctx: c.getContext('2d'), tex: this._newTex() }; }
      const PL = this.previewLabel;
      if (PL.canvas.width !== this.W || PL.canvas.height !== this.H) { PL.canvas.width = this.W; PL.canvas.height = this.H; }
      PL.data = data ? Object.assign({}, data) : null; PL.dirty = true;
    }
    labelVisible(id) { const L = this.labels.get(id); return !!(L && L.target > 0); }
    // a graphic cued in Preview: Preview shows the live shot with it (webId = a picture / web page), or without it (program only)
    setPreviewCue(cue) { this.previewCue = cue || null; }

    /* ---------- web page overlays (e.g. live translation captions) ---------- */
    setWeb(cfg, visible) {
      let w = this.webs.get(cfg.id);
      if (!w) { w = { alpha: 0, target: 0 }; this.webs.set(cfg.id, w); }
      w.data = cfg;
      if (visible !== undefined) w.target = visible ? 1 : 0;
    }
    removeWeb(id) { this.webs.delete(id); }
    webVisible(id) { const w = this.webs.get(id); return !!(w && w.target > 0); }
    _drawWebs(dt) {
      const gl = this.gl;
      for (const [id, w] of this.webs) {
        const fade = w.data.fadeMs ?? 400;
        const step = fade > 0 ? dt / fade : 1;
        if (w.alpha < w.target) w.alpha = Math.min(w.target, w.alpha + step);
        else if (w.alpha > w.target) w.alpha = Math.max(w.target, w.alpha - step);
        if (w.alpha <= 0) continue;
        this._drawWebLayer(w, id, ease(w.alpha));
      }
    }
    _drawWebLayer(w, id, alpha) {
      const gl = this.gl;
      {
        const d = w.data, s = this.sources.get(d.src || id);
        if (!s || !s.ready) return;
        const r = d.rect || [0, 0, 1, 1];
        gl.bindTexture(gl.TEXTURE_2D, s.tex);
        gl.uniform1i(this.u.u_mode, 1);
        gl.uniform1i(this.u.u_bgra, s.kind === 'raw' ? 1 : 0);
        gl.uniform1f(this.u.u_opacity, alpha * (d.opacity ?? 1));
        const k = d.key || {};
        gl.uniform1i(this.u.u_keyOn, k.on ? 1 : 0);
        const hex = /^#?([0-9a-f]{6})$/i.exec(k.color || '#000000'), n = hex ? parseInt(hex[1], 16) : 0;
        gl.uniform3f(this.u.u_keyColor, (n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255);
        gl.uniform1f(this.u.u_keyTol, k.tol ?? 0.15);
        gl.uniform4fv(this.u.u_dst, r);
        gl.uniform4fv(this.u.u_src, [0, 0, 1, 1]);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        gl.uniform1i(this.u.u_keyOn, 0);
        gl.uniform1i(this.u.u_bgra, 0);
      }
    }


    /* ---------- program control ---------- */
    cut(shotId) {
      const from = this.programId;
      this.trans = null;
      this.programId = shotId;
      if (this.onTransitionEnd) this.onTransitionEnd(shotId, from);
    }
    fade(shotId, ms) {
      if (!ms || this.programId == null) return this.cut(shotId);
      if (this.trans) this.programId = this.trans.to;
      this.trans = { from: this.programId, to: shotId, start: performance.now(), dur: ms };
    }
    get inTransition() { return !!this.trans; }
    setBlack(on, ms = 600) {
      this.black = { v: this.black.v, from: this.black.v, to: on ? 1 : 0, start: performance.now(), dur: Math.max(1, ms) };
    }
    get isBlack() { return this.black.to === 1; }

    /* ---------- framing ---------- */
    uvFor(sourceId, frame, rectAspect) {
      const sz = this.sourceSize(sourceId) || { w: 16, h: 9 };
      const sa = sz.w / sz.h;
      const da = rectAspect || (this.W / this.H);
      let uw = 1, uh = 1;
      if (sa > da) uw = da / sa; else uh = sa / da;
      const z = clamp(frame && frame.zoom || 1, 1, 8);
      uw /= z; uh /= z;
      const cx = clamp(frame ? frame.x : 0.5, uw / 2, 1 - uw / 2);
      const cy = clamp(frame ? frame.y : 0.5, uh / 2, 1 - uh / 2);
      return [cx - uw / 2, cy - uh / 2, uw, uh];
    }
    _smooth(key, target) {
      const t = target || { zoom: 1, x: 0.5, y: 0.5 };
      let c = this.frames.get(key);
      if (!c || c.seen < this.frameNo - 1) {
        c = { zoom: t.zoom, x: t.x, y: t.y, seen: this.frameNo, upd: this.frameNo };
        this.frames.set(key, c);
        return c;
      }
      if (c.upd !== this.frameNo) {
        const k = clamp(this.moveSpeed, 0.01, 1) * (60 / this.fps);
        const kk = clamp(k, 0, 1);
        c.zoom += (t.zoom - c.zoom) * kk;
        c.x += (t.x - c.x) * kk;
        c.y += (t.y - c.y) * kk;
        if (Math.abs(t.zoom - c.zoom) < 1e-4) c.zoom = t.zoom;
        c.upd = this.frameNo;
      }
      c.seen = this.frameNo;
      return c;
    }
    _layers(shot, smooth) {
      const out = [];
      if (!shot || !shot.main) return out;
      const W = this.W, H = this.H;
      const g = greenOf(shot);
      if (g) out.push({ source: g.bg, frame: FILL, rect: [0, 0, 1, 1], bg: true }); // what shows where the green was
      out.push({
        source: shot.main.source,
        frame: smooth ? this._smooth(shot.id + ':m', shot.main.frame) : shot.main.frame,
        rect: [0, 0, 1, 1],
        key: g
      });
      const p = shot.pip;
      if (p && p.enabled && p.source) out.push({ source: p.source, frame: smooth ? this._smooth(shot.id + ':p', p.frame) : p.frame, rect: pipRect(p, W, H), border: p.border !== false });
      return out;
    }

    /* ---------- drawing ---------- */
    _solid(rect, rgba, opacity) {
      const gl = this.gl;
      gl.uniform1i(this.u.u_mode, 2);
      gl.uniform4fv(this.u.u_solid, rgba);
      gl.uniform1f(this.u.u_opacity, opacity);
      gl.uniform4fv(this.u.u_dst, rect);
      gl.uniform4fv(this.u.u_src, [0, 0, 1, 1]);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    _video(sourceId, rect, uv, opacity, zebra, key, matte) {
      const gl = this.gl;
      if (/^#[0-9a-f]{6}$/i.test(sourceId || '')) { const n = parseInt(sourceId.slice(1), 16); this._solid(rect, [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255, 1], opacity); return; }
      const s = this.sources.get(sourceId);
      if (!s || !s.ready) { if (!key) this._solid(rect, [0.07, 0.08, 0.1, 1], opacity); return; }
      const c = this.bypass.has(sourceId) ? NEUTRAL : (this.colors.get(sourceId) || NEUTRAL);
      gl.bindTexture(gl.TEXTURE_2D, s.tex);
      gl.uniform1i(this.u.u_mode, 0);
      gl.uniform1f(this.u.u_opacity, opacity);
      gl.uniform1f(this.u.u_exposure, c.exposure);
      gl.uniform1f(this.u.u_contrast, c.contrast);
      gl.uniform1f(this.u.u_saturation, c.saturation);
      gl.uniform1f(this.u.u_temp, c.temp);
      gl.uniform1f(this.u.u_tint, c.tint);
      gl.uniform1f(this.u.u_gamma, c.gamma);
      gl.uniform1f(this.u.u_black, c.black);
      gl.uniform1i(this.u.u_zebra, zebra ? 1 : 0);
      gl.uniform1i(this.u.u_ck, key ? 1 : 0);
      const dz = s.kind === 'video' && this.deint.has(sourceId) && this.sourceSize(sourceId); // (native cameras arrive deinterlaced already)
      if (dz) gl.uniform1f(this.u.u_deint, 1 / dz.h);
      if (key) { gl.uniform2f(this.u.u_ckC, key.cb, key.cr); gl.uniform3f(this.u.u_ckP, key.sim, key.smooth, key.spill); gl.uniform1i(this.u.u_matte, matte ? 1 : 0); }
      gl.uniform4fv(this.u.u_dst, rect);
      gl.uniform4fv(this.u.u_src, uv);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      if (key) { gl.uniform1i(this.u.u_ck, 0); gl.uniform1i(this.u.u_matte, 0); }
      if (dz) gl.uniform1f(this.u.u_deint, 0);
    }
    _drawShot(shot, opacity, smooth, zebra, matte) {
      const W = this.W, H = this.H;
      for (const L of this._layers(shot, smooth)) {
        if (matte && L.bg) { this._solid(L.rect, [0, 0, 0, 1], opacity); continue; } // the cut-out on black
        const r = L.rect;
        if (L.border) {
          const bx = 4 / W, by = 4 / H;
          this._solid([r[0] - bx, r[1] - by, r[2] + bx * 2, r[3] + by * 2], [1, 1, 1, 1], opacity);
        }
        const uv = this.uvFor(L.source, L.frame, (r[2] * W) / (r[3] * H));
        this._video(L.source, r, uv, opacity, zebra && !L.bg, L.key, matte);
      }
    }
    _drawLabels(now, dt) {
      const gl = this.gl;
      for (const L of this.labels.values()) {
        const d = L.data || {};
        const out = L.target < L.alpha;
        const ms = labelAnimMs(d, out);
        const step = ms > 0 ? dt / ms : 1;
        if (L.alpha < L.target) L.alpha = Math.min(L.target, L.alpha + step);
        else if (L.alpha > L.target) L.alpha = Math.max(L.target, L.alpha - step);
        if (L.alpha <= 0) { L.shown = null; continue; }
        if (L.canvas.width !== this.W || L.canvas.height !== this.H) { L.canvas.width = this.W; L.canvas.height = this.H; L.dirty = true; }
        // while coming in or going out the label is redrawn every frame at its point in the animation
        const state = L.alpha >= 1 ? 'full' : (out ? 'o' : 'i') + L.alpha.toFixed(4);
        if (L.dirty || L.shown !== state) {
          drawLabel(L.ctx, this.W, this.H, d, L.alpha, out);
          gl.bindTexture(gl.TEXTURE_2D, L.tex);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, L.canvas);
          L.dirty = false; L.shown = state;
        }
        gl.bindTexture(gl.TEXTURE_2D, L.tex);
        gl.uniform1i(this.u.u_mode, 1);
        gl.uniform1i(this.u.u_keyOn, 0);
        gl.uniform1f(this.u.u_opacity, 1);
        gl.uniform4fv(this.u.u_dst, [0, 0, 1, 1]);
        gl.uniform4fv(this.u.u_src, [0, 0, 1, 1]);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      }
    }
    _viewport(w, h) {
      const gl = this.gl;
      gl.viewport(0, 0, w, h);
      gl.scissor(0, 0, w, h);
      gl.enable(gl.SCISSOR_TEST);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    _copyTo(ctx, w, h) {
      if (!ctx) return;
      ctx.drawImage(this.canvas, 0, this.H - h, w, h, 0, 0, ctx.canvas.width, ctx.canvas.height);
    }

    _render(now) {
      const t0 = performance.now();
      // frame counter: every output frame is counted; a gap longer than one frame time means frames were missed
      this.stats.frames++;
      const dt = this.lastFrameAt ? Math.min(200, now - this.lastFrameAt) : 1000 / this.fps;
      this.lastFrameAt = now;
      this.frameNo++;
      const shot = id => (id ? this.getShot(id) : null);

      // which sources are needed this frame
      const need = new Set();
      const addShot = s => { if (!s) return; for (const L of this._layers(s, false)) need.add(L.source); };
      addShot(shot(this.programId));
      if (this.trans) { addShot(shot(this.trans.from)); addShot(shot(this.trans.to)); }
      addShot(shot(this.previewId));
      for (const [id, w] of this.webs) if (w.alpha > 0 || w.target > 0) need.add(w.data.src || id);
      if (this.previewCue && this.previewCue.webId) { const w = this.webs.get(this.previewCue.webId); if (w) need.add(w.data.src || this.previewCue.webId); }
      // thumbnails + small source views are refreshed a couple at a time, in turn, so no frame has to do them all
      // Each one is refreshed about 3 times a second (still pictures every few seconds), only while it is on screen,
      // and at most 2 in a frame, so they never compete with the program.
      for (const id of need) this._used.set(id, now);
      const views = [];
      for (const [id, cnv] of this.thumbs) if (this._onScreen(cnv)) views.push(['shot', id, cnv]);
      for (const [cnv, sid] of this.sourceViews) if (this._onScreen(cnv)) views.push(['src', sid, cnv]);
      for (const [cnv, lv] of this.layerViews) if (this._onScreen(cnv)) views.push(['part', lv, cnv]);
      this._thumbAcc = Math.min(2, (this._thumbAcc || 0) + views.length * (1000 / this.fps) / this.thumbEvery);
      const due = [];
      for (let k = 0, tries = 0; views.length && this._thumbAcc >= 1 && tries < views.length; tries++) {
        const v = views[(this._thumbIdx = ((this._thumbIdx || 0) + 1) % views.length)];
        if (v[0] === 'shot' && this._thumbStill(v[1], v[2], now)) continue; // unchanged still picture: skip it
        due.push(v); this._thumbAcc -= 1; if (++k >= 2) break;
      }
      for (const [kind, id, cnv] of due) { if (kind === 'shot') addShot(shot(id)); else if (kind === 'part') addShot(shot(id.shot)); else need.add(id); }
      for (const id of need) this._upload(id);
      // thumbnails + source views (small, rendered into a corner then copied) — only the few due this frame
      if (due.length) {
        const tw = 320, th = 180;
        for (const [kind, id, cnv] of due) {
          this._viewport(tw, th);
          if (kind === 'shot') { const s = shot(id); if (s) this._drawShot(s, 1, false, false); }
          else if (kind === 'part') {
            const s = shot(id.shot);
            if (s && id.part === 'main') this._drawShot(Object.assign({}, s, { pip: null }), 1, false, false);
            else if (s && s.pip && s.pip.source) { const r = pipRect(s.pip, this.W, this.H); this._video(s.pip.source, [0, 0, 1, 1], this.uvFor(s.pip.source, s.pip.frame, (r[2] * this.W) / (r[3] * this.H)), 1, false); }
          }
          else {
            const sz = this.sourceSize(id);
            if (sz) {
              const sa = sz.w / sz.h, da = 16 / 9;
              let r = [0, 0, 1, 1];
              if (sa > da) { const h = da / sa; r = [0, (1 - h) / 2, 1, h]; }
              else { const w = sa / da; r = [(1 - w) / 2, 0, w, 1]; }
              this._video(id, r, [0, 0, 1, 1], 1, false);
            }
          }
          this._copyTo(cnv.getContext('2d'), tw, th);
          cnv._at = now;
        }
      }
      for (const cnv of this.sourceViews.keys()) if (!cnv.isConnected) { this.sourceViews.delete(cnv); this._unwatch(cnv); }
      for (const cnv of this.layerViews.keys()) if (!cnv.isConnected) { this.layerViews.delete(cnv); this._unwatch(cnv); }

      // preview monitor
      if (this.previewCtx) {
        const pw = Math.max(320, Math.min(this.W, this.previewCtx.canvas.width)), ph = Math.round(pw * this.H / this.W); // drawn at the exact size it is shown, so it stays sharp
        this._viewport(pw, ph);
        // with a caption cued, Preview shows the LIVE shot plus the caption: exactly what viewers will get
        const cued = (this.previewLabel && this.previewLabel.data) || this.previewCue;
        const psId = cued ? (this.trans ? this.trans.to : this.programId) : this.previewId;
        const ps = shot(psId);
        const PL = this.previewLabel;
        const cw0 = this.previewCue && this.previewCue.webId && this.webs.get(this.previewCue.webId);
        // a still picture (holding slide, logo, colour bars…) is not redrawn 60 times a second: only when it changes
        const pvKey = !ps || cw0 || (PL && PL.data && PL.dirty) || !this._still(ps) ? null
          : [psId, cued ? 1 : 0, pw, this.zebra ? 1 : 0, PL && PL.data ? JSON.stringify(PL.data) : '', ...this._layers(ps, false).map(L => { const so = this.sources.get(L.source); return so ? so.ver || 0 : -1; }), JSON.stringify(ps.main), JSON.stringify(ps.pip || null), JSON.stringify(ps.green || null), this.matteId === psId ? 1 : 0].join('|');
        if (pvKey && pvKey === this._pvKey && now - this._pvAt < 2000) { /* unchanged */ } else {
        this._pvKey = pvKey; this._pvAt = now; this.stats.pvDraws = (this.stats.pvDraws || 0) + 1;
        if (ps) this._drawShot(ps, 1, true, this.zebra, !!this.matteId && this.matteId === psId);
        if (PL && PL.data) { // a caption that is cued up (not on air yet) is shown on the Preview only
          const gl = this.gl;
          if (PL.dirty) { drawLabel(PL.ctx, this.W, this.H, PL.data); gl.bindTexture(gl.TEXTURE_2D, PL.tex); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, PL.canvas); PL.dirty = false; }
          gl.bindTexture(gl.TEXTURE_2D, PL.tex);
          gl.uniform1i(this.u.u_mode, 1); gl.uniform1i(this.u.u_keyOn, 0); gl.uniform1f(this.u.u_opacity, 1);
          gl.uniform4fv(this.u.u_dst, [0, 0, 1, 1]); gl.uniform4fv(this.u.u_src, [0, 0, 1, 1]);
          gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        }
        const cw = this.previewCue && this.previewCue.webId && this.webs.get(this.previewCue.webId);
        if (cw) this._drawWebLayer(cw, this.previewCue.webId, 1);
        this._copyTo(this.previewCtx, pw, ph);
        }
      }

      // program (full resolution) — drawn last so it is what the canvas shows and streams
      this._viewport(this.W, this.H);
      if (this.trans) {
        const p = (now - this.trans.start) / this.trans.dur;
        if (p >= 1) {
          const from = this.trans.from;
          this.programId = this.trans.to;
          this.trans = null;
          this._drawShot(shot(this.programId), 1, true, false);
          if (this.onTransitionEnd) this.onTransitionEnd(this.programId, from);
        } else {
          this._drawShot(shot(this.trans.from), 1, true, false);
          this._drawShot(shot(this.trans.to), ease(p), true, false);
        }
      } else {
        this._drawShot(shot(this.programId), 1, true, false);
      }
      this._drawWebs(dt);
      this._drawLabels(now, dt);
      const b = this.black;
      const bp = clamp((now - b.start) / b.dur, 0, 1);
      b.v = b.from + (b.to - b.from) * bp;
      if (b.v > 0.001) this._solid([0, 0, 1, 1], [0, 0, 0, 1], b.v);
      if (this._capTrack && this._capTrack.readyState === 'live' && this._capTrack.requestFrame) this._capTrack.requestFrame();
      // did the camera on air move on by exactly one frame? (0 = the same picture twice, 2+ = camera frames skipped)
      const cs = this._clockSrc();
      if (cs && cs.sync) {
        if (cs.upFrame === this.frameNo && cs._shownFrame === this.frameNo - 1) {
          if (!cs.popped) this.stats.camRepeat = (this.stats.camRepeat || 0) + 1;
          if (cs.dropNow) this.stats.camSkip = (this.stats.camSkip || 0) + cs.dropNow;
        }
        cs._shownFrame = this.frameNo;
      } else if (cs) {
        const n = (cs.count || 0) - (cs._shown || 0);
        if (cs._shownFrame === this.frameNo - 1) {
          if (n === 0) this.stats.camRepeat = (this.stats.camRepeat || 0) + 1;
          else if (n > 1) this.stats.camSkip = (this.stats.camSkip || 0) + (n - 1);
        }
        cs._shown = cs.count || 0; cs._shownFrame = this.frameNo;
      }

      if (this.onFrame) { try { this.onFrame(now); } catch (e) { console.warn(e); } }
      this.stats.renderMs = performance.now() - t0;
      this._fpsCount++;
      if (now - this._fpsAt >= 1000) { this.stats.fps = Math.round(this._fpsCount * 1000 / (now - this._fpsAt)); this._fpsCount = 0; this._fpsAt = now; }
    }

    // the live camera on air (the one the program follows), or null
    _clockSrc() {
      const id = this.trans ? this.trans.to : this.programId;
      const sh = id ? this.getShot(id) : null;
      if (!sh) return null;
      for (const L of this._layers(sh, false).sort((a, b) => (a.bg ? 1 : 0) - (b.bg ? 1 : 0))) {
        const so = this.sources.get(L.source);
        if (so && so.kind === 'video' && so.el && so.el.srcObject && so.rvfc) return so;
      }
      return null;
    }
    // locked when that camera delivers frames at the program's rate (59.94 → 59.94) and is running normally
    _lockSrc(now, interval) {
      const cs = this._clockSrc();
      if (!cs || cs.sync || !cs.iv || !cs.ready || now - (cs.lastFresh || 0) > interval * 3) return null;
      return Math.abs(cs.iv - interval) / interval < 0.03 ? cs : null;
    }
    _onScreen(cnv) {
      if (!cnv.isConnected) { this._unwatch(cnv); return false; }
      if (!this._io) {
        this._vis = new WeakMap();
        this._io = new IntersectionObserver(es => { for (const e of es) this._vis.set(e.target, e.isIntersecting); });
      }
      const v = this._vis.get(cnv);
      if (v === undefined) { this._vis.set(cnv, true); this._io.observe(cnv); return true; }
      return v;
    }
    _unwatch(cnv) { if (this._io && this._vis.has(cnv)) { this._io.unobserve(cnv); this._vis.delete(cnv); } }
    // a shot made only of still pictures, not moving to a new framing
    _still(sh) {
      for (const L of this._layers(sh, false)) {
        const so = this.sources.get(L.source);
        if (!so || so.kind !== 'image' || so.dirty) return false;
      }
      for (const k of [':m', ':p']) { const c = this.frames.get(sh.id + k); if (c && c.seen >= this.frameNo - 1) { const t = k === ':m' ? sh.main.frame : sh.pip && sh.pip.frame; if (t && (Math.abs(c.x - t.x) > 1e-4 || Math.abs(c.y - t.y) > 1e-4 || Math.abs(c.zoom - t.zoom) > 1e-4)) return false; } }
      return true;
    }
    _thumbStill(id, cnv, now) {
      const sh = this.getShot(id);
      if (!sh || !this._still(sh)) { cnv._key = null; return false; }
      const key = JSON.stringify(sh.main) + JSON.stringify(sh.pip || null) + JSON.stringify(sh.green || null) + this._layers(sh, false).map(L => (this.sources.get(L.source) || {}).ver || 0).join(',');
      if (cnv._key === key && now - (cnv._at || 0) < 5000) return true;
      cnv._key = key; return false;
    }
    // was this source drawn on the program / Preview in the last `ms` milliseconds?
    usedRecently(id, ms = 1500) { return performance.now() - (this._used.get(id) || -1e9) < ms; }
    // live inputs: frame rate, late frames, longest gap
    cameraStats(resetWin) {
      const out = [];
      for (const [id, so] of this.sources) if (so.kind === 'video' && so.el && so.el.srcObject) {
        const now = performance.now(); if (so.gapLog) while (so.gapLog.length && now - so.gapLog[0] > 60000) so.gapLog.shift();
        out.push({ id, fps: so.iv ? 1000 / so.iv : 0, late: so.late || 0, lastMin: so.gapLog ? so.gapLog.length : 0, worst: so.worstGap || 0, alive: now - (so.lastFresh || 0) < 1000, sync: !!so.sync, queue: so.q ? so.q.length : 0, win: so.win || 0 });
        if (resetWin) so.win = 0;
      }
      return out;
    }
    _tick(fromTimer) {
      const now = performance.now();
      const interval = 1000 / this.fps;
      // the timer is only a backup for when the window is minimised / covered and the screen refresh stops
      if (fromTimer && now - (this._lastRaf || 0) < interval * 2.5) return;
      // Locked to the camera: a program frame is made for every new camera frame — never the same camera picture
      // twice and never one skipped, even though the screen refreshes at 60.00 and the camera runs at 59.94.
      // If the camera is ever late, a frame is still made on time so the stream never stalls.
      const lock = this.cameraLock && !fromTimer ? this._lockSrc(now, interval) : null;
      this.stats.locked = !!lock;
      if (lock) {
        const since = now - (this.lastFrameAt || 0);
        if (!(lock.fresh && since > interval * 0.5) && !(since > interval * 1.6)) return;
        if (since > interval * 2.5) { const late = Math.round(since / interval) - 1; this.stats.missed += late; const L = this.stats.recent || (this.stats.recent = []); L.push([now, late]); while (L.length && now - L[0][0] > 60000) L.shift(); this.stats.worst = Math.max(this.stats.worst || 0, since - interval); }
        this._next = now + interval;
        this._render(now);
        return;
      }
      // render on the refresh nearest to each frame's slot (half a frame early is fine): no skipped refreshes,
      // so every refresh carries a new frame and the encoder gets an even 60 a second
      if (this._next && now < this._next - interval * 0.5) return;
      // frame counter: a frame is "missed" only when it comes out a whole frame (or more) behind schedule.
      // A frame that is a few ms late still goes out in its own slot and is not a drop.
      if (this._next) {
        const late = Math.floor((now - this._next) / interval);
        if (late >= 1) { this.stats.missed += late; const L = this.stats.recent || (this.stats.recent = []); L.push([now, late]); while (L.length && now - L[0][0] > 60000) L.shift(); this.stats.worst = Math.max(this.stats.worst || 0, now - this._next); }
      }
      this._next = (!this._next || now - this._next > interval) ? now + interval : this._next + interval;
      this._render(now);
    }
    start() {
      if (this.running) return;
      this.running = true;
      const raf = () => { if (!this.running) return; requestAnimationFrame(raf); this._lastRaf = performance.now(); this._tick(false); };
      requestAnimationFrame(raf);
      // keeps rendering when the window is minimised or covered
      this._timer = setInterval(() => this._tick(true), Math.max(4, 1000 / this.fps / 2));
    }
    stop() { this.running = false; clearInterval(this._timer); }
    setFps(fps) {
      this.fps = fps; this.lastFrameAt = 0; this._next = 0; // changing the rate is not a dropped frame
      clearInterval(this._timer);
      if (this.running) this._timer = setInterval(() => this._tick(true), Math.max(4, 1000 / fps / 2));
      this._stream = null;
    }
    setSize(w, h) {
      if (w === this.W && h === this.H) return;
      this.W = w; this.H = h;
      this.canvas.width = w; this.canvas.height = h;
      for (const L of this.labels.values()) { L.canvas.width = w; L.canvas.height = h; L.dirty = true; }
      this._stream = null;
    }
    videoTrack() {
      // captured on request: the engine hands over each finished program frame itself (see the end of _render),
      // so the encoder gets exactly the frames drawn — none skipped by a separate capture timer
      if (!this._stream || this._stream.getVideoTracks()[0].readyState !== 'live') { this._stream = this.canvas.captureStream(0); this._capTrack = this._stream.getVideoTracks()[0]; }
      return this._stream.getVideoTracks()[0];
    }
  }

  /* ---------- label designs ----------
   * A label's look is a "design". Presets are starting points; every value can be changed in the designer.
   * A label is built from parts (boxes, accent bars, text lines); the entrance animation moves, clips or
   * fades each part, so a design can build itself up (bar first, then the name, then the second line). */
  const LBL_BASE = {
    font: 'Segoe UI', size: 1, bold: true, italic: false, upper: false, subUpper: false, subSpacing: 0, subSize: 1, subAccent: false,
    textColor: '#ffffff', subColor: '#ffffff', bgColor: '#0a0c12', bgOpacity: 0.88, bar: 'left', barWidth: 12, radius: 0,
    position: 'bl', margin: 0.095, shadow: false, anim: 'slide', animOut: 'reverse', fadeMs: 300,
    layout: 'stack', subBox: 'auto', skew: 0, fadeEdge: false, accentTitle: false
  };
  const LABEL_PRESETS = {
    'lower':       { font: 'Segoe UI', size: 1, bold: true, upper: false, textColor: '#ffffff', subColor: '#ffffff', bgColor: '#0a0c12', bgOpacity: 0.88, bar: 'left', radius: 0, position: 'bl', margin: 0.095, shadow: false, anim: 'slide', fadeMs: 300 },
    'lower-light': { font: 'Segoe UI', size: 1, bold: true, upper: false, textColor: '#0b1220', subColor: '#ffffff', bgColor: '#ffffff', bgOpacity: 0.96, bar: 'left', radius: 0, position: 'bl', margin: 0.095, shadow: false, anim: 'slide', fadeMs: 300 },
    'modern':      { layout: 'panel', bgColor: '#0b1020', bgOpacity: 0.85, fadeEdge: true, bar: 'top', barWidth: 8, subUpper: true, subSpacing: 3, subSize: 0.82, subAccent: true, position: 'bl', margin: 0.085, anim: 'wipe', fadeMs: 400 },
    'news':        { layout: 'stack', accentTitle: true, subBox: 'box', bgColor: '#0a0c12', bgOpacity: 0.94, bar: 'none', subUpper: true, subSpacing: 2, subSize: 0.88, position: 'bl', margin: 0.09, anim: 'build', fadeMs: 300 },
    'sport':       { font: 'Bahnschrift', upper: true, skew: 12, bgColor: '#111318', bgOpacity: 0.95, bar: 'left', barWidth: 16, subBox: 'accent', subSpacing: 1, position: 'bl', margin: 0.09, anim: 'stagger', fadeMs: 350 },
    'minimal':     { bgOpacity: 0, bar: 'left', barWidth: 5, shadow: true, subColor: '#e5e7eb', position: 'bl', margin: 0.09, anim: 'rise', fadeMs: 400 },
    'tag':         { layout: 'tag', bgColor: '#0a0c12', bgOpacity: 0.86, radius: 6, bar: 'none', subUpper: true, subSpacing: 2, subSize: 0.8, position: 'bl', margin: 0.09, anim: 'slide', fadeMs: 300 },
    'elegant':     { layout: 'band', font: 'Georgia', bold: false, bgColor: '#000000', bgOpacity: 0.62, bar: 'under', barWidth: 4, shadow: true, subColor: '#e5e7eb', position: 'bc', margin: 0.05, anim: 'blur', fadeMs: 700 },
    'pill':        { layout: 'split', bgColor: '#ffffff', bgOpacity: 0.96, textColor: '#0b1220', subColor: '#475569', radius: 60, bar: 'left', size: 0.9, position: 'bl', margin: 0.09, anim: 'pop', fadeMs: 350 },
    'title':       { font: 'Segoe UI', size: 1.75, bold: true, upper: false, textColor: '#ffffff', subColor: '#e5e7eb', bgColor: '#000000', bgOpacity: 0, bar: 'under', radius: 0, position: 'mc', margin: 0.095, shadow: true, anim: 'fade', fadeMs: 600 },
    'corner':      { font: 'Segoe UI', size: 0.65, bold: true, upper: false, textColor: '#ffffff', subColor: '#ffffff', bgColor: '#0a0c12', bgOpacity: 0.85, bar: 'none', radius: 8, position: 'tr', margin: 0.05, shadow: false, anim: 'fade', fadeMs: 300, accentTitle: true }
  };
  const LABEL_STYLES = [['lower', 'Classic dark'], ['lower-light', 'Classic light'], ['modern', 'Modern glass'], ['news', 'News two-tier'], ['sport', 'Slanted'], ['minimal', 'Minimal line'],
    ['tag', 'Tag on top'], ['elegant', 'Elegant band'], ['pill', 'Pill'], ['title', 'Big centre title'], ['corner', 'Corner tag']];
  const LABEL_ANIMS = [
    ['fade', 'Fade', 'Simply fades in'], ['slide', 'Slide + fade', 'Slides in a little from the side while fading'],
    ['wipe', 'Wipe', 'Revealed from the side like a curtain'], ['build', 'Build up', 'Accent bar first, then the name, then the second line'],
    ['rise', 'Rise from a line', 'Each line rises up out of an invisible line'], ['stagger', 'Line by line', 'The name slides in, then the second line follows'],
    ['pop', 'Pop', 'Zooms in with a small bounce'], ['blur', 'Soft focus', 'Comes into focus from a blur'], ['type', 'Typewriter', 'Typed out letter by letter']];
  const ANIM_SPEED = { fade: 1, slide: 1, wipe: 1.3, build: 2, rise: 1.6, stagger: 1.7, pop: 1.2, blur: 1.4, type: 1 };
  function labelDesign(d) {
    return Object.assign({}, LBL_BASE, LABEL_PRESETS[d.style] || LABEL_PRESETS.lower, d.design || {});
  }
  // how long a label takes to come in / go out (the "speed" setting, stretched for the animations that build in steps)
  function labelAnimMs(d, out) {
    const D = labelDesign(d || {}), base = +D.fadeMs || 0, a = D.anim || 'fade';
    if (!base) return 0;
    if (out) return D.animOut === 'fade' || a === 'type' ? base : Math.round(base * Math.min(1.4, ANIM_SPEED[a] || 1));
    if (a === 'type') return Math.round(Math.max(base * 2, Math.min(3500, 300 + 40 * (String(d.title || '').length + String(d.subtitle || '').length))));
    return Math.round(base * (ANIM_SPEED[a] || 1));
  }
  function rgba(hex, a) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
    const n = m ? parseInt(m[1], 16) : 0;
    return `rgba(${n >> 16 & 255},${n >> 8 & 255},${n & 255},${a})`;
  }

  /* where every part of a label sits (in pixels of a W x H frame) */
  function labelLayout(ctx, W, H, d) {
    const D = labelDesign(d), k = H / 1080, z = D.size;
    const accent = d.color || '#2563eb';
    const title = D.upper ? String(d.title || '').toUpperCase() : String(d.title || '');
    const subRaw = String(d.subtitle || '');
    const sub = D.upper || D.subUpper ? subRaw.toUpperCase() : subRaw;
    if (!title && !sub) return null;
    const fam = `"${D.font}", "Segoe UI", system-ui, sans-serif`, it = D.italic ? 'italic ' : '';
    const tPx = 54 * k * z, sPx = 32 * k * z * D.subSize;
    const tFont = `${it}${D.bold ? 700 : 400} ${tPx}px ${fam}`, sFont = `${it}${D.bold ? 500 : 400} ${sPx}px ${fam}`;
    const sSp = D.subSpacing * k * z;
    const measure = (str, f, sp) => { if (!str) return 0; ctx.font = f; ctx.letterSpacing = `${sp}px`; const w = ctx.measureText(str).width; ctx.letterSpacing = '0px'; return w; };
    const tW = measure(title, tFont, 0), sW = measure(sub, sFont, sSp);
    const boxed = D.bgOpacity > 0.01, boxFill = rgba(D.bgColor, D.bgOpacity);
    const align = D.position[1] === 'c' ? 'c' : D.position[1], v = D.position[0];
    const thick = D.barWidth * k * z, line = Math.max(2 * k, thick * 0.45);
    const mx = D.margin * W * 0.53, my = D.margin * H;
    const subColor = D.subAccent ? accent : D.subColor;
    const parts = [], add = P => { parts.push(P); return P; };
    const text = (row, str, font, px, sp, color, left, y, w) => add({ t: 'text', row, str, font, px, sp, color, left, y, w, shadow: D.shadow });
    let BW = 0, BH = 0, full = false;
    const layout = D.layout || 'stack';

    if (layout === 'panel') {
      const padX = 36 * k * z, padT = 20 * k * z, padB = 22 * k * z, th = 66 * k * z, sh = sub ? 46 * k * z * D.subSize : 0, gp = sub ? 2 * k * z : 0;
      const barW = D.bar === 'left' ? thick : 0, topH = D.bar === 'top' ? line : 0, underH = D.bar === 'under' ? 26 * k * z : 0;
      const PW = Math.max(tW, sW) + padX * 2 + barW, PH = topH + padT + th + gp + sh + padB;
      const ext = D.fadeEdge && boxed ? PW * 0.5 : 0;
      BW = PW + ext; BH = PH + underH;
      const px = align === 'r' ? ext : align === 'c' ? ext / 2 : 0;
      if (boxed) add({ t: 'box', row: -1, x: 0, y: 0, w: BW, h: PH, fill: boxFill, fade: ext ? { side: align, solid: PW / BW } : null });
      if (barW) add({ t: 'bar', row: -1, axis: 'v', x: align === 'r' ? px + PW - barW : px, y: 0, w: barW, h: PH, fill: accent, r: 0 });
      if (topH) add({ t: 'bar', row: -1, axis: 'h', x: px, y: 0, w: PW, h: topH, fill: accent, r: 0 });
      const cx0 = px + (align === 'r' ? 0 : barW) + padX, cw = PW - barW - padX * 2;
      const lx = w => align === 'l' ? cx0 : align === 'r' ? cx0 + cw - w : cx0 + (cw - w) / 2;
      text(0, title, tFont, tPx, 0, D.textColor, lx(tW), topH + padT + th / 2 + 2 * k, tW);
      if (sub) text(1, sub, sFont, sPx, sSp, subColor, lx(sW), topH + padT + th + gp + sh / 2, sW);
      if (underH) { const uw = 160 * k * z; add({ t: 'bar', row: -1, axis: 'h', x: align === 'l' ? px : align === 'r' ? px + PW - uw : px + (PW - uw) / 2, y: PH + 12 * k * z, w: uw, h: 8 * k * z, fill: accent }); }
    } else if (layout === 'tag') {
      const tagPad = 16 * k * z, tagH = sub ? 44 * k * z * D.subSize : 0, gap = sub ? 10 * k * z : 0, tagW = sub ? sW + tagPad * 2 : 0;
      const padX = (boxed ? 30 : 0) * k * z, th = (boxed ? 86 : 70) * k * z, tw = tW + padX * 2;
      const barW = D.bar === 'left' && align !== 'c' ? thick : 0, bgap = barW && !boxed ? 20 * k * z : 0, underH = D.bar === 'under' ? 26 * k * z : 0;
      BW = Math.max(tagW, tw + barW + bgap); BH = tagH + gap + th + underH;
      const ax = w => align === 'l' ? 0 : align === 'r' ? BW - w : (BW - w) / 2;
      if (sub) { const x = ax(tagW); add({ t: 'box', row: 0, x, y: 0, w: tagW, h: tagH, fill: accent, r: Math.max(D.radius, 4) * k }); text(0, sub, sFont, sPx, sSp, D.subColor, x + tagPad, tagH / 2 + 1, sW); }
      const ty = tagH + gap, tx = ax(tw + barW + bgap), boxX = align === 'r' ? tx : tx + barW + bgap;
      if (barW) add({ t: 'bar', row: -1, axis: 'v', x: align === 'r' ? tx + tw + bgap : tx, y: ty, w: barW, h: th, fill: accent });
      if (boxed) add({ t: 'box', row: 1, x: boxX, y: ty, w: tw, h: th, fill: D.accentTitle ? accent : boxFill });
      text(1, title, tFont, tPx, 0, D.textColor, boxX + padX, ty + th / 2 + 2 * k, tW);
      if (underH) { const uw = 160 * k * z; add({ t: 'bar', row: -1, axis: 'h', x: align === 'l' ? 0 : align === 'r' ? BW - uw : (BW - uw) / 2, y: ty + th + 14 * k * z, w: uw, h: 8 * k * z, fill: accent }); }
    } else if (layout === 'split') {
      const h = 84 * k * z, padX = 32 * k * z, gap = 22 * k * z, dv = sub ? 3 * k * z : 0;
      const dot = D.bar === 'left' ? h * 0.34 : 0, dotGap = dot ? 16 * k * z : 0, underH = D.bar === 'under' ? 26 * k * z : 0;
      BW = padX + dot + dotGap + tW + (sub ? gap * 2 + dv + sW : 0) + padX; BH = h + underH;
      if (boxed) add({ t: 'box', row: -1, x: 0, y: 0, w: BW, h, fill: boxFill });
      if (dot) add({ t: 'bar', row: -1, axis: 'c', x: padX, y: (h - dot) / 2, w: dot, h: dot, fill: accent, r: dot });
      const x = padX + dot + dotGap;
      text(0, title, tFont, tPx, 0, D.textColor, x, h / 2 + 2 * k, tW);
      if (sub) { add({ t: 'bar', row: 1, axis: 'v', x: x + tW + gap, y: h * 0.26, w: dv, h: h * 0.48, fill: accent, r: 0 }); text(1, sub, sFont, sPx, sSp, subColor, x + tW + gap * 2 + dv, h / 2 + 1, sW); }
      if (D.bar === 'top') add({ t: 'bar', row: -1, axis: 'h', x: BW * 0.1, y: 0, w: BW * 0.8, h: line, fill: accent, r: 0 });
      if (underH) { const uw = 160 * k * z; add({ t: 'bar', row: -1, axis: 'h', x: align === 'l' ? 0 : align === 'r' ? BW - uw : (BW - uw) / 2, y: h + 14 * k * z, w: uw, h: 8 * k * z, fill: accent }); }
    } else if (layout === 'band') {
      full = true;
      const padV = 24 * k * z, th = 70 * k * z, sh = sub ? 46 * k * z * D.subSize : 0, underH = D.bar === 'under' ? 24 * k * z : 0;
      BW = W; BH = padV * 2 + th + sh + underH;
      const m = Math.max(mx, 60 * k), lx = w => align === 'l' ? m : align === 'r' ? W - m - w : (W - w) / 2;
      if (boxed) add({ t: 'box', row: -1, x: 0, y: 0, w: W, h: BH, fill: boxFill, r: 0, fade: { side: 'band-' + align } });
      if (D.bar === 'top') add({ t: 'bar', row: -1, axis: 'h', x: 0, y: 0, w: W, h: line, fill: accent, r: 0 });
      if (D.bar === 'left' && align !== 'c') add({ t: 'bar', row: -1, axis: 'v', x: align === 'l' ? m - 24 * k * z - thick : W - m + 24 * k * z, y: padV, w: thick, h: th + sh, fill: accent });
      text(0, title, tFont, tPx, 0, D.textColor, lx(tW), padV + th / 2 + 2 * k, tW);
      if (sub) text(1, sub, sFont, sPx, sSp, subColor, lx(sW), padV + th + sh / 2, sW);
      if (underH) { const uw = 120 * k * z, uh = Math.max(2 * k, Math.min(thick, 8 * k * z)); add({ t: 'bar', row: -1, axis: 'h', x: align === 'l' ? m : align === 'r' ? W - m - uw : (W - uw) / 2, y: padV + th + sh + 8 * k * z, w: uw, h: uh, fill: accent, r: 0 }); }
    } else { // 'stack': one box per line, sized to its text
      const padX = (boxed ? 34 : 0) * k * z, th = (boxed ? 92 : 70) * k * z, sh = sub ? (boxed ? 56 : 46) * k * z * D.subSize : 0;
      const tw = tW + padX * 2, sw = sub ? sW + padX * 2 : 0;
      const barW = D.bar === 'left' && align !== 'c' ? thick : 0, gap = barW && !boxed ? 20 * k * z : 0;
      const topH = D.bar === 'top' ? line : 0, underH = D.bar === 'under' ? 26 * k * z : 0;
      BW = Math.max(tw, sw) + barW + gap; BH = topH + th + sh + underH;
      const bx = w => align === 'l' ? barW + gap : align === 'r' ? BW - barW - gap - w : (BW - w) / 2;
      const sMode = D.subBox === 'auto' ? (D.accentTitle ? 'box' : 'accent') : D.subBox;
      const sFill = sMode === 'none' ? null : sMode === 'box' ? boxFill : accent;
      if (barW) add({ t: 'bar', row: -1, axis: 'v', x: align === 'l' ? 0 : BW - barW, y: topH, w: barW, h: th + sh, fill: accent });
      if (topH) add({ t: 'bar', row: -1, axis: 'h', x: bx(tw), y: 0, w: tw, h: topH, fill: accent, r: 0 });
      if (boxed) {
        add({ t: 'box', row: 0, x: bx(tw), y: topH, w: tw, h: th, fill: D.accentTitle ? accent : boxFill });
        if (sub && sFill) add({ t: 'box', row: 1, x: bx(sw), y: topH + th, w: sw, h: sh, fill: sFill });
      }
      text(0, title, tFont, tPx, 0, D.textColor, bx(tw) + padX, topH + th / 2 + 2 * k, tW);
      if (sub) text(1, sub, sFont, sPx, sSp, subColor, bx(sw) + padX, topH + th + sh / 2 + 1, sW);
      if (underH) { const uw = 160 * k * z; add({ t: 'bar', row: -1, axis: 'h', x: align === 'l' ? 0 : align === 'r' ? BW - uw : (BW - uw) / 2, y: topH + th + sh + 14 * k * z, w: uw, h: 8 * k * z, fill: accent }); }
    }

    const x0 = full ? 0 : align === 'l' ? mx : align === 'r' ? W - mx - BW : (W - BW) / 2;
    const y0 = v === 't' ? my : v === 'b' ? H - my - BH : (H - BH) / 2;
    for (const P of parts) { if (P.t === 'text') { P.left += x0; P.y += y0; } else { P.x += x0; P.y += y0; } }
    // rows (one per line of text, in reading order) are what the step-by-step animations move one after another
    const raw = new Map();
    const grow = (r, x, y, w, h) => { const R = raw.get(r); if (!R) raw.set(r, { x, y, w, h }); else { const x2 = Math.max(R.x + R.w, x + w), y2 = Math.max(R.y + R.h, y + h); R.x = Math.min(R.x, x); R.y = Math.min(R.y, y); R.w = x2 - R.x; R.h = y2 - R.y; } };
    for (const P of parts) if (P.row >= 0) { if (P.t === 'text') { if (P.str) grow(P.row, P.left, P.y - P.px * 0.62, P.w, P.px * 1.24); } else grow(P.row, P.x, P.y, P.w, P.h); }
    const order = [...raw.entries()].sort((a, b) => a[1].y - b[1].y || a[1].x - b[1].x).map(e => e[0]);
    const pad = 40 * k, rows = order.map(r => { const R = raw.get(r); return { x: R.x - pad, y: R.y - 4 * k, w: R.w + pad * 2, h: R.h + 8 * k }; });
    for (const P of parts) if (P.row >= 0) P.row = Math.max(0, order.indexOf(P.row));
    return { D, parts, rows, W, H, k, z, accent, align, r: D.radius * k, lead: parts.some(P => P.row < 0),
      block: { x: x0 - pad, y: y0 - pad, w: BW + pad * 2, h: BH + pad * 2 }, cx: x0 + BW / 2, cy: y0 + BH / 2, base: y0 + BH };
  }

  const clamp01 = t => t < 0 ? 0 : t > 1 ? 1 : t;
  const seg = (p, a, b) => clamp01((p - a) / (b - a));
  const out3 = t => 1 - Math.pow(1 - t, 3);
  const inout = t => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  const back = t => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); };
  const wipeRect = (R, e, al) => { const w = R.w * e; return { x: al === 'r' ? R.x + R.w - w : al === 'c' ? R.x + (R.w - w) / 2 : R.x, y: R.y, w, h: R.h }; };
  const NOANIM = { a: 1, dx: 0, dy: 0, clip: null };

  // what one part looks like at progress p (0 = not there yet, 1 = fully in) for a given entrance animation
  function animState(style, P, L, p) {
    const st = { a: 1, dx: 0, dy: 0, clip: null };
    const r = P.row, R = r >= 0 ? (L.rows[r] || L.block) : L.block, al = L.align, n = Math.max(1, L.rows.length);
    const side = amt => { if (al === 'l') st.dx = -amt * L.W; else if (al === 'r') st.dx = amt * L.W; else st.dy = amt * L.H * 1.4; };
    switch (style) {
      case 'fade': st.a = inout(p); break;
      case 'slide': { const e = out3(p); st.a = e; side((1 - e) * 0.03); break; }
      case 'wipe': st.clip = wipeRect(L.block, inout(p), al); st.a = Math.min(1, p * 8); break;
      case 'build':
        if (P.t === 'bar') st.grow = out3(seg(p, 0, 0.35));
        else if (r < 0) st.clip = wipeRect(R, inout(seg(p, 0.12, 0.55)), al);
        else { const o = L.lead ? 0.25 : 0, w = L.lead ? 0.45 : 0.6, g = L.lead ? 0.17 : 0.3; // with no bar or panel to draw first, the lines start straight away
          st.clip = wipeRect(R, inout(seg(p, o + r * g, o + w + r * g)), al); if (P.t === 'text') st.a = seg(p, o + 0.1 + r * g, o + w + 0.13 + r * g); }
        break;
      case 'rise':
        if (P.t === 'bar') st.grow = out3(seg(p, 0, 0.5));
        else if (r < 0) { const e = out3(seg(p, 0, 0.5)); st.clip = { x: R.x, y: R.y + R.h * (1 - e), w: R.w, h: R.h * e }; }
        else { const e = out3(seg(p, 0.15 + r * 0.2, 0.75 + r * 0.2)); st.clip = R; st.dy = (1 - e) * R.h; }
        st.a = Math.min(1, p * 8);
        break;
      case 'stagger':
        if (r < 0) { st.a = seg(p, 0, 0.35); if (P.t === 'bar') st.grow = out3(seg(p, 0, 0.45)); }
        else { const e = out3(seg(p, r * 0.28, 0.72 + r * 0.28)); st.a = e; side((1 - e) * 0.05); }
        break;
      case 'type':
        if (P.t === 'text') { const a = 0.15 + r * 0.85 / n, t = seg(p, a, a + 0.85 / n); st.chars = Math.round(P.str.length * t); st.caret = t > 0 && t < 1; }
        else if (P.t === 'bar') st.grow = out3(seg(p, 0, 0.15));
        else st.clip = wipeRect(R, inout(seg(p, 0, 0.15)), al);
        break;
      default: break; // pop / blur act on the whole label
    }
    return st;
  }
  function fillFor(ctx, P) {
    if (!P.fade) return P.fill;
    const c0 = P.fill, cT = P.fill.replace(/[\d.]+\)$/, '0)'), s = P.fade.solid || 0.5, side = P.fade.side;
    const g = ctx.createLinearGradient(P.x, 0, P.x + P.w, 0);
    if (side === 'l') { g.addColorStop(0, c0); g.addColorStop(s * 0.9, c0); g.addColorStop(1, cT); }
    else if (side === 'r') { g.addColorStop(0, cT); g.addColorStop(1 - s * 0.9, c0); g.addColorStop(1, c0); }
    else if (side === 'band-l') { g.addColorStop(0, c0); g.addColorStop(0.5, c0); g.addColorStop(0.92, cT); g.addColorStop(1, cT); }
    else if (side === 'band-r') { g.addColorStop(0, cT); g.addColorStop(0.08, cT); g.addColorStop(0.5, c0); g.addColorStop(1, c0); }
    else if (side === 'band-c') { g.addColorStop(0, cT); g.addColorStop(0.24, c0); g.addColorStop(0.76, c0); g.addColorStop(1, cT); }
    else { const a = (1 - s) / 2; g.addColorStop(0, cT); g.addColorStop(a * 0.9, c0); g.addColorStop(1 - a * 0.9, c0); g.addColorStop(1, cT); }
    return g;
  }
  function paintPart(ctx, P, L, st) {
    if (P.t === 'text') {
      if (!P.str) return;
      const s = st.chars === undefined ? P.str : P.str.slice(0, st.chars);
      ctx.font = P.font; ctx.letterSpacing = `${P.sp}px`; ctx.fillStyle = P.color; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      if (P.shadow) { ctx.shadowColor = 'rgba(0,0,0,0.75)'; ctx.shadowBlur = 18 * L.k * L.z; ctx.shadowOffsetY = 2 * L.k; }
      if (s) ctx.fillText(s, P.left, P.y);
      ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
      if (st.caret) { const w = s ? ctx.measureText(s).width : 0; ctx.fillStyle = L.accent; ctx.fillRect(P.left + w + 3 * L.k, P.y - P.px * 0.42, Math.max(2, 4 * L.k * L.z), P.px * 0.84); }
      ctx.letterSpacing = '0px';
      return;
    }
    let { x, y, w, h } = P;
    if (st.grow !== undefined && st.grow < 1) {
      const g = st.grow;
      if (P.axis === 'v') { const nh = h * g; y += h - nh; h = nh; }
      else if (P.axis === 'c') { const nw = w * g, nh = h * g; x += (w - nw) / 2; y += (h - nh) / 2; w = nw; h = nh; }
      else { const nw = w * g; x = L.align === 'r' ? x + w - nw : L.align === 'c' ? x + (w - nw) / 2 : x; w = nw; }
      if (w <= 0.5 || h <= 0.5) return;
    }
    const r = Math.min(P.r ?? L.r, h / 2, w / 2);
    ctx.fillStyle = fillFor(ctx, P);
    if (r > 0.5) roundRect(ctx, x, y, w, h, r); else { ctx.beginPath(); ctx.rect(x, y, w, h); }
    ctx.fill();
  }
  /* draw a label; prog 0..1 is how far its entrance has got (or, with out = true, how much of it is left while leaving) */
  function drawLabel(ctx, W, H, d, prog = 1, out = false) {
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.filter = 'none'; ctx.letterSpacing = '0px';
    ctx.clearRect(0, 0, W, H);
    if (!d) return;
    const p = clamp01(prog);
    if (p <= 0) return;
    const L = labelLayout(ctx, W, H, d);
    if (!L) return;
    let style = L.D.anim || 'fade';
    if (out && (L.D.animOut === 'fade' || style === 'type')) style = 'fade';
    if (p >= 1) style = 'none';
    ctx.save();
    if (L.D.skew) { const t = Math.tan(L.D.skew * Math.PI / 180); ctx.setTransform(1, 0, -t, 1, t * L.base, 0); }
    let gA = 1;
    if (style === 'pop') { const s = 0.72 + 0.28 * back(p); ctx.translate(L.cx, L.cy); ctx.scale(s, s); ctx.translate(-L.cx, -L.cy); gA = seg(p, 0, 0.3); }
    else if (style === 'blur') { const e = out3(p), s = 1.05 - 0.05 * e; ctx.translate(L.cx, L.cy); ctx.scale(s, s); ctx.translate(-L.cx, -L.cy); ctx.filter = `blur(${((1 - e) * 14 * L.k).toFixed(2)}px)`; gA = e; }
    for (const P of L.parts) {
      const st = style === 'none' ? NOANIM : animState(style, P, L, p);
      const a = gA * st.a;
      if (a <= 0.003) continue;
      if (st.clip && (st.clip.w <= 0.5 || st.clip.h <= 0.5)) continue;
      ctx.save();
      if (st.clip) { ctx.beginPath(); ctx.rect(st.clip.x, st.clip.y, st.clip.w, st.clip.h); ctx.clip(); }
      if (st.dx || st.dy) ctx.translate(st.dx, st.dy);
      ctx.globalAlpha = a;
      paintPart(ctx, P, L, st);
      ctx.restore();
    }
    ctx.restore();
    ctx.filter = 'none'; ctx.globalAlpha = 1; ctx.letterSpacing = '0px';
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function makeBars(w = 1920, h = 1080) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const x = c.getContext('2d');
    const top = ['#c0c0c0', '#c0c000', '#00c0c0', '#00c000', '#c000c0', '#c00000', '#0000c0'];
    const bw = w / 7;
    top.forEach((col, i) => { x.fillStyle = col; x.fillRect(Math.round(i * bw), 0, Math.ceil(bw), h * 0.67); });
    const mid = ['#0000c0', '#131313', '#c000c0', '#131313', '#00c0c0', '#131313', '#c0c0c0'];
    mid.forEach((col, i) => { x.fillStyle = col; x.fillRect(Math.round(i * bw), h * 0.67, Math.ceil(bw), h * 0.08); });
    x.fillStyle = '#00214c'; x.fillRect(0, h * 0.75, bw * 1.25, h * 0.25);
    x.fillStyle = '#ffffff'; x.fillRect(bw * 1.25, h * 0.75, bw * 1.25, h * 0.25);
    x.fillStyle = '#32006a'; x.fillRect(bw * 2.5, h * 0.75, bw * 1.25, h * 0.25);
    x.fillStyle = '#131313'; x.fillRect(bw * 3.75, h * 0.75, bw * 3.25, h * 0.25);
    x.fillStyle = 'rgba(0,0,0,0.6)'; x.fillRect(w / 2 - 260, h * 0.33 - 50, 520, 100);
    x.fillStyle = '#fff'; x.font = '600 54px "Segoe UI", system-ui, sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillText('LIVE STUDIO', w / 2, h * 0.33);
    return c;
  }

  window.LiveEngine = { Engine, makeBars, keyCbCr, greenOf, GREEN_DEF, pipRect, NEUTRAL, LABEL_PRESETS, LABEL_STYLES, LABEL_ANIMS, labelDesign, labelAnimMs, drawLabel };
})();
