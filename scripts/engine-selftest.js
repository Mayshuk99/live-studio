// Build-time check of the native engine on the real platform: a fake camera, a fade, a graphic, sound,
// and a recording made through the engine with the program's own encoder options. Stops the build if
// anything does not work, instead of finding out at a service.
'use strict';
const fs = require('fs'), os = require('os'), path = require('path');
const { NativeEngine, engineCoded } = require('../native-engine');
const { recordArgs } = require('../streamer');
const exe = process.argv[2], ff = process.argv[3] || 'ffmpeg';
// (lets the engine use its stand-in encoder — x264 in a pipe — so "encoded inside the engine" is checked without an NVIDIA card)
process.env.LS_ENGINE_TEST_ENC = '1'; process.env.LS_ENGINE_TEST_FFMPEG = ff;
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
// sound like the program's sound thread makes it: exactly as many samples as time has passed. When this script is held up
// (a timer that fires late, a big buffer being built) the missing sound follows in one piece — late, but nothing is lost.
let audT0 = 0, audSent = 0;
const aud = setInterval(() => {
  const now = Date.now(); if (!audT0) audT0 = now - 10;
  const n = Math.min(48000, Math.round((now - audT0) * 48) - audSent); if (n <= 0) return;
  const f = new Float32Array(n * 2); for (let i = 0; i < n; i++) { f[i * 2] = f[i * 2 + 1] = 0.2 * Math.sin(ph); ph += 2 * Math.PI * 440 / 48000; }
  audSent += n; e.send({ cmd: 'audio', rate: 48000, ch: 2 }, f);
}, 10);
const at = (s, fn) => setTimeout(fn, s * 1000);
const part = path.join(dir, 'rec.mp4');
at(1, () => e.send({ cmd: 'program', base: { src: 'A' }, ms: 500 }));
at(1.5, () => e.send({ cmd: 'output-start', id: 'r1', args: recordArgs({ engine: true, encoder: 'x264', fps: 59.94, width: W, height: H, bitrate: 3000 }, part).map(a => a === 'veryfast' ? 'ultrafast' : a) }));
// a second recording, encoded inside the engine (the stand-in): FFmpeg gets ready-made H.264 and only copies it next to the sound
const part2 = path.join(dir, 'rec2.mp4'), o2 = { kind: 'record', engine: true, encoder: 'nvenc', fps: 59.94, width: W, height: H, bitrate: 3000 };
let started2 = null, exited2 = null;
e.on('msg', h => { if (h.ev === 'out-started' && h.id === 'r2') started2 = h; else if (h.ev === 'out-exit' && h.id === 'r2') exited2 = h; });
at(2, () => e.send({ cmd: 'output-start', id: 'r2', args: recordArgs(Object.assign({}, o2, { encoder: 'x264' }), part2).map(a => a === 'veryfast' ? 'ultrafast' : a),
  enc: { kind: 'x264pipe', kbps: 3000, maxKbps: 3000, bufKbps: 6000, gop: 60, preset: 4, profile: 'high', cbr: true, tune: 'll' }, encArgs: recordArgs(Object.assign({}, o2, { coded: true }), part2), soundSkipMs: engineCoded.soundSkipMs(o2) }));
at(6, () => e.send({ cmd: 'output-stop', id: 'r2' }));
at(2.5, () => e.send({ cmd: 'overlay', id: 'g', sw: ow, sh: oh, x: 40, y: H - 120, w: ow, h: oh, premult: false, visible: true, fadeMs: 200, z: 10 }, px));
at(3.5, () => e.send({ cmd: 'black', on: true, ms: 300 }));
at(6, () => e.send({ cmd: 'output-stop', id: 'r1' }));
// a video file on air (decoded on the graphics card when there is one — this build machine has none, so the processor)
const vid = path.join(dir, 'clip.mp4');
require('child_process').execFileSync(ff, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30', '-t', '4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', vid]);
let vidPos = 0;
let vidRep = 0, vidPid = 0, camPid = 0;
e.on('msg', h => { if (h.ev === 'stats' && h.videos && h.videos.v1) { vidPos = Math.max(vidPos, h.videos.v1.pos || 0); if (h.videos.v1.playing && vidPos > 0.5 && vidPos < 3.5) vidRep += h.videos.v1.repeats || 0; vidPid = vidPid || h.videos.v1.pid; } if (h.ev === 'stats' && h.cams && h.cams.A) camPid = camPid || h.cams.A.pid; });
at(6.5, () => { e.send({ cmd: 'video', id: 'v1', path: vid, name: 'Test clip', loop: false }); e.send({ cmd: 'video-state', id: 'v1', playing: true, t: 0 }); e.send({ cmd: 'program', base: { src: 'v1' }, ms: 0 }); });
// big graphics while the sound runs (three 4K pictures at once, as when a slide and two graphics are prepared): the sound must not gap.
// Sound has its own line to the engine and pictures are prepared on a thread of their own (engine/main.go), with 0.4 s of sound in reserve.
let gaps = 0, gapsBig = 0, bigOn = false, bigGot = 0;
e.on('msg', h => { if (h.ev === 'stats') { gaps += h.audioUnder || 0; if (bigOn) gapsBig += h.audioUnder || 0; } });
const big = new Uint8Array(3840 * 2160 * 4); for (let i = 0; i < big.length; i += 4) { big[i] = i & 255; big[i + 3] = 255; }
at(8.5, () => { bigOn = true; for (const id of ['b1', 'b2', 'b3']) e.send({ cmd: 'overlay', id, sw: 3840, sh: 2160, x: 0, y: 0, w: W, h: H, premult: false, visible: false, fadeMs: 200, z: 5 }, big); e.send({ cmd: 'still', id: 'last', w: 64, h: 36 }, new Uint8Array(64 * 36 * 4)); bigGot = Date.now(); });
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
  const vidLine = videoLog.find(l => /Test clip: h264 1280×720 30 fps · .*decoded/.test(l));
  console.log(`video file: played to ${vidPos.toFixed(2)} s · ${vidRep} pictures late · process ${vidPid} · camera process ${camPid} · ${vidLine || 'no info line'}`);
  if (!vidLine || vidPos < 2) fail('the video file did not play through the engine');
  if (!/each picture shown twice/.test(vidLine)) fail('a 30 fps video in a 59.94 program should come at half the rate');
  if (!vidPid || !camPid) fail('the engine did not report its processes');
  if (pv < 100 || pvBad || pvFlat > pv / 10) fail(`camera pictures for the window: ${pv} good, ${pvBad} wrong, ${pvFlat} flat`);
  console.log(`sound: ${gaps} gaps in all, ${gapsBig} while three 4K graphics were prepared`);
  if (gapsBig) fail(`the sound had ${gapsBig} gap(s) while big graphics were prepared`);
  if (!exited || exited.code !== 0) fail('recording did not finish cleanly');
  if (size < 20000) fail(`recording too small (${size} bytes)`);
  // the recording encoded inside the engine: every picture there, evenly spaced, with sound
  const cp = require('child_process');
  const crc = (file, map) => cp.spawnSync(ff, ['-hide_banner', '-loglevel', 'error', '-i', file, '-map', map, '-c', 'copy', '-f', 'framecrc', '-'], { encoding: 'utf8', maxBuffer: 64 << 20 }).stdout || '';
  const vOut = crc(part2, '0:v:0'), tb = (/#tb 0: (\d+)\/(\d+)/.exec(vOut) || [0, 1, 1]).slice(1).map(Number);
  const pts = vOut.split(/\r?\n/).filter(l => /^\s*0,/.test(l)).map(l => +l.split(',')[2] * tb[0] / tb[1]);
  const aN = crc(part2, '0:a:0').split(/\r?\n/).filter(l => /^\s*0,/.test(l)).length;
  let uneven = 0; for (let i = 2; i < pts.length; i++) if (Math.abs(pts[i] - pts[i - 1] - 1001 / 60000) > 0.0005) uneven++; // (the first picture may sit a sound frame early)
  console.log(`encoded inside the engine: by ${started2 && started2.enc} · exit ${exited2 && exited2.code} · ${pts.length} pictures, ${uneven} unevenly spaced, ${(pts[pts.length - 1] || 0).toFixed(2)} s · ${aN} pieces of sound`);
  if (!started2 || !/stand-in/.test(started2.enc || '')) fail('the second recording was not encoded inside the engine');
  if (!exited2 || exited2.code !== 0) fail('the recording encoded inside the engine did not finish cleanly');
  // (it runs for 4 s; a slow build machine needs up to a second of that to start the two FFmpegs)
  if (pts.length < 120 || uneven || aN < 60) fail(`the recording encoded inside the engine is not right (${pts.length} pictures, ${uneven} uneven, ${aN} pieces of sound)`);
  // the encoder's own test (run by the engine before it uses the card's encoder): passes with a good encoder, catches swapped colours,
  // and with the real NVIDIA encoder either passes or says there is none here — never a crash
  const probe = (env, args) => { const r = cp.spawnSync(exe, ['--nvenc-test', ...args], { encoding: 'utf8', env: Object.assign({}, process.env, env), timeout: 30000 }); let j = null; try { j = JSON.parse((r.stdout || '').trim().split(/\r?\n/).pop()); } catch (x) { /* */ } return { code: r.status, j }; };
  const good = probe({ LS_ENGINE_TEST_KIND: 'x264pipe' }, ['1280', '720', '60000', '1001', ff]), bad = probe({ LS_ENGINE_TEST_KIND: 'x264pipe', LS_ENGINE_TEST_MIXUP: '1' }, ['1280', '720', '60000', '1001', ff]);
  const real = probe({ LS_ENGINE_TEST_ENC: '' }, ['1920', '1080', '60000', '1001', ff]);
  console.log(`encoder test: good encoder → ${JSON.stringify(good.j)} · colours swapped → ${bad.j && bad.j.error} · NVIDIA here → ${JSON.stringify(real.j)} (code ${real.code})`);
  if (good.code !== 0 || !good.j || !good.j.ok || good.j.frames !== 30) fail('the encoder test does not pass a good encoder');
  if (bad.code !== 1 || !bad.j || bad.j.ok) fail('the encoder test does not catch swapped colours');
  if (!real.j || ![0, 1, 2].includes(real.code) || (real.code === 0) !== !!real.j.ok) fail(`the NVIDIA encoder test ended badly (code ${real.code})`);
  console.log(`OK   native engine (recording ${size} bytes)`);
  process.exit(0);
});
