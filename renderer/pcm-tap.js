/* Program sound for the native engine: the mixer's final output (after the limiter) in 20 ms pieces (stereo,
   interleaved). It goes straight from the sound thread to the main process when a direct line is given (so a busy
   window can never delay it), otherwise to the window, which passes it on. */
class PcmTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.n = Math.round(sampleRate / 50); this.buf = new Float32Array(this.n * 2); this.i = 0; this.out = null;
    this.port.onmessage = e => { if (e.data && 'port' in e.data) this.out = e.data.port || null; };
  }
  process(inputs) {
    const inp = inputs[0];
    if (inp && inp.length) {
      const L = inp[0], R = inp[1] || inp[0];
      for (let k = 0; k < L.length; k++) {
        this.buf[this.i * 2] = L[k]; this.buf[this.i * 2 + 1] = R[k];
        if (++this.i === this.n) {
          const b = this.buf.slice();
          if (this.out) { try { this.out.postMessage({ rate: sampleRate, pcm: b }, [b.buffer]); } catch (e) { this.out = null; this.port.postMessage(b, [b.buffer]); } }
          else this.port.postMessage(b, [b.buffer]);
          this.i = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('pcm-tap', PcmTap);
