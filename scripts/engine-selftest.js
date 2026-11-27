// Build-time check of the native engine on the real platform: a fake camera, a fade, a graphic, sound,
// and a recording made through the engine with the program's own encoder options. Stops the build if
// anything does not work, instead of finding out at a service.
'use strict';
const fs = require('fs'), os = require('os'), path = require('path');
const { NativeEngine } = require('../native-engine');
const { recordArgs } = require('../streamer');
const exe = process.argv[2], ff = process.argv[3] || 'ffmpeg';
const W = 1280, H = 720;
if (process.argv[4] === '--iso-net') { require('./engine-selftest-isonet')(exe, ff); return; }
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ls-engine-test-'));
const e = new NativeEngine();
const stats = []; let exited = null, ready = false, camOk = false, outLines = [], pv = 0, pvBad = 0, pvFlat = 0;
const videoLog = [];
const PW = 640, PH = 360; // the window's camera pictures (YUV 4:2:0, see engine/preview.go)
e.on('msg', (h, payload) => {
  if (h.ev === 'cam-frame') {
    if (h.fmt !== 'yuv' || h.w !== PW || h.h !== PH || !payload || payload.length !== PW * PH * 3 / 2) pvBad++;
    else { pv++; let lo = 255, hi = 0; for (let i = 0; i < PW * PH; i += 97) { lo = Math.min(lo, payload[i]); hi = Math.max(hi, payload[i]); } if (hi - lo < 40) pvFlat++; }
  } else if (h.ev === 'ready') ready = true;
  else if (h.ev === 'stats') stats.push(h);
  else if (h.ev === 'cam-status' && h.ok) camOk = true;
  else if (h.ev === 'out-exit') exited = h;
  else if (h.ev === 'out-log' && !/^frame=/.test(h.line)) outLines.push(h.line);
  else if (h.ev === 'log') { console.log('engine:', h.line); if (/^video /.test(h.line)) videoLog.push(h.line); }
});
const fail = msg => { console.error('FAIL', msg); process.exit(1); };
if (!e.start(exe, { w: W, h: H, fpsNum: 60000, fpsDen: 1001, ffmpeg: ff })) fail('engine did not start');
e.send({ cmd: 'camera', id: 'A', args: ['-re', '-f', 'lavfi', '-i', `testsrc2=size=${W}x${H}:rate=60000/1001`] });
e.send({ cmd: 'preview', cam: { w: PW, h: PH, every: 2, fmt: 'yuv' }, cams: ['A'], pgm: { w: 0, h: 0, every: 0 } });
const ow = 400, oh = 80, px = new Uint8Array(ow * oh * 4).fill(200);
let ph = 0;
const aud = setInterval(() => { const n = 480, f = new Float32Array(n * 2); for (let i = 0; i < n; i++) { f[i * 2] = f[i * 2 + 1] = 0.2 * Math.sin(ph); ph += 2 * Math.PI * 440 / 48000; } e.send({ cmd: 'audio', rate: 48000, ch: 2 }, f); }, 10);
const at = (s, fn) => setTimeout(fn, s * 1000);
const part = path.join(dir, 'rec.mp4');
at(1, () => e.send({ cmd: 'program', base: { src: 'A' }, ms: 500 }));
at(1.5, () => e.send({ cmd: 'output-start', id: 'r1', args: recordArgs({ engine: true, encoder: 'x264', fps: 59.94, width: W, height: H, bitrate: 3000 }, part).map(a => a === 'veryfast' ? 'ultrafast' : a) }));
at(2.5, () => e.send({ cmd: 'overlay', id: 'g', sw: ow, sh: oh, x: 40, y: H - 120, w: ow, h: oh, premult: false, visible: true, fadeMs: 200, z: 10 }, px));
at(3.5, () => e.send({ cmd: 'black', on: true, ms: 300 }));
at(6, () => e.send({ cmd: 'output-stop', id: 'r1' }));
// a video file on air (decoded on the graphics card when there is one — this build machine has none, so the processor)
const vid = path.join(dir, 'clip.mp4');
require('child_process').execFileSync(ff, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30', '-t', '4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', vid]);
let vidPos = 0;
e.on('msg', h => { if (h.ev === 'stats' && h.videos && h.videos.v1) vidPos = Math.max(vidPos, h.videos.v1.pos || 0); });
at(6.5, () => { e.send({ cmd: 'video', id: 'v1', path: vid, name: 'Test clip', loop: false }); e.send({ cmd: 'video-state', id: 'v1', playing: true, t: 0 }); e.send({ cmd: 'program', base: { src: 'v1' }, ms: 0 }); });
at(12, async () => {
  clearInterval(aud);
  await e.stop();
  const ticks = stats.reduce((a, s) => a + s.ticks, 0);
  console.log(`ready ${ready} · camera ${camOk} · ${stats.length} stats · ${ticks} frames · recording exit ${exited && exited.code} · window pictures ${pv} (${pvBad} wrong, ${pvFlat} flat)`);
  if (outLines.length) console.log('encoder said:', outLines.slice(0, 5).join(' | '));
  const size = fs.existsSync(part) ? fs.statSync(part).size : 0;
  if (!ready) fail('engine never became ready');
  if (!camOk) fail('fake camera never delivered');
  if (ticks < 400) fail(`too few frames (${ticks})`);
  const vidLine = videoLog.find(l => /Test clip: h264 1280×720 30 fps · decoded/.test(l));
  console.log(`video file: played to ${vidPos.toFixed(2)} s · ${vidLine || 'no info line'}`);
  if (!vidLine || vidPos < 2) fail('the video file did not play through the engine');
  if (pv < 100 || pvBad || pvFlat > pv / 10) fail(`camera pictures for the window: ${pv} good, ${pvBad} wrong, ${pvFlat} flat`);
  if (!exited || exited.code !== 0) fail('recording did not finish cleanly');
  if (size < 20000) fail(`recording too small (${size} bytes)`);
  console.log(`OK   native engine (recording ${size} bytes)`);
  process.exit(0);
});
