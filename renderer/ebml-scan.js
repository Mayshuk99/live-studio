/* Reads the WebM / Matroska bytes that MediaRecorder produces, as they arrive, and finds the places where a
   second listener can join a recording that is already running: the start of a Cluster whose first video
   block is a keyframe. Used by the shared encoder (one MediaRecorder for the stream and the recording). */
(function () {
  const ID_SEGMENT = 0x18538067, ID_CLUSTER = 0x1F43B675, ID_SIMPLEBLOCK = 0xA3, ID_BLOCKGROUP = 0xA0, ID_BLOCK = 0xA1, ID_TRACKS = 0x1654AE6B, ID_TRACKENTRY = 0xAE, ID_TRACKNUMBER = 0xD7, ID_TRACKTYPE = 0x83;
  const CHILD_OF_CLUSTER = new Set([0xE7, 0xA7, 0xAB, ID_SIMPLEBLOCK, ID_BLOCKGROUP, 0xAF, 0xA3]);
  class EbmlScanner {
    constructor() {
      this.buf = new Uint8Array(0); this.base = 0; // bytes not yet parsed, and their offset in the whole stream
      this.pos = 0; this.state = 'top'; this.headerEnd = -1; this.videoTrack = 1; this.inTracks = false;
      this.events = []; // { type: 'cluster', offset } / { type: 'key', offset (of its cluster) }
      this.curCluster = -1; this.seenVideoInCluster = false; this.total = 0;
    }
    push(bytes) {
      const b = new Uint8Array(bytes);
      const n = new Uint8Array(this.buf.length - this.pos + b.length);
      n.set(this.buf.subarray(this.pos), 0); n.set(b, this.buf.length - this.pos);
      this.base += this.pos; this.buf = n; this.pos = 0; this.total += b.length;
      this._parse();
      const ev = this.events; this.events = []; return ev;
    }
    _vint(at, isId) {
      const b = this.buf; if (at >= b.length) return null;
      const first = b[at]; let len = 1, mask = 0x80;
      while (len <= 8 && !(first & mask)) { len++; mask >>= 1; }
      if (len > 8 || at + len > b.length) return null;
      let v = isId ? first : first & (mask - 1), allOnes = (first & (mask - 1)) === mask - 1;
      for (let i = 1; i < len; i++) { v = v * 256 + b[at + i]; if (b[at + i] !== 0xFF) allOnes = false; }
      return { v, len, unknown: !isId && allOnes };
    }
    _parse() {
      const b = this.buf;
      for (;;) {
        const id = this._vint(this.pos, true); if (!id) return;
        const sz = this._vint(this.pos + id.len, false); if (!sz) return;
        const hdr = id.len + sz.len, start = this.base + this.pos;
        if (id.v === ID_SEGMENT) { this.pos += hdr; continue; }                         // step inside the Segment
        if (id.v === ID_CLUSTER) {
          if (this.headerEnd < 0) this.headerEnd = start;
          this.curCluster = start; this.seenVideoInCluster = false;
          this.events.push({ type: 'cluster', offset: start });
          if (sz.unknown) { this.pos += hdr; continue; }                                 // live: children follow
          this.pos += hdr; continue;                                                     // known size: read its children too
        }
        if (id.v === ID_TRACKS || id.v === ID_TRACKENTRY || id.v === ID_BLOCKGROUP) {
          if (id.v === ID_TRACKENTRY) this._entry = { num: 0, type: 0 };
          this.pos += hdr; continue;
        }
        if (sz.unknown) return; // not expected for other elements
        if (this.pos + hdr + sz.v > b.length) return;                                   // wait for the whole element
        const d = this.pos + hdr;
        if (id.v === ID_TRACKNUMBER && this._entry) { let v = 0; for (let i = 0; i < sz.v; i++) v = v * 256 + b[d + i]; this._entry.num = v; if (this._entry.type === 1) this.videoTrack = v; }
        if (id.v === ID_TRACKTYPE && this._entry) { let v = 0; for (let i = 0; i < sz.v; i++) v = v * 256 + b[d + i]; this._entry.type = v; if (v === 1 && this._entry.num) this.videoTrack = this._entry.num; }
        if ((id.v === ID_SIMPLEBLOCK || id.v === ID_BLOCK) && this.curCluster >= 0 && !this.seenVideoInCluster) {
          const tn = this._vint(d, false);
          if (tn && tn.v === this.videoTrack) {
            this.seenVideoInCluster = true;
            const flags = b[d + tn.len + 2];
            if (id.v === ID_SIMPLEBLOCK && (flags & 0x80)) this.events.push({ type: 'key', offset: this.curCluster });
          }
        }
        this.pos += hdr + sz.v;
        if (this.pos > 1 << 20) { this.base += this.pos; this.buf = this.buf.slice(this.pos); this.pos = 0; return this._parse(); }
      }
    }
  }
  window.EbmlScanner = EbmlScanner;
})();
