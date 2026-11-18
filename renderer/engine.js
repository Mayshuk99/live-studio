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
  void main() {
    if (u_mode == 2) { o = vec4(u_solid.rgb, u_solid.a * u_opacity); return; }
    vec4 t = texture(u_tex, v_uv);
    if (u_mode == 1) {
      float a = t.a;
      if (u_keyOn == 1) { float d = distance(t.rgb, u_keyColor); a *= smoothstep(u_keyTol, u_keyTol + 0.12, d); }
      o = vec4(t.rgb, a * u_opacity); return;
    }
    vec3 c = t.rgb;
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
    o = vec4(c, u_opacity);
  }`;

  const NEUTRAL = { exposure: 0, contrast: 1, saturation: 1, temp: 0, tint: 0, gamma: 1, black: 0 };
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
      this.previewCanvas = null;
      this.previewCtx = null;

      this.programId = null;
      this.previewId = null;
      this.trans = null;
      this.black = { v: 0, from: 0, to: 0, start: 0, dur: 1 };
      this.moveSpeed = 0.12;
      this.zebra = true;
      this.bypass = new Set();
      this.getShot = () => null;
      this.onTransitionEnd = null;

      this.frameNo = 0;
      this.lastFrameAt = 0;
      this.lastThumbAt = 0;
      this.thumbEvery = 250;
      this.stats = { fps: 0, renderMs: 0 };
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
        'u_temp', 'u_tint', 'u_gamma', 'u_black', 'u_zebra', 'u_keyOn', 'u_keyColor', 'u_keyTol'].forEach(n => { this.u[n] = gl.getUniformLocation(p, n); });
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
        const cb = () => { s.fresh = true; s.lastFresh = performance.now(); if (this.sources.get(id) === s && s.rvfc) el.requestVideoFrameCallback(cb); };
        el.requestVideoFrameCallback(cb);
        s.rvfc = true;
        s.lastFresh = performance.now();
        el.addEventListener('seeked', () => { s.fresh = true; });
        el.addEventListener('loadeddata', () => { s.fresh = true; });
      }
      this.sources.set(id, s);
      return s;
    }
    removeSource(id) {
      const s = this.sources.get(id);
      if (s) { this.gl.deleteTexture(s.tex); this.sources.delete(id); }
    }
    sourceSize(id) {
      const s = this.sources.get(id);
      if (!s) return null;
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
        s.uploaded = true; s.ready = true; s.fresh = false; s.dirty = false;
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
    labelVisible(id) { const L = this.labels.get(id); return !!(L && L.target > 0); }

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
        const s = this.sources.get(id);
        if (!s || !s.ready) continue;
        const d = w.data, r = d.rect || [0, 0, 1, 1];
        gl.bindTexture(gl.TEXTURE_2D, s.tex);
        gl.uniform1i(this.u.u_mode, 1);
        gl.uniform1f(this.u.u_opacity, ease(w.alpha) * (d.opacity ?? 1));
        const k = d.key || {};
        gl.uniform1i(this.u.u_keyOn, k.on ? 1 : 0);
        const hex = /^#?([0-9a-f]{6})$/i.exec(k.color || '#000000'), n = hex ? parseInt(hex[1], 16) : 0;
        gl.uniform3f(this.u.u_keyColor, (n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255);
        gl.uniform1f(this.u.u_keyTol, k.tol ?? 0.15);
        gl.uniform4fv(this.u.u_dst, r);
        gl.uniform4fv(this.u.u_src, [0, 0, 1, 1]);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        gl.uniform1i(this.u.u_keyOn, 0);
      }
    }

    _drawLabelCanvas(L) { drawLabel(L.ctx, this.W, this.H, L.data); }

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
      out.push({
        source: shot.main.source,
        frame: smooth ? this._smooth(shot.id + ':m', shot.main.frame) : shot.main.frame,
        rect: [0, 0, 1, 1]
      });
      const p = shot.pip;
      if (p && p.enabled && p.source) {
        const s = clamp(p.size || 0.3, 0.1, 0.9);
        const w = s, h = s; // 16:9 box inside a 16:9 canvas
        const mx = 0.03, my = 0.03 * W / H;
        const x = (p.corner || 'tr').includes('r') ? 1 - w - mx : mx;
        const y = (p.corner || 'tr').includes('t') ? my : 1 - h - my;
        out.push({ source: p.source, frame: smooth ? this._smooth(shot.id + ':p', p.frame) : p.frame, rect: [x, y, w, h], border: true });
      }
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
    _video(sourceId, rect, uv, opacity, zebra) {
      const gl = this.gl;
      const s = this.sources.get(sourceId);
      if (!s || !s.ready) { this._solid(rect, [0.07, 0.08, 0.1, 1], opacity); return; }
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
      gl.uniform4fv(this.u.u_dst, rect);
      gl.uniform4fv(this.u.u_src, uv);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    _drawShot(shot, opacity, smooth, zebra) {
      const W = this.W, H = this.H;
      for (const L of this._layers(shot, smooth)) {
        const r = L.rect;
        if (L.border) {
          const bx = 4 / W, by = 4 / H;
          this._solid([r[0] - bx, r[1] - by, r[2] + bx * 2, r[3] + by * 2], [1, 1, 1, 1], opacity);
        }
        const uv = this.uvFor(L.source, L.frame, (r[2] * W) / (r[3] * H));
        this._video(L.source, r, uv, opacity, zebra);
      }
    }
    _drawLabels(now, dt) {
      const gl = this.gl;
      for (const L of this.labels.values()) {
        const D = labelDesign(L.data || {});
        const step = D.fadeMs > 0 ? dt / D.fadeMs : 1;
        if (L.alpha < L.target) L.alpha = Math.min(L.target, L.alpha + step);
        else if (L.alpha > L.target) L.alpha = Math.max(L.target, L.alpha - step);
        if (L.alpha <= 0) continue;
        if (L.dirty) {
          this._drawLabelCanvas(L);
          gl.bindTexture(gl.TEXTURE_2D, L.tex);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, L.canvas);
          L.dirty = false;
        }
        const a = ease(L.alpha);
        let slide = 0, rise = 0;
        if (D.anim === 'slide') { const al = D.position[1]; if (al === 'l') slide = (1 - a) * -0.02; else if (al === 'r') slide = (1 - a) * 0.02; else rise = (1 - a) * 0.03; }
        gl.bindTexture(gl.TEXTURE_2D, L.tex);
        gl.uniform1i(this.u.u_mode, 1);
        gl.uniform1f(this.u.u_opacity, a);
        gl.uniform4fv(this.u.u_dst, [slide, rise, 1, 1]);
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
      for (const [id, w] of this.webs) if (w.alpha > 0 || w.target > 0) need.add(id);
      const thumbsDue = now - this.lastThumbAt > this.thumbEvery;
      if (thumbsDue) {
        for (const id of this.thumbs.keys()) addShot(shot(id));
        for (const sid of this.sourceViews.values()) need.add(sid);
      }
      for (const id of need) this._upload(id);

      // thumbnails + source views (small, rendered into a corner then copied)
      if (thumbsDue) {
        this.lastThumbAt = now;
        const tw = 320, th = 180;
        for (const [id, cnv] of this.thumbs) {
          if (!cnv.isConnected) continue;
          const s = shot(id);
          this._viewport(tw, th);
          if (s) this._drawShot(s, 1, false, false);
          this._copyTo(cnv.getContext('2d'), tw, th);
        }
        for (const [cnv, sid] of this.sourceViews) {
          if (!cnv.isConnected) { this.sourceViews.delete(cnv); continue; }
          this._viewport(tw, th);
          const sz = this.sourceSize(sid);
          if (sz) {
            const sa = sz.w / sz.h, da = 16 / 9;
            let r = [0, 0, 1, 1];
            if (sa > da) { const h = da / sa; r = [0, (1 - h) / 2, 1, h]; }
            else { const w = sa / da; r = [(1 - w) / 2, 0, w, 1]; }
            this._video(sid, r, [0, 0, 1, 1], 1, false);
          }
          this._copyTo(cnv.getContext('2d'), tw, th);
        }
      }

      // preview monitor
      if (this.previewCtx) {
        const pw = Math.min(960, this.W), ph = Math.round(pw * this.H / this.W);
        this._viewport(pw, ph);
        const ps = shot(this.previewId);
        if (ps) this._drawShot(ps, 1, true, this.zebra);
        this._copyTo(this.previewCtx, pw, ph);
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

      this.stats.renderMs = performance.now() - t0;
      this._fpsCount++;
      if (now - this._fpsAt >= 1000) { this.stats.fps = Math.round(this._fpsCount * 1000 / (now - this._fpsAt)); this._fpsCount = 0; this._fpsAt = now; }
    }

    _tick() {
      const now = performance.now();
      const interval = 1000 / this.fps;
      if (this._next && now < this._next - 1.5) return;
      this._next = (!this._next || now - this._next > interval * 3) ? now + interval : this._next + interval;
      this._render(now);
    }
    start() {
      if (this.running) return;
      this.running = true;
      const raf = () => { if (!this.running) return; requestAnimationFrame(raf); this._tick(); };
      requestAnimationFrame(raf);
      // keeps rendering when the window is minimised or covered
      this._timer = setInterval(() => this._tick(), Math.max(4, 1000 / this.fps / 2));
    }
    stop() { this.running = false; clearInterval(this._timer); }
    setFps(fps) {
      this.fps = fps;
      clearInterval(this._timer);
      if (this.running) this._timer = setInterval(() => this._tick(), Math.max(4, 1000 / fps / 2));
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
      if (!this._stream || this._stream.getVideoTracks()[0].readyState !== 'live') this._stream = this.canvas.captureStream(this.fps);
      return this._stream.getVideoTracks()[0];
    }
  }

  /* ---------- label designs ----------
   * A label's look is a "design". Presets are starting points; every value can be changed in the designer. */
  const LABEL_PRESETS = {
    'lower':       { font: 'Segoe UI', size: 1, bold: true, upper: false, textColor: '#ffffff', subColor: '#ffffff', bgColor: '#0a0c12', bgOpacity: 0.88, bar: 'left', radius: 0, position: 'bl', margin: 0.095, shadow: false, anim: 'slide', fadeMs: 300 },
    'lower-light': { font: 'Segoe UI', size: 1, bold: true, upper: false, textColor: '#0b1220', subColor: '#ffffff', bgColor: '#ffffff', bgOpacity: 0.96, bar: 'left', radius: 0, position: 'bl', margin: 0.095, shadow: false, anim: 'slide', fadeMs: 300 },
    'title':       { font: 'Segoe UI', size: 1.75, bold: true, upper: false, textColor: '#ffffff', subColor: '#e5e7eb', bgColor: '#000000', bgOpacity: 0, bar: 'under', radius: 0, position: 'mc', margin: 0.095, shadow: true, anim: 'fade', fadeMs: 600 },
    'corner':      { font: 'Segoe UI', size: 0.65, bold: true, upper: false, textColor: '#ffffff', subColor: '#ffffff', bgColor: '#0a0c12', bgOpacity: 0.85, bar: 'none', radius: 8, position: 'tr', margin: 0.05, shadow: false, anim: 'fade', fadeMs: 300, accentTitle: true }
  };
  function labelDesign(d) {
    return Object.assign({}, LABEL_PRESETS[d.style] || LABEL_PRESETS.lower, d.design || {});
  }
  function rgba(hex, a) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
    const n = m ? parseInt(m[1], 16) : 0;
    return `rgba(${n >> 16 & 255},${n >> 8 & 255},${n & 255},${a})`;
  }
  function drawLabel(ctx, W, H, d) {
    ctx.clearRect(0, 0, W, H);
    if (!d) return;
    const D = labelDesign(d), k = H / 1080, z = D.size;
    const accent = d.color || '#2563eb';
    const title = D.upper ? (d.title || '').toUpperCase() : (d.title || '');
    const sub = D.upper ? (d.subtitle || '').toUpperCase() : (d.subtitle || '');
    const fam = `"${D.font}", "Segoe UI", system-ui, sans-serif`;
    const tFont = `${D.bold ? 700 : 400} ${54 * k * z}px ${fam}`, sFont = `${D.bold ? 500 : 400} ${32 * k * z}px ${fam}`;
    const boxed = D.bgOpacity > 0.01;
    const padX = (boxed ? 34 : 0) * k * z, th = (boxed ? 92 : 70) * k * z, sh = sub ? (boxed ? 56 : 46) * k * z : 0;
    ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    ctx.font = tFont; const tw = ctx.measureText(title).width + padX * 2;
    ctx.font = sFont; const sw = sub ? ctx.measureText(sub).width + padX * 2 : 0;
    const align = D.position[1] === 'c' ? 'c' : D.position[1];
    const barW = D.bar === 'left' && align !== 'c' ? 12 * k * z : 0;
    const underH = D.bar === 'under' ? 26 * k * z : 0;
    const blockW = Math.max(tw, sw) + barW, blockH = th + sh + underH;
    const mx = D.margin * W * 0.53, my = D.margin * H;
    const x0 = align === 'l' ? mx : align === 'r' ? W - mx - blockW : (W - blockW) / 2;
    const v = D.position[0];
    const y0 = v === 't' ? my : v === 'b' ? H - my - blockH : (H - blockH) / 2;
    const r = D.radius * k;
    const bx = w => align === 'l' ? x0 + barW : align === 'r' ? x0 + blockW - barW - w : x0 + (blockW - w) / 2;
    const box = (x, y, w, h, fill) => { ctx.fillStyle = fill; if (r > 0) { roundRect(ctx, x, y, w, h, Math.min(r, h / 2)); ctx.fill(); } else ctx.fillRect(x, y, w, h); };
    if (barW) box(align === 'l' ? x0 : x0 + blockW - barW, y0, barW, th + sh, accent);
    if (D.shadow) { ctx.shadowColor = 'rgba(0,0,0,0.75)'; ctx.shadowBlur = 18 * k * z; ctx.shadowOffsetY = 2 * k; }
    if (boxed) { const sv = ctx.shadowColor; ctx.shadowColor = 'transparent'; box(bx(tw), y0, tw, th, D.accentTitle ? accent : rgba(D.bgColor, D.bgOpacity)); if (sub) box(bx(sw), y0 + th, sw, sh, D.accentTitle ? rgba(D.bgColor, D.bgOpacity) : accent); ctx.shadowColor = sv; }
    ctx.font = tFont; ctx.fillStyle = D.textColor; ctx.fillText(title, bx(tw) + padX, y0 + th / 2 + 2 * k);
    if (sub) { ctx.font = sFont; ctx.fillStyle = D.subColor; ctx.fillText(sub, bx(sw) + padX, y0 + th + sh / 2 + 1); }
    ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
    if (underH) { const uw = 160 * k * z, ux = align === 'l' ? x0 : align === 'r' ? x0 + blockW - uw : x0 + (blockW - uw) / 2; ctx.fillStyle = accent; ctx.fillRect(ux, y0 + th + sh + 14 * k * z, uw, 8 * k * z); }
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

  window.LiveEngine = { Engine, makeBars, NEUTRAL, LABEL_PRESETS, labelDesign, drawLabel };
})();
