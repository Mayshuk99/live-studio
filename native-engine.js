/* Live Studio — the native engine process (runs in the main process).
 * Starts ls-engine, sends it commands and reads what it reports.
 * Messages both ways: [u32 header length][u32 payload length][JSON header][payload]
 */
'use strict';
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');

function enginePath(app) {
  const exe = process.platform === 'win32' ? 'ls-engine.exe' : 'ls-engine';
  const cands = [];
  if (app && app.isPackaged) cands.push(path.join(process.resourcesPath, 'engine', exe));
  cands.push(path.join(__dirname, 'resources', 'engine', exe), path.join(__dirname, 'engine', exe));
  return cands.find(p => { try { return fs.statSync(p).isFile(); } catch (e) { return false; } }) || null;
}

class NativeEngine extends EventEmitter {
  constructor() { super(); this.proc = null; this.buf = Buffer.alloc(0); this.ready = false; this.queue = 0; }

  start(exe, hello) {
    if (this.proc) return true;
    let p;
    try { p = spawn(exe, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); } catch (e) { this.emit('msg', { ev: 'exit', code: -1, error: e.message }); return false; }
    this.proc = p; this.ready = false; this.buf = Buffer.alloc(0);
    p.stdin.on('error', () => {});
    p.stdout.on('data', d => this._data(d));
    p.stderr.on('data', d => { for (const l of String(d).split(/\r?\n/)) if (l.trim()) this.emit('msg', { ev: 'log', line: 'engine: ' + l.trim() }); });
    p.on('error', e => this.emit('msg', { ev: 'exit', code: -1, error: e.message }));
    p.on('exit', (code) => { this.proc = null; this.ready = false; this.emit('msg', { ev: 'exit', code }); });
    this.send(Object.assign({ cmd: 'hello' }, hello));
    return true;
  }

  _data(d) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    for (;;) {
      if (this.buf.length < 8) return;
      const hl = this.buf.readUInt32LE(0), pl = this.buf.readUInt32LE(4);
      if (this.buf.length < 8 + hl + pl) return;
      let h;
      try { h = JSON.parse(this.buf.toString('utf8', 8, 8 + hl)); } catch (e) { h = { ev: 'bad' }; }
      const payload = pl ? this.buf.subarray(8 + hl, 8 + hl + pl) : null;
      this.buf = this.buf.subarray(8 + hl + pl);
      if (!this.buf.length) this.buf = Buffer.alloc(0);
      if (h.ev === 'ready') this.ready = true;
      this.emit('msg', h, payload);
    }
  }

  // payload: Buffer / typed array / undefined. Returns false if the engine is not running.
  send(header, payload) {
    const p = this.proc;
    if (!p || !p.stdin.writable) return false;
    const hb = Buffer.from(JSON.stringify(header));
    const pb = payload ? Buffer.from(payload.buffer ? payload.buffer : payload, payload.byteOffset || 0, payload.byteLength !== undefined ? payload.byteLength : payload.length) : null;
    const pre = Buffer.alloc(8);
    pre.writeUInt32LE(hb.length, 0); pre.writeUInt32LE(pb ? pb.length : 0, 4);
    p.stdin.write(pb ? Buffer.concat([pre, hb, pb]) : Buffer.concat([pre, hb]));
    return true;
  }

  // how much is waiting to be written to the engine (to skip non-essential messages when it is behind)
  get backlog() { return this.proc ? this.proc.stdin.writableLength : 0; }

  stop() {
    const p = this.proc;
    if (!p) return Promise.resolve();
    return new Promise(resolve => {
      const t = setTimeout(() => { try { p.kill(); } catch (e) { /* */ } resolve(); }, 12000);
      p.once('exit', () => { clearTimeout(t); resolve(); });
      try { this.send({ cmd: 'quit' }); p.stdin.end(); } catch (e) { p.kill(); }
    });
  }
}

/* FFmpeg options for an encoder fed by the engine: sound from a local connection, picture from the pipe.
   The picture is delayed a little (videoDelayMs) because it arrives sooner than the sound. */
function engineInput(o) {
  const fps = o.fps || 59.94;
  const rate = fps === 59.94 ? '60000/1001' : fps === 29.97 ? '30000/1001' : String(fps);
  const d = Math.max(0, o.videoDelayMs === undefined ? 20 : o.videoDelayMs) / 1000;
  return [
    // no probing: the formats are known, and probing would wait for sound before reading any picture
    '-thread_queue_size', '2048', '-probesize', '32', '-analyzeduration', '0', '-f', 's16le', '-ar', '48000', '-ac', '2', '-i', 'tcp://127.0.0.1:{AUDIOPORT}',
    // (about 200 MB of pictures at most waiting inside FFmpeg, whatever the size: 64 at 1080p, 16 at 4K)
    '-thread_queue_size', String(Math.max(8, Math.round(64 * 1920 * 1080 / ((o.width || 1920) * (o.height || 1080))))), '-probesize', '32', '-analyzeduration', '0', ...(d > 0 ? ['-itsoffset', d.toFixed(3)] : []),
    '-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-video_size', `${o.width || 1920}x${o.height || 1080}`, '-framerate', rate, '-i', 'pipe:0'
  ];
}

module.exports = { NativeEngine, enginePath, engineInput };
