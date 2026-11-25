/* Live Studio — test of the VST3 plug-in host (ls-vst) with the VST 3 SDK's own sample plug-ins.
 * Run by the Windows build: the release is not made unless this passes.
 *   node scripts/vst-selftest.js <ls-vst(.exe)> <folder with adelay.vst3 and mda-vst3.vst3>
 * Checks: scanning, loading, processing (an echo exactly where ADelay puts it, a limiter that limits), bypass,
 * the order of the chain, saving and restoring a plug-in's settings, bad paths, and a clean exit.
 */
'use strict';
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { scan } = require('../vst-host');

const [exe, root] = process.argv.slice(2);
if (!exe || !root) { console.error('usage: node scripts/vst-selftest.js <ls-vst> <plug-in folder>'); process.exit(2); }
const fails = [];
const check = (ok, what) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`); if (!ok) fails.push(what); };
const find = name => { const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.name === name) return p; if (e.isDirectory() && !/\.vst3$/i.test(e.name)) { const r = walk(p); if (r) return r; } } return null; }; return walk(root); };
const AD = find('adelay.vst3'), MDA = find('mda-vst3.vst3');
console.log('ADelay :', AD); console.log('mda    :', MDA);
if (!AD || !MDA) { console.error('sample plug-ins not found'); process.exit(1); }

(async () => {
  // scanning (one module at a time, as Live Studio does it)
  const one = execFileSync(exe, ['--scan-one', AD], { encoding: 'utf8', timeout: 30000, windowsHide: true });
  check(/^class\t0CDBB66985D548A9BFD8371909D24BB3\tADelay\t/m.test(one) && /^done$/m.test(one), 'scan one module lists ADelay');
  const cacheFile = path.join(require('os').tmpdir(), `ls-vst-scan-${process.pid}.json`);
  const sc = await scan(exe, [path.dirname(AD), path.dirname(MDA)], cacheFile, true);
  const lim = sc.plugins.find(p => p.name === 'mda Limiter');
  check(sc.plugins.length >= 20 && !!lim, `scan of the folder: ${sc.plugins.length} plug-ins, mda Limiter among them`);
  let bad = '';
  try { bad = execFileSync(exe, ['--scan-one', path.join(root, 'no-such.vst3')], { encoding: 'utf8', timeout: 30000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }); } catch (e) { bad = String(e.stdout || ''); }
  check(/^error\t/m.test(bad), 'scan of a missing file reports an error (no crash)');

  // the host, driven like the main process drives it
  const p = spawn(exe, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let buf = Buffer.alloc(0); const waiters = [], evs = [];
  p.stderr.on('data', d => process.stdout.write('  (host stderr) ' + d));
  p.stdout.on('data', d => {
    buf = Buffer.concat([buf, d]);
    for (;;) {
      if (buf.length < 8) break;
      const hl = buf.readUInt32LE(0), pl = buf.readUInt32LE(4);
      if (buf.length < 8 + hl + pl) break;
      const f = buf.toString('utf8', 8, 8 + hl).split('\t'), pay = Buffer.from(buf.subarray(8 + hl, 8 + hl + pl));
      buf = buf.subarray(8 + hl + pl); evs.push(f);
      const w = waiters.findIndex(x => x.ev === f[0] && (!x.id || x.id === f[1]));
      if (w >= 0) waiters.splice(w, 1)[0].res({ f, pay });
    }
  });
  const send = (fields, payload) => { const h = Buffer.from(fields.join('\t')); const pre = Buffer.alloc(8); pre.writeUInt32LE(h.length, 0); pre.writeUInt32LE(payload ? payload.length : 0, 4); p.stdin.write(Buffer.concat([pre, h, payload || Buffer.alloc(0)])); };
  const wait = (ev, id, ms = 15000) => new Promise((res, rej) => { const w = { ev, id, res }; waiters.push(w); setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) { waiters.splice(i, 1); rej(new Error(`no "${ev}" from the host within ${ms} ms`)); } }, ms); });
  let seq = 0;
  async function proc(frames, gen) {
    const f = new Float32Array(frames * 2);
    for (let i = 0; i < frames; i++) { const v = gen(i); f[i * 2] = v; f[i * 2 + 1] = v; }
    const w = wait('audio', String(seq)); send(['audio', String(seq), String(frames)], Buffer.from(f.buffer)); seq++;
    const r = await w; const out = new Float32Array(frames * 2); Buffer.from(out.buffer).set(r.pay); out.lat = +r.f[3]; return out;
  }
  const peak = a => a.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  try {
    await wait('ready');
    send(['init', '48000', '512']);
    let o = await proc(256, i => 0.5 * Math.sin(i / 10));
    check(Math.abs(o[40] - 0.5 * Math.sin(2)) < 1e-6 && o.lat === 0, 'no plug-ins: the sound passes unchanged');

    send(['load', 'lim', lim.path, lim.cid]);
    const L = await wait('loaded', 'lim');
    check(L.f[2] === '1', `load mda Limiter (${L.f.slice(3).join(' | ')})`);
    let pk = 0; for (let k = 0; k < 40; k++) { o = await proc(512, i => 0.99 * Math.sin((k * 512 + i) / 8)); if (k > 20) pk = Math.max(pk, peak(o)); }
    check(pk < 0.8, `the limiter limits: peak 0.99 → ${pk.toFixed(3)}`);
    const settle = () => new Promise(r => setTimeout(r, 200)); // commands are applied by the host's window thread, the sound runs on its own
    send(['bypass', 'lim', '1']); await settle(); o = await proc(512, i => 0.99 * Math.sin(i / 8));
    check(Math.abs(peak(o) - 0.99) < 0.02, 'bypass: the sound passes unchanged');
    send(['bypass', 'lim', '0']);

    send(['load', 'dly', AD, '0CDBB66985D548A9BFD8371909D24BB3']);
    check((await wait('loaded', 'dly')).f[2] === '1', 'load ADelay');
    send(['order', 'dly']); await settle();
    let echoAt = -1, n = 0;
    for (let k = 0; k < 120 && echoAt < 0; k++) { o = await proc(512, i => (k === 0 && i === 0) ? 1 : 0); for (let i = 0; i < 512; i++) if (Math.abs(o[i * 2]) > 0.05 && (k > 0 || i > 0)) { echoAt = n + i; break; } n += 512; }
    check(echoAt === 48000, `ADelay's echo comes exactly 1 s later (${echoAt} samples)`);

    const sw = wait('state', 'lim'); send(['get-state', 'lim']); const st = await sw;
    check(st.pay.length > 8, `the limiter's settings can be saved (${st.pay.length} bytes)`);
    send(['load', 'lim2', lim.path, lim.cid], st.pay);
    check((await wait('loaded', 'lim2')).f[2] === '1', 'a plug-in loads again with saved settings');

    send(['order', 'lim', 'dly']);
    send(['load', 'bad', path.join(root, 'no-such.vst3'), 'AAAA']);
    check((await wait('loaded', 'bad')).f[2] === '0', 'a missing plug-in file is refused (no crash)');
    send(['load', 'bad2', lim.path, '00000000000000000000000000000000']);
    check((await wait('loaded', 'bad2')).f[2] === '0', 'a plug-in that is no longer in its file is refused');
    send(['edit', 'lim']);
    check(['none', 'open'].includes((await wait('editor', 'lim')).f[2]), 'asking for a plug-in window answers');
    send(['close-edit', 'lim']);

    const t0 = Date.now(); for (let k = 0; k < 1875; k++) await proc(256, i => 0.3 * Math.sin(i));
    const ms = Date.now() - t0;
    check(ms < 5000, `10 s of sound through 2 plug-ins in 256-sample blocks took ${ms} ms`);
    send(['unload', 'lim2']); await wait('unloaded', 'lim2');
    const code = await new Promise(res => { p.on('exit', c => res(c)); send(['quit']); setTimeout(() => res('timeout'), 10000); });
    check(code === 0, `the host quits cleanly (exit ${code})`);
  } catch (e) {
    check(false, e.message);
    try { p.kill(); } catch (err) { /* */ }
  }
  try { fs.unlinkSync(cacheFile); } catch (e) { /* */ }
  console.log(fails.length ? `\n${fails.length} check(s) failed` : '\nall checks passed');
  process.exit(fails.length ? 1 : 0);
})();
