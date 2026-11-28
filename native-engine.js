/* Live Studio — the native engine process (runs in the main process).
 * Starts ls-engine, sends it commands and reads what it reports.
 * Messages both ways: [u32 header length][u32 payload length][JSON header][payload]
 */
'use strict';
const { spawn } = require('child_process');
const crypto = require('crypto');
const net = require('net');
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

// one packet: 8 bytes (header length, payload length), the JSON header, the payload (Buffer / typed array / nothing)
function frame(header, payload) {
  const hb = Buffer.from(JSON.stringify(header));
  const pb = payload ? Buffer.from(payload.buffer ? payload.buffer : payload, payload.byteOffset || 0, payload.byteLength !== undefined ? payload.byteLength : payload.length) : null;
  const pre = Buffer.alloc(8);
  pre.writeUInt32LE(hb.length, 0); pre.writeUInt32LE(pb ? pb.length : 0, 4);
  return pb ? Buffer.concat([pre, hb, pb]) : Buffer.concat([pre, hb]);
}

class NativeEngine extends EventEmitter {
  constructor() { super(); this.proc = null; this.pre = Buffer.alloc(0); this.pk = null; this.ready = false; this.queue = 0; this.sound = null; this.soundWait = false; }

  start(exe, hello) {
    if (this.proc) return true;
    let p;
    try { p = spawn(exe, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); } catch (e) { this.emit('msg', { ev: 'exit', code: -1, error: e.message }); return false; }
    this.proc = p; this.ready = false; this.pre = Buffer.alloc(0); this.pk = null;
    p.stdin.on('error', () => {});
    p.stdout.on('data', d => this._data(d));
    p.stderr.on('data', d => { for (const l of String(d).split(/\r?\n/)) if (l.trim()) this.emit('msg', { ev: 'log', line: 'engine: ' + l.trim() }); });
    p.on('error', e => this.emit('msg', { ev: 'exit', code: -1, error: e.message }));
    p.on('exit', (code) => { this.proc = null; this.ready = false; this.soundWait = false; if (this.sound) { this.sound.destroy(); this.sound = null; } this.emit('msg', { ev: 'exit', code }); });
    this.soundKey = crypto.randomBytes(16).toString('hex');
    this.send(Object.assign({ cmd: 'hello', soundKey: this.soundKey }, hello));
    return true;
  }

  /* Sound has its own line to the engine (a local connection): on the command line it would queue up behind
     pictures — 100 MB of graphics held it back half a second on a slow PC, and the stream got a gap.
     Until the line is open (a few ms after "ready") sound is not sent at all, so nothing can arrive out of order;
     if it can't be opened, sound goes down the command line as before. */
  _soundLine(port) {
    const p = this.proc, s = net.connect({ port, host: '127.0.0.1' });
    this.soundWait = true;
    const give = () => { if (this.soundWait && this.proc === p && this.sound !== s) { this.soundWait = false; this.emit('msg', { ev: 'log', line: 'sound goes to the engine down the command line (its own line did not open)' }); } };
    const t = setTimeout(() => { give(); if (this.sound !== s) s.destroy(); }, 2000);
    s.setNoDelay(true);
    s.on('connect', () => {
      clearTimeout(t);
      if (this.proc !== p) { s.destroy(); return; }
      s.write(frame({ cmd: 'sound-hello', key: this.soundKey }));
      this.sound = s; this.soundWait = false;
      this.emit('msg', { ev: 'log', line: 'sound has its own line to the engine (it cannot wait behind pictures)' });
    });
    s.on('error', () => { clearTimeout(t); give(); });
    s.on('close', () => { if (this.sound === s) this.sound = null; });
  }

  /* packets: 8 bytes (header length, payload length), the JSON header, the payload. A big picture arrives in many
     pieces; each packet gets one buffer of its full size and the pieces are copied into it once (gluing the pieces
     together again and again would copy a 1 MB picture dozens of times). */
  _data(d) {
    while (d.length) {
      if (!this.pk) {
        const need = 8 - this.pre.length;
        if (d.length < need) { this.pre = Buffer.concat([this.pre, d]); return; }
        const pre = this.pre.length ? Buffer.concat([this.pre, d.subarray(0, need)]) : d.subarray(0, 8);
        d = d.subarray(need); this.pre = Buffer.alloc(0);
        const hl = pre.readUInt32LE(0), pl = pre.readUInt32LE(4);
        this.pk = { hl, pl, buf: Buffer.allocUnsafe(hl + pl), got: 0 };
      }
      const pk = this.pk, n = Math.min(d.length, pk.buf.length - pk.got);
      d.copy(pk.buf, pk.got, 0, n); pk.got += n; d = d.subarray(n);
      if (pk.got < pk.buf.length) return;
      this.pk = null;
      let h;
      try { h = JSON.parse(pk.buf.toString('utf8', 0, pk.hl)); } catch (e) { h = { ev: 'bad' }; }
      const payload = pk.pl ? pk.buf.subarray(pk.hl) : null;
      if (h.ev === 'ready') { this.ready = true; if (h.soundPort && !this.sound) this._soundLine(h.soundPort); }
      this.emit('msg', h, payload);
    }
  }

  // payload: Buffer / typed array / undefined. Returns false if the engine is not running.
  send(header, payload) {
    const p = this.proc;
    if (!p || !p.stdin.writable) return false;
    if (header.cmd === 'audio') {
      if (this.soundWait) return true; // the sound line is just opening
      if (this.sound && this.sound.writable) { this.sound.write(frame(header, payload)); return true; }
    }
    // a big picture: its bytes go as they are, without first being copied into one buffer with the header
    const n = payload ? (payload.byteLength !== undefined ? payload.byteLength : payload.length) : 0;
    if (n > 256 << 10) {
      const hb = Buffer.from(JSON.stringify(header)), pre = Buffer.alloc(8);
      pre.writeUInt32LE(hb.length, 0); pre.writeUInt32LE(n, 4);
      p.stdin.cork();
      p.stdin.write(Buffer.concat([pre, hb]));
      p.stdin.write(Buffer.from(payload.buffer ? payload.buffer : payload, payload.byteOffset || 0, n));
      p.stdin.uncork();
      return true;
    }
    p.stdin.write(frame(header, payload));
    return true;
  }

  // how much is waiting to be written to the engine (to skip non-essential messages when it is behind)
  get backlog() { return this.proc ? this.proc.stdin.writableLength : 0; }
  // may sound be sent? (not when far too much is already waiting: the engine has stopped reading)
  get soundRoom() { return this.sound && this.sound.writable ? this.sound.writableLength < (8 << 20) : this.backlog < (64 << 20); }

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
/* the engine keeps 400 ms of sound waiting (engine/audio.go targetSec) instead of the 60 ms the "Sound/picture sync"
   setting was tuned with, so window stalls no longer cut the sound: the picture waits the 340 ms more */
const SOUND_RESERVE_EXTRA_MS = 340;
/* …and every file / stream fed by the engine starts that much later (an output option): without it each would begin
   with 0.34 s of sound and no picture — a frozen first picture in the recording, and the recording and its ISO files
   22 pictures apart */
const engineTrim = () => ['-ss', (SOUND_RESERVE_EXTRA_MS / 1000).toFixed(3)];
/* recording tracks (a recording only): the sound comes as pairs of channels — the program's L, R, then track n on
   channels 2n−2, 2n−1 (OBS-style tracks 2…6; one that is off is silent). FFmpeg makes a stereo track of each track
   recorded. The stream always takes the program alone. tracks: [{ n, name }] */
const recTracks = o => (o && o.kind === 'record' && Array.isArray(o.tracks) ? o.tracks.filter(t => t && t.n >= 2 && t.n <= 6).sort((a, b) => a.n - b.n) : []);
const soundChannels = o => { const t = recTracks(o); return t.length ? 2 * t[t.length - 1].n : 2; };
function soundMap(o) {
  const t = recTracks(o);
  if (!t.length) return ['-map', '0:a:0'];
  const list = [{ n: 1, name: 'Program' }, ...t.map(x => ({ n: x.n, name: String(x.name || '').trim() || `Track ${x.n}` }))];
  const fc = `[0:a]asplit=${list.length}${list.map((_, i) => `[x${i}]`).join('')};` + list.map((x, i) => `[x${i}]pan=stereo|c0=c${x.n * 2 - 2}|c1=c${x.n * 2 - 1}[a${i}]`).join(';');
  return ['-filter_complex', fc, ...list.flatMap((_, i) => ['-map', `[a${i}]`]),
    ...list.flatMap((x, i) => [`-metadata:s:a:${i}`, `title=${x.name}`, `-metadata:s:a:${i}`, `handler_name=${x.name}`])];
}
function engineInput(o) {
  const fps = o.fps || 59.94;
  const rate = fps === 59.94 ? '60000/1001' : fps === 29.97 ? '30000/1001' : String(fps);
  const d = (Math.max(0, o.videoDelayMs === undefined ? 20 : o.videoDelayMs) + SOUND_RESERVE_EXTRA_MS) / 1000;
  return [
    // no probing: the formats are known, and probing would wait for sound before reading any picture
    '-thread_queue_size', '2048', '-probesize', '32', '-analyzeduration', '0', '-f', 's16le', '-ar', '48000', '-ac', String(soundChannels(o)), '-i', 'tcp://127.0.0.1:{AUDIOPORT}',
    // (about 200 MB of pictures at most waiting inside FFmpeg, whatever the size: 64 at 1080p, 16 at 4K)
    // encoded inside the engine: ready-made H.264 on the pipe (see engineCoded below)
    // (FLV-wrapped by the engine: every picture has its time and the format comes first, so FFmpeg guesses and probes nothing)
    ...(o.coded ? ['-thread_queue_size', '1024', '-probesize', '1000000', '-analyzeduration', '0', '-fpsprobesize', '0', '-f', 'flv', '-i', 'pipe:0'] : [
    '-thread_queue_size', String(Math.max(8, Math.round(64 * 1920 * 1080 / ((o.width || 1920) * (o.height || 1080))))), '-probesize', '32', '-analyzeduration', '0', ...(d > 0 ? ['-itsoffset', d.toFixed(3)] : []),
    '-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-video_size', `${o.width || 1920}x${o.height || 1080}`, '-framerate', rate, '-i', 'pipe:0'])
  ];
}
/* Encoded inside the engine (OBS-style): FFmpeg gets finished H.264 and only copies it next to the sound.
   - the pictures carry no times of their own: each gets its number divided by the frame rate (the same clock the
     raw pictures are given), set explicitly so no FFmpeg version has to guess;
   - picture and sound are lined up by the engine instead of -itsoffset / -ss: it leaves out the first soundSkipMs of
     sound for that output (the picture's delay + the sound reserve), so both start at zero. */
const engineCoded = {
  video: o => { const fps = o.fps || 59.94, [num, den] = fps === 59.94 ? [60000, 1001] : fps === 29.97 ? [30000, 1001] : [Math.round(fps * 1000), 1000]; return ['-c:v', 'copy', '-bsf:v', `setts=ts=N*${den}/${num}/TB`, '-r', `${num}/${den}`]; },
  // (a whole number of pictures, as FFmpeg rounds -itsoffset for the raw pictures: both ways give the same sync)
  soundSkipMs: o => { const d = Math.max(0, o.videoDelayMs === undefined ? 20 : o.videoDelayMs) + SOUND_RESERVE_EXTRA_MS, fps = o.fps || 59.94; return Math.round(Math.round(d / 1000 * fps) / fps * 1000); }
};

module.exports = { NativeEngine, enginePath, engineInput, engineTrim, engineCoded, soundChannels, soundMap, SOUND_RESERVE_EXTRA_MS };
