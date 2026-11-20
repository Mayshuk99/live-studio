/* Live Studio — encoder / output manager (runs in the main process).
 * Receives the finished program feed from the interface and hands it to the bundled
 * FFmpeg encoder, which streams to YouTube (RTMPS) or records to an MP4 file.
 */
'use strict';
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');

const ENCODERS = {
  x264: (o, g) => ['-c:v', 'libx264', '-preset', o.preset || 'veryfast', '-tune', 'zerolatency', '-profile:v', 'high',
    '-b:v', `${o.bitrate}k`, '-maxrate', `${o.bitrate}k`, '-bufsize', `${o.bitrate * 2}k`, '-x264-params', 'nal-hrd=cbr', '-g', g, '-keyint_min', g, '-sc_threshold', '0'],
  nvenc: (o, g) => ['-c:v', 'h264_nvenc', '-preset', 'p4', '-tune', 'll', '-rc', 'cbr', '-profile:v', 'high',
    '-b:v', `${o.bitrate}k`, '-maxrate', `${o.bitrate}k`, '-bufsize', `${o.bitrate * 2}k`, '-g', g, '-bf', '2'],
  qsv: (o, g) => ['-c:v', 'h264_qsv', '-preset', 'veryfast', '-profile:v', 'high',
    '-b:v', `${o.bitrate}k`, '-maxrate', `${o.bitrate}k`, '-bufsize', `${o.bitrate * 2}k`, '-g', g],
  // plain versions, used automatically when a graphics card or its driver refuses the tuned settings above
  nvenc_safe: (o, g) => ['-c:v', 'h264_nvenc', '-b:v', `${o.bitrate}k`, '-maxrate', `${o.bitrate}k`, '-bufsize', `${o.bitrate * 2}k`, '-g', g],
  qsv_safe: (o, g) => ['-c:v', 'h264_qsv', '-b:v', `${o.bitrate}k`, '-maxrate', `${o.bitrate}k`, '-g', g],
  amf_safe: (o, g) => ['-c:v', 'h264_amf', '-b:v', `${o.bitrate}k`, '-maxrate', `${o.bitrate}k`, '-g', g],
  amf: (o, g) => ['-c:v', 'h264_amf', '-usage', 'lowlatency', '-rc', 'cbr', '-profile:v', 'high',
    '-b:v', `${o.bitrate}k`, '-maxrate', `${o.bitrate}k`, '-bufsize', `${o.bitrate * 2}k`, '-g', g]
};

function streamArgs(o) {
  const fps = o.fps || 30;
  const g = String(fps * 2); // keyframe every 2 seconds (YouTube requirement)
  const enc = ((o.safe && ENCODERS[o.encoder + '_safe']) || ENCODERS[o.encoder] || ENCODERS.x264)(o, g);
  const url = o.url;
  return [
    '-hide_banner', '-loglevel', 'error', '-stats', '-stats_period', '1',
    '-fflags', '+genpts',
    '-f', 'matroska', '-i', 'pipe:0',
    '-map', '0:v:0', '-map', '0:a:0?',
    ...enc,
    '-pix_fmt', 'yuv420p', '-r', String(fps), '-fps_mode', 'cfr',
    '-c:a', 'aac', '-b:a', `${o.audioBitrate || 160}k`, '-ar', '48000', '-ac', '2',
    '-flvflags', 'no_duration_filesize',
    '-f', 'flv', url
  ];
}

function recordArgs(o, partFile) {
  // With a hardware encoder: re-encode to constant frame rate (best for editing in DaVinci Resolve etc.)
  // With software encoding: copy the picture as-is to save processor power.
  const fps = o.fps || 30;
  const hw = ['nvenc', 'qsv', 'amf'].includes(o.encoder);
  const kbps = o.bitrate || 20000;
  let v;
  if (hw) v = [...(o.safe ? ENCODERS[o.encoder + '_safe'] : ENCODERS[o.encoder])({ bitrate: kbps }, String(fps)), '-pix_fmt', 'yuv420p', '-r', String(fps), '-fps_mode', 'cfr'];
  else if (o.inputCodec === 'h264' || o.inputCodec === 'vp9') v = ['-c:v', 'copy'];
  else v = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-r', String(fps), '-fps_mode', 'cfr'];
  return [
    '-hide_banner', '-loglevel', 'error', '-stats', '-stats_period', '1',
    '-fflags', '+genpts',
    '-f', 'matroska', '-i', 'pipe:0',
    '-map', '0:v:0', '-map', '0:a:0?',
    ...v,
    '-c:a', 'aac', '-b:a', `${o.audioBitrate || 256}k`, '-ar', '48000',
    '-movflags', '+frag_keyframe+empty_moov+default_base_moof',
    '-f', 'mp4', '-y', partFile
  ];
}

// Windows refuses to "create" a folder that is a whole drive (D:\), so only create what is missing
function ensureDir(dir) {
  if (!dir) throw new Error('No recording folder chosen (Settings → Recording).');
  try { if (fs.statSync(dir).isDirectory()) return; } catch (e) { /* not there yet */ }
  try { fs.mkdirSync(dir, { recursive: true }); }
  catch (e) { throw new Error(`cannot use the recording folder ${dir} (${e.code || e.message}). Choose another folder in Settings → Recording.`); }
}

function parseStats(line) {
  // frame=  123 fps= 30 q=21.0 size=    1234kB time=00:00:04.10 bitrate=2462.5kbits/s speed=1.00x
  if (!/time=/.test(line)) return null;
  const num = re => { const m = line.match(re); return m ? parseFloat(m[1]) : null; };
  const t = line.match(/time=\s*(-?\d+):(\d+):([\d.]+)/);
  const drop = num(/drop=\s*(\d+)/);
  return {
    frame: num(/frame=\s*(\d+)/), fps: num(/fps=\s*([\d.]+)/), bitrate: num(/bitrate=\s*([\d.]+)kbits/),
    speed: num(/speed=\s*([\d.]+)x/), drop: drop || 0, dup: num(/dup=\s*(\d+)/) || 0,
    time: t ? (+t[1]) * 3600 + (+t[2]) * 60 + (+t[3]) : null
  };
}

function stamp() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

class OutputManager extends EventEmitter {
  constructor(ffmpegPath) {
    super();
    this.ffmpegPath = ffmpegPath;
    this.outs = new Map();
    this.n = 0;
  }

  start(o) {
    const id = 'out' + (++this.n);
    let args, finalFile = null, partFile = null;
    if (o.kind === 'stream') {
      if (!o.url) throw new Error('No stream address / key set.');
      args = streamArgs(o);
    } else {
      ensureDir(o.dir);
      const base = `${(o.name || 'Live Studio').replace(/[\\/:*?"<>|]/g, '_')} ${stamp()}`;
      finalFile = path.join(o.dir, base + '.mp4');
      partFile = path.join(o.dir, base + '.recording.mp4');
      args = recordArgs(o, partFile);
    }
    const proc = spawn(this.ffmpegPath, args, { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
    const out = { id, kind: o.kind, proc, finalFile, partFile, stopping: false, err: [], first: [], frames: 0, bytes: 0 };
    this.outs.set(id, out);
    proc.stdin.on('error', () => { /* handled by exit */ });
    let buf = '';
    proc.stderr.on('data', d => {
      buf += d.toString();
      const parts = buf.split(/[\r\n]+/);
      buf = parts.pop();
      for (const line of parts) {
        if (!line.trim() || /ended prematurely/.test(line)) continue;
        const s = parseStats(line);
        if (s) out.frames = Math.max(out.frames, s.frame || 0);
        if (s) this.emit('event', { id, kind: o.kind, type: 'stats', ...s, backlog: proc.stdin.writableLength });
        else {
          out.err.push(line); if (out.err.length > 30) out.err.shift();
          if (out.first.length < 6) out.first.push(line);
          this.emit('event', { id, kind: o.kind, type: 'log', line });
        }
      }
    });
    proc.on('error', e => {
      this.emit('event', { id, kind: o.kind, type: 'exit', code: -1, error: `Encoder could not start: ${e.message}` });
      this.outs.delete(id);
    });
    proc.on('exit', async code => {
      this.outs.delete(id);
      let file = null;
      if (out.kind === 'record' && fs.existsSync(partFile)) {
        file = await this._finalize(partFile, finalFile).catch(() => partFile);
      }
      this.emit('event', {
        id, kind: o.kind, type: 'exit', code, expected: out.stopping, file,
        error: (code !== 0 && !out.stopping) ? (out.err.slice(-3).join(' | ') || `Encoder stopped (code ${code})`) : null,
        // the picture encoder itself refused to start (graphics card / driver), as opposed to an internet problem
        encoderFailed: code !== 0 && !out.stopping && out.frames === 0 && /nvenc|qsv|amf|vost#|opening encoder|No capable devices|driver/i.test(out.err.join(' ')),
        detail: out.first.slice(0, 3).join(' | ').replace(/\[[^\]]*@ (0x)?[0-9a-f]+\]\s*/gi, '')
      });
    });
    this.emit('event', { id, kind: o.kind, type: 'started', file: finalFile });
    return id;
  }

  /* turn the crash-safe fragmented recording into a normal MP4 (fast, no re-encode) */
  _finalize(part, final) {
    return new Promise((resolve, reject) => {
      const p = spawn(this.ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-i', part, '-c', 'copy', '-movflags', '+faststart', '-y', final], { windowsHide: true });
      p.on('exit', code => {
        if (code === 0 && fs.existsSync(final)) { try { fs.unlinkSync(part); } catch (e) { /* keep */ } resolve(final); }
        else reject(new Error('remux failed'));
      });
      p.on('error', reject);
    });
  }

  write(id, data) {
    const out = this.outs.get(id);
    if (!out || out.stopping || !out.proc.stdin.writable) return;
    out.proc.stdin.write(Buffer.from(data));
  }

  stop(id) {
    const out = this.outs.get(id);
    if (!out) return Promise.resolve();
    out.stopping = true;
    return new Promise(resolve => {
      const t = setTimeout(() => { try { out.proc.kill('SIGKILL'); } catch (e) { /* gone */ } resolve(); }, 8000);
      out.proc.once('exit', () => { clearTimeout(t); resolve(); });
      try { out.proc.stdin.end(); } catch (e) { out.proc.kill(); }
    });
  }

  stopAll() { return Promise.all([...this.outs.keys()].map(id => this.stop(id))); }
  get active() { return this.outs.size > 0; }
}

module.exports = { OutputManager, streamArgs, recordArgs, parseStats, ensureDir };
