// NDI end to end (needs the NDI Runtime on the computer): the helper sends a test picture, finds it on the network,
// receives it, and the native engine shows it as a camera. Run by the build only when the runtime could be installed.
'use strict';
const { spawn, execFileSync } = require('child_process');
const { NativeEngine } = require('../native-engine');
const [ndi, engExe, ff] = process.argv.slice(2);
const fail = msg => { console.error('FAIL', msg); process.exit(1); };
const wait = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  console.log('NDI runtime:', execFileSync(ndi, ['--version']).toString().trim());
  const sender = spawn(ndi, ['--send', 'LS TEST', '--w', '640', '--h', '360', '--fps', '30', '--seconds', '40'], { stdio: ['ignore', 'ignore', 'inherit'] });
  await wait(3000);
  const list = JSON.parse(execFileSync(ndi, ['--list', '5000']).toString());
  console.log('found:', JSON.stringify(list));
  const src = (list.sources || []).find(s => /\(LS TEST\)$/.test(s.name));
  if (!src) fail('the test source was not found on the network');
  // the helper alone: frames of the asked size on its output
  // (connecting takes a moment: counted from the first frame on)
  const FB = 640 * 360 * 1.5, t0 = Date.now();
  const rx = spawn(ndi, ['--recv', src.name, '--w', '640', '--h', '360'], { stdio: ['ignore', 'pipe', 'inherit'] });
  let bytes = 0, firstAt = 0; rx.stdout.on('data', d => { bytes += d.length; if (!firstAt && bytes >= FB) firstAt = Date.now(); });
  for (let i = 0; i < 150 && !firstAt; i++) await wait(100);
  if (!firstAt) { rx.kill(); fail('no NDI frame within 15 s'); }
  const b0 = bytes; await wait(5000); rx.kill();
  const frames = Math.floor((bytes - b0) / FB);
  console.log(`helper: first frame after ${((firstAt - t0) / 1000).toFixed(1)} s, then ${frames} frames in 5 s (the source sends 30 a second)`);
  if (frames < 120) fail('too few NDI frames');
  // through the engine, as a camera
  const e = new NativeEngine(); const fps = []; let ok = false;
  e.on('msg', h => { if (h.ev === 'cam-status' && h.ok) ok = true; if (h.ev === 'stats' && h.cams && h.cams.D) fps.push(h.cams.D.fps); if (h.ev === 'log') console.log('engine:', h.line); });
  if (!e.start(engExe, { w: 1280, h: 720, fpsNum: 60000, fpsDen: 1001, ffmpeg: ff })) fail('engine did not start');
  e.send({ cmd: 'camera', id: 'D', exe: ndi, args: ['--recv', src.name], free: true, w: 1280, h: 720 });
  await wait(12000);
  await e.stop(); sender.kill();
  console.log('engine camera fps by second:', fps.join(' '));
  if (!ok || Math.max(0, ...fps) < 20) fail('the engine did not get the NDI picture');
  console.log('OK   NDI end to end');
  process.exit(0);
})().catch(e => fail(e.message));
