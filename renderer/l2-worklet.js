/* L2-style peak limiter, running on the audio thread.
   Works like a Waves L2: the level is pushed up by (ceiling − threshold), a 1.5 ms look-ahead brickwall stops every
   sample at the Out Ceiling (it cannot go over), Release sets how fast the level comes back, ARC makes the release
   follow the music, and IDR re-quantizes the output (bits + dither + noise shaping).

   How the brickwall works: for every sample the gain needed to keep it under the ceiling is worked out; the lowest
   of those over the look-ahead window is held, smoothed on the way back up by the release, then averaged over the
   same window. The sound is delayed by the window, so the gain is already down when a peak arrives. Every gain
   value in the average is at or below what that peak needs, so the result can never pass the ceiling. */
class L2Limiter extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const H = this.H = Math.max(8, Math.round(0.0015 * sampleRate));
    this.req = new Float32Array(H).fill(1);  // gain each recent sample needs
    this.box = new Float64Array(H).fill(1);  // smoothed gain, for the moving average
    this.sum = H;
    this.dL = new Float32Array(H); this.dR = new Float32Array(H); // look-ahead delay
    this.w = 0; this.fast = 1; this.slow = 1;
    this.err = [[0, 0], [0, 0]];
    this.p = { drive: 1, ceil: Math.pow(10, -1 / 20), rel: 0.1, arc: true, bits: 24, dither: 1, shaping: 2 };
    if (options && options.processorOptions) Object.assign(this.p, options.processorOptions);
    this.coef();
    this.bMin = 1; this.n = 0;
    this.port.onmessage = e => { Object.assign(this.p, e.data); this.coef(); };
  }
  coef() {
    const p = this.p, sr = sampleRate, rel = Math.max(0.00001, p.rel);
    this.kf = 1 - Math.exp(-1 / (rel * sr));        // release
    this.ks = 1 - Math.exp(-1 / (rel * 5 * sr));    // ARC: release of steady limiting (5× longer)
    this.ka = 1 - Math.exp(-1 / (0.3 * sr));        // ARC: how quickly “steady limiting” is recognised
    this.scale = Math.pow(2, Math.round(p.bits) - 1);
    this.top = Math.min(1 - 1 / this.scale, Math.floor(p.ceil * this.scale) / this.scale); // never past the ceiling, even with dither
  }
  // IDR: round to the chosen number of bits, with dither and noise shaping (error feedback)
  q(x, ch) {
    const p = this.p, s = this.scale, e = this.err[ch];
    let v = x * s;
    if (p.shaping === 1) v -= 0.5 * e[0];            // moderate
    else if (p.shaping === 2) v -= e[0];             // normal (1st order)
    else if (p.shaping === 3) v -= 2 * e[0] - e[1];  // ultra (2nd order)
    let d = 0;
    if (p.dither === 1) d = Math.random() - Math.random();   // type 1: triangular, ±1 bit
    else if (p.dither === 2) d = Math.random() - 0.5;        // type 2: rectangular, ±½ bit (less noise)
    const r = Math.round(v + d);
    e[1] = e[0]; e[0] = r - v;
    const o = r / s;
    return o > this.top ? this.top : o < -this.top ? -this.top : o;
  }
  process(inputs, outputs) {
    const inp = inputs[0], out = outputs[0];
    if (!out || !out.length) return true;
    const N = out[0].length, oL = out[0], oR = out[1] || null;
    const iL = inp && inp[0] ? inp[0] : null, iR = inp && inp[1] ? inp[1] : iL;
    const p = this.p, H = this.H, req = this.req, box = this.box, dL = this.dL, dR = this.dR, idr = p.bits < 32;
    for (let i = 0; i < N; i++) {
      const xl = iL ? iL[i] * p.drive : 0, xr = iR ? iR[i] * p.drive : 0;
      const a = Math.abs(xl), b = Math.abs(xr), pk = a > b ? a : b;
      const w = this.w;
      req[w] = pk > 1 ? 1 / pk : 1;
      let m = 1; for (let k = 0; k < H; k++) if (req[k] < m) m = req[k];
      let g = this.fast + (1 - this.fast) * this.kf; if (m < g) g = m; this.fast = g;
      if (p.arc) {
        let s = this.slow; s = m < s ? s + (m - s) * this.ka : s + (1 - s) * this.ks; this.slow = s;
        if (s < g) g = s;
      }
      this.sum += g - box[w]; box[w] = g;
      let gain = this.sum / H; if (gain > 1) gain = 1;
      if (gain < this.bMin) this.bMin = gain;
      dL[w] = xl; dR[w] = xr;
      const r = w + 1 === H ? 0 : w + 1;
      let yl = dL[r] * gain * p.ceil, yr = dR[r] * gain * p.ceil;
      if (idr) { yl = this.q(yl, 0); yr = this.q(yr, 1); }
      oL[i] = yl; if (oR) oR[i] = yr;
      this.w = r;
    }
    // how much it is turning down (for the Atten meter), about 50 times a second
    this.n += N;
    if (this.n >= sampleRate / 50) { this.port.postMessage({ gr: this.bMin < 1 ? -20 * Math.log10(this.bMin) : 0 }); this.n = 0; this.bMin = 1; }
    return true;
  }
}
registerProcessor('l2-limiter', L2Limiter);
