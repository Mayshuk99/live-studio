/* Live Studio — finds sharp sounds (claps, beeps) in an audio input with sample accuracy, for the sync test */
class OnsetDetector extends AudioWorkletProcessor {
  constructor() { super(); this.noise = 0.002; this.last = -1; this.env = 0; this.n = 0; }
  process(inputs) {
    const ch = inputs[0];
    if (!ch || !ch.length) return true;
    const len = ch[0].length;
    for (let i = 0; i < len; i++) {
      let v = 0;
      for (let c = 0; c < ch.length; c++) { const x = Math.abs(ch[c][i]); if (x > v) v = x; }
      const t = currentTime + i / sampleRate;
      if (v > Math.max(0.04, this.noise * 10) && this.env < v * 0.35 && t - this.last > 0.3) {
        this.last = t;
        this.port.postMessage({ type: 'onset', t, level: v });
      }
      this.env = Math.max(v, this.env * 0.9995);
      this.noise += (v - this.noise) * (v > this.noise ? 0.0005 : 0.005);
    }
    if (++this.n % 40 === 0) this.port.postMessage({ type: 'level', noise: this.noise, env: this.env });
    return true;
  }
}
registerProcessor('onset-detector', OnsetDetector);
