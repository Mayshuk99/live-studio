/* Master inserts (VST3 plug-ins). The sound is sent in 256-sample blocks to the plug-in host (a separate program)
 * and comes back processed. The output runs a fixed time behind the input (D samples), so a block that comes back
 * late never makes a gap: for that moment the untouched sound is played instead (with a short crossfade), delayed by
 * the same amount, so the timing never moves. If the host is missing or has crashed, the sound simply goes through.
 *
 * messages in:  {port}            a direct line to the host (null = send through the window instead)
 *               {on, D}           on = blocks are sent; D = total delay in samples (base + every plug-in's own delay)
 *               {seq, lat, pcm}   a processed block (from the direct line or relayed by the window)
 * messages out: {seq, pcm}        a block to process (on the direct line, or to the window when there is none)
 *               {stats}           about once a second
 */
const B = 256, R = 1 << 16, NB = R / B, F = 128; // block, ring (frames), blocks in the ring, crossfade length

class VstInsert extends AudioWorkletProcessor {
  constructor() {
    super();
    this.dL = new Float32Array(R); this.dR = new Float32Array(R);   // what came in
    this.wL = new Float32Array(R); this.wR = new Float32Array(R);   // what came back from the plug-ins
    this.tag = new Float64Array(NB).fill(-1);                       // which block each wet slot holds
    this.blat = new Int32Array(NB);                                 // the plug-in delay that block was processed with
    this.lat = 0; this.plat = 0;                                    // newest plug-in delay reported, and the one before
    this.n = 0;                                                     // samples taken in so far
    this.sb = new Float32Array(B * 2); this.si = 0;                 // block being filled
    this.on = false; this.D = 0; this.D0 = 0; this.xf = 0;          // D0 / xf: crossfade after D changes
    this.g = 0;                                                     // 0 = dry, 1 = processed
    this.seen = false;                                              // processed sound has come back since turned on (before that, dry is not "late")
    this.out = null;
    this.st = { sent: 0, got: 0, late: 0, dry: 0, bad: 0, wet: 0 }; this.stAt = 0;
    this.port.onmessage = e => this.msg(e.data, false);
  }
  msg(d, direct) {
    if (!d) return;
    if ('port' in d) {
      this.out = d.port || null;
      if (this.out) this.out.onmessage = e => this.msg(e.data, true);
      return;
    }
    if (d.hello) { this.port.postMessage({ portOk: true }); return; }
    if ('D' in d || 'on' in d) {
      if ('on' in d) { if (!!d.on !== this.on) this.seen = false; this.on = !!d.on; }
      if ('D' in d) {
        const D = Math.max(0, Math.min(R - 4 * B, d.D | 0));
        if (D !== this.D) { this.D0 = this.D; this.D = D; this.xf = F * 2; }
      }
      return;
    }
    if (d.pcm !== undefined && d.seq !== undefined) this.wet(d);
  }
  wet(d) {
    let p = d.pcm;
    if (!(p instanceof Float32Array)) {
      try { p = p instanceof ArrayBuffer ? new Float32Array(p) : new Float32Array(p.buffer.slice(p.byteOffset, p.byteOffset + p.byteLength)); } catch (e) { return; }
    }
    const seq = +d.seq, frames = p.length >> 1;
    if (frames !== B || !(seq >= 0)) return;
    if ((this.n - seq * B) >= R - B) { this.st.late++; return; } // so old it would overwrite newer sound
    const o = (seq % NB) * B;
    for (let i = 0; i < B; i++) {
      const l = p[i * 2], r = p[i * 2 + 1];
      if (!(l - l === 0) || !(r - r === 0)) { this.st.bad++; return; } // NaN or infinity: a plug-in misbehaved — keep the dry sound
      this.wL[o + i] = l; this.wR[o + i] = r;
    }
    const lat = d.lat | 0;
    if (lat !== this.lat) { this.plat = this.lat; this.lat = lat; } // a plug-in was bypassed / changed: older blocks still use the old delay
    this.tag[seq % NB] = seq; this.blat[seq % NB] = lat;
    this.st.got++;
  }
  hasL(w, L) { if (w < 0) return false; const b = Math.floor(w / B), k = b % NB; return this.tag[k] === b && this.blat[k] === L; }
  // where the processed version of input position c is in the wet ring (-1: not here yet / missing)
  wpos(c) {
    let w = c + this.lat; if (this.hasL(w, this.lat)) return w;
    if (this.plat !== this.lat) { w = c + this.plat; if (this.hasL(w, this.plat)) return w; }
    return -1;
  }
  // one output sample for "content" position c (what came in at c, processed if available): [L, R]
  read(c, i, outL, outR, a) {
    const j = ((c % R) + R) % R;
    let L = c >= 0 ? this.dL[j] : 0, Rr = c >= 0 ? this.dR[j] : 0;
    if (this.g > 0) {
      const w = this.wpos(c);
      if (w >= 0) { const k = w % R; L = this.g * this.wL[k] + (1 - this.g) * L; Rr = this.g * this.wR[k] + (1 - this.g) * Rr; }
    }
    outL[i] += a * L; outR[i] += a * Rr;
  }
  process(inputs, outputs) {
    const inp = inputs[0], out = outputs[0];
    const oL = out[0], oR = out[1] || out[0], N = oL.length;
    const iL = inp && inp.length ? inp[0] : null, iR = inp && inp.length > 1 ? inp[1] : iL;
    // take in
    for (let i = 0; i < N; i++) {
      const l = iL ? iL[i] : 0, r = iR ? iR[i] : 0, j = (this.n + i) % R;
      this.dL[j] = l; this.dR[j] = r;
      this.sb[this.si * 2] = l; this.sb[this.si * 2 + 1] = r;
      if (++this.si === B) {
        this.si = 0;
        if (this.on) {
          const seq = Math.floor((this.n + i) / B), pcm = this.sb.slice();
          try { if (this.out) this.out.postMessage({ seq, pcm }); else this.port.postMessage({ seq, pcm }); this.st.sent++; } catch (e) { this.out = null; }
        }
      }
    }
    // give out: D samples behind
    oL.fill(0); if (oR !== oL) oR.fill(0);
    for (let i = 0; i < N; i++) {
      const t = this.n + i;
      // processed sound is used only if the next F samples of it are already here too, so it can always fade out in time
      const c = t - this.D, here = this.on && this.wpos(c) >= 0, ok = here && this.wpos(c + F) >= 0;
      if (ok) { if (this.g < 1) this.g = Math.min(1, this.g + 1 / F); }
      else if (this.g > 0) this.g = here ? Math.max(0, this.g - 1 / F) : 0;
      if (this.g >= 1) this.seen = true;
      if (this.on) { if (this.g >= 1) this.st.wet++; else if (this.seen) this.st.dry++; }
      if (this.xf > 0) {
        const a = 1 - this.xf / (F * 2);
        this.read(c, i, oL, oR, a); this.read(t - this.D0, i, oL, oR, 1 - a);
        this.xf--;
      } else this.read(c, i, oL, oR, 1);
    }
    this.n += N;
    if (this.n - this.stAt >= sampleRate) {
      this.stAt = this.n;
      this.port.postMessage({ stats: Object.assign({ lat: this.lat, D: this.D, direct: !!this.out }, this.st) });
      this.st = { sent: 0, got: 0, late: 0, dry: 0, bad: 0, wet: 0 };
    }
    return true;
  }
}
registerProcessor('vst-insert', VstInsert);
