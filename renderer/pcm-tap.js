/* Program sound for the native engine: the mixer's final output (after the limiter) in 20 ms pieces, interleaved —
   the program's L, R, then the L, R of each recording track there is (the node's channel count says how many).
   It goes straight from the sound thread to the main process when a direct line is given (so a busy window can never
   delay it), otherwise to the window, which passes it on. */
class PcmTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.n = Math.round(sampleRate / 50); this.ch = 2; this.buf = new Float32Array(this.n * 2); this.i = 0; this.out = null;
    this.port.onmessage = e => { if (e.data && 'port' in e.data) this.out = e.data.port || null; };
  }
  process(inputs) {
    const inp = inputs[0];
    if (inp && inp.length) {
      // channels: always pairs (an odd count would be a mono input up-mixed — the browser gives 1 for silence)
      const want = Math.max(2, inp.length + (inp.length & 1));
      if (want !== this.ch) { this.ch = want; this.buf = new Float32Array(this.n * want); this.i = 0; }
      const C = this.ch, N = inp[0].length;
      for (let k = 0; k < N; k++) {
        const o = this.i * C;
        if (inp.length === 1) { this.buf[o] = inp[0][k]; this.buf[o + 1] = inp[0][k]; for (let c = 2; c < C; c++) this.buf[o + c] = 0; }
        else for (let c = 0; c < C; c++) this.buf[o + c] = c < inp.length ? inp[c][k] : 0;
        if (++this.i === this.n) {
          const b = this.buf.slice();
          // copied, not transferred: the main process end of the line cannot take over a transferred buffer
          if (this.out) { try { this.out.postMessage({ rate: sampleRate, ch: C, pcm: b }); } catch (e) { this.out = null; this.port.postMessage({ ch: C, pcm: b }, [b.buffer]); } }
          else this.port.postMessage({ ch: C, pcm: b }, [b.buffer]);
          this.i = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('pcm-tap', PcmTap);
