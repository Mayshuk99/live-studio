// Build-time check: a network source (SRT, from a "remote encoder" at another size and frame rate) read by the
// native engine, and a recording with two ISO files (ProRes, MJPEG) started together — same number of frames,
// same timecode. Stops the build if anything does not work.
'use strict';
const fs = require('fs'), os = require('os'), path = require('path'), { spawn, execFileSync } = require('child_process');
const { NativeEngine } = require('../native-engine');
const { recordArgs, isoArgs, netArgs } = require('../streamer');

module.exports = function run(exe, ff) {
  const W = 1280, H = 720, dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ls-isonet-'));
  const fail = msg => { console.error('FAIL', msg); process.exit(1); };
  const protos = execFileSync(ff, ['-hide_banner', '-protocols']).toString();
  if (!/^\s*srt\s*$/m.test(protos)) fail('this FFmpeg cannot read SRT');
  const e = new NativeEngine(), stats = [], exits = {}, status = {}, said = [];
  e.on('msg', h => {
    if (h.ev === 'stats') stats.push(h);
    else if (h.ev === 'cam-status') status[h.id] = h.text;
    else if (h.ev === 'out-exit') exits[h.id] = h.code;
    else if (h.ev === 'out-log' && !/^frame=/.test(h.line)) said.push(`${h.id}: ${h.line}`);
    else if (h.ev === 'log') console.log('engine:', h.line);
  });
  if (!e.start(exe, { w: W, h: H, fpsNum: 60000, fpsDen: 1001, ffmpeg: ff })) fail('engine did not start');
  e.send({ cmd: 'camera', id: 'A', args: ['-re', '-f', 'lavfi', '-i', `testsrc2=size=${W}x${H}:rate=60000/1001`] });
  // the source waits for the encoder (listener); the encoder sends 640×480 at 30 fps
  const port = 20000 + Math.floor(Math.random() * 20000);
  e.send({ cmd: 'camera', id: 'N', free: true, w: W, h: H, args: netArgs({ url: `srt://127.0.0.1:${port}?mode=listener&latency=120000`, w: W, h: H }) });
  const sender = spawn(ff, ['-hide_banner', '-loglevel', 'error', '-re', '-f', 'lavfi', '-i', 'testsrc=size=640x480:rate=30', '-t', '16', '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-g', '30', '-f', 'mpegts', `srt://127.0.0.1:${port}?mode=caller`], { stdio: ['ignore', 'ignore', 'inherit'] });
  let ph = 0;
  const aud = setInterval(() => { const n = 480, f = new Float32Array(n * 2); for (let i = 0; i < n; i++) { f[i * 2] = f[i * 2 + 1] = 0.2 * Math.sin(ph); ph += 2 * Math.PI * 440 / 48000; } e.send({ cmd: 'audio', rate: 48000, ch: 2 }, f); }, 10);
  const at = (s, fn) => setTimeout(fn, s * 1000);
  const base = { engine: true, fps: 59.94, width: W, height: H }, tc = '10:00:00:00', group = 'g1';
  const files = { rec: path.join(dir, 'rec.mp4'), isoA: path.join(dir, 'A.mov'), isoN: path.join(dir, 'N.avi') };
  at(1, () => e.send({ cmd: 'program', base: { src: 'N' }, ms: 0 }));
  at(4, () => {
    e.send({ cmd: 'output-start', id: 'rec', group, groupSize: 3, args: recordArgs(Object.assign({ encoder: 'x264', bitrate: 3000 }, base), files.rec).map(a => a === 'veryfast' ? 'ultrafast' : a) });
    setTimeout(() => e.send({ cmd: 'output-start', id: 'isoA', src: 'A', group, groupSize: 3, args: isoArgs(Object.assign({ codec: 'prores-proxy', timecode: tc }, base), files.isoA) }), 150);
    setTimeout(() => e.send({ cmd: 'output-start', id: 'isoN', src: 'N', group, groupSize: 3, args: isoArgs(Object.assign({ codec: 'mjpeg', timecode: tc }, base), files.isoN) }), 400);
  });
  at(11, () => ['rec', 'isoA', 'isoN'].forEach(id => e.send({ cmd: 'output-stop', id })));
  at(17, async () => {
    clearInterval(aud);
    await e.stop(); sender.kill();
    // what is in each file (FFmpeg reads it back): codec, frames, timecode
    const look = f => {
      let txt = '';
      try { execFileSync(ff, ['-hide_banner', '-i', f, '-map', '0:v:0', '-f', 'null', '-'], { stdio: ['ignore', 'ignore', 'pipe'] }); } catch (x) { txt = String(x.stderr || ''); }
      if (!txt) { const r = require('child_process').spawnSync(ff, ['-hide_banner', '-i', f, '-map', '0:v:0', '-f', 'null', '-']); txt = String(r.stderr || ''); }
      const fr = [...txt.matchAll(/frame=\s*(\d+)/g)].pop();
      return { frames: fr ? +fr[1] : 0, codec: (/Video: (\w+)/.exec(txt) || [])[1], timecode: (/timecode\s*:\s*([\d:;]+)/.exec(txt) || [])[1], size: fs.existsSync(f) ? fs.statSync(f).size : 0 };
    };
    const r = {}; for (const [k, f] of Object.entries(files)) r[k] = look(f);
    const nfps = stats.map(s => s.cams && s.cams.N ? s.cams.N.fps : 0);
    console.log('network source fps by second:', nfps.join(' '), '· status', status.N);
    console.log('exits', JSON.stringify(exits), '· files', JSON.stringify(r));
    if (said.length) console.log('encoders said:', said.slice(0, 6).join(' | '));
    if (Math.max(...nfps) < 25) fail('the SRT source never delivered its picture');
    for (const k of Object.keys(files)) if (exits[k] !== 0) fail(`${k} did not finish cleanly`);
    if (r.isoA.codec !== 'prores' || r.isoN.codec !== 'mjpeg') fail('ISO codecs are not ProRes / MJPEG');
    if (r.isoA.timecode !== tc || r.isoN.timecode !== tc) fail('ISO files are missing their timecode');
    const n = [r.rec.frames, r.isoA.frames, r.isoN.frames];
    if (Math.min(...n) < 300) fail(`too few frames ${n}`);
    if (Math.max(...n) - Math.min(...n) > 3) fail(`the files did not start together (frames ${n})`);
    console.log(`OK   network source + ISO (${n.join(' / ')} frames, timecode ${tc})`);
    process.exit(0);
  });
};
