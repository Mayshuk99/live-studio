/* Live Studio — VST3 plug-ins on the Master channel (runs in the main process).
 * Starts ls-vst (the plug-in host), scans for plug-ins, and passes commands, events and sound.
 * Messages both ways: [u32 header length][u32 payload length][header: tab-separated fields][payload]
 */
'use strict';
const { spawn, execFile } = require('child_process');
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');

function vstExe(app) {
  const exe = process.platform === 'win32' ? 'ls-vst.exe' : 'ls-vst';
  const c = [];
  if (app && app.isPackaged) c.push(path.join(process.resourcesPath, 'vst', exe));
  c.push(path.join(__dirname, 'resources', 'vst', exe), path.join(__dirname, 'vsthost', 'build', exe), path.join(__dirname, 'vsthost', 'build', 'Release', exe));
  return c.find(p => { try { return fs.statSync(p).isFile(); } catch (e) { return false; } }) || null;
}

// where Windows keeps VST3 plug-ins (the standard places), plus any folders the user added
function vstFolders(extra) {
  const f = [];
  if (process.platform === 'win32') {
    f.push(path.join(process.env.CommonProgramFiles || 'C:\\Program Files\\Common Files', 'VST3'));
    if (process.env.LOCALAPPDATA) f.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'Common', 'VST3'));
  }
  if (process.env.LS_VST_PATH) f.push(...process.env.LS_VST_PATH.split(path.delimiter));
  for (const x of extra || []) if (x && !f.includes(x)) f.push(x);
  return f;
}

// every .vst3 (a bundle folder or a single file) under the folders; bundles are not searched inside
function findModules(folders) {
  const out = [];
  const walk = (dir, depth) => {
    let list; try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const d of list) {
      const p = path.join(dir, d.name);
      if (/\.vst3$/i.test(d.name)) out.push(p);
      else if (d.isDirectory() && depth < 6) walk(p, depth + 1);
    }
  };
  for (const f of new Set(folders.map(x => path.resolve(x)))) walk(f, 0);
  return [...new Set(out)];
}

function scanOne(exe, mod, ms = 30000) {
  return new Promise(resolve => {
    execFile(exe, ['--scan-one', mod], { windowsHide: true, timeout: ms, maxBuffer: 8 << 20 }, (err, stdout) => {
      const classes = [], errors = [];
      for (const line of String(stdout || '').split(/\r?\n/)) {
        const f = line.split('\t');
        if (f[0] === 'class' && f.length >= 4) classes.push({ path: mod, cid: f[1], name: f[2], vendor: f[3], sub: f[4] || '', version: f[5] || '' });
        else if (f[0] === 'error') errors.push(f.slice(1).join(' '));
      }
      if (err && err.killed) errors.push('took too long to open (skipped)');
      else if (err && !classes.length && !errors.length) errors.push(`could not be opened (${err.code || err.message})`);
      resolve({ classes, errors });
    });
  });
}

/* scan, remembering modules that have not changed since the last scan */
async function scan(exe, folders, cacheFile, force, progress) {
  // (a Waves shell holds hundreds of plug-ins and can take a while the first time)
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch (e) { /* first time */ }
  const mods = findModules(folders), next = {}, plugins = [], problems = [];
  let i = 0;
  for (const m of mods) {
    i++;
    let st = null; try { st = fs.statSync(m); } catch (e) { continue; }
    const key = `${st.mtimeMs}|${st.size}`, c = cache[m];
    let r;
    if (!force && c && c.key === key) r = c;
    else {
      if (progress) progress({ i, n: mods.length, module: path.basename(m) });
      const s = await scanOne(exe, m, /waveshell/i.test(path.basename(m)) ? 180000 : 45000);
      r = { key, classes: s.classes, errors: s.errors };
    }
    next[m] = r;
    plugins.push(...r.classes);
    for (const e of r.errors) problems.push(`${path.basename(m)}: ${e}`);
  }
  try { fs.writeFileSync(cacheFile, JSON.stringify(next)); } catch (e) { /* */ }
  return { plugins, problems, folders, modules: mods.length };
}

class VstHost extends EventEmitter {
  constructor() { super(); this.proc = null; this.buf = Buffer.alloc(0); this.ready = false; }
  start(exe) {
    if (this.proc) return true;
    let p;
    try { p = spawn(exe, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); } catch (e) { this.emit('msg', ['host-exit', '-1', e.message]); return false; }
    this.proc = p; this.ready = false; this.buf = Buffer.alloc(0);
    p.stdin.on('error', () => {});
    p.stdout.on('data', d => this._data(d));
    p.stderr.on('data', d => { const t = String(d).trim(); if (t) this.emit('msg', ['log', 'plug-in says: ' + t.slice(0, 300)]); });
    p.on('error', e => this.emit('msg', ['host-exit', '-1', e.message]));
    p.on('exit', code => { this.proc = null; this.ready = false; this.emit('msg', ['host-exit', String(code)]); });
    return true;
  }
  _data(d) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    for (;;) {
      if (this.buf.length < 8) return;
      const hl = this.buf.readUInt32LE(0), pl = this.buf.readUInt32LE(4);
      if (this.buf.length < 8 + hl + pl) return;
      const f = this.buf.toString('utf8', 8, 8 + hl).split('\t');
      const payload = pl ? Buffer.from(this.buf.subarray(8 + hl, 8 + hl + pl)) : null;
      this.buf = this.buf.subarray(8 + hl + pl);
      if (!this.buf.length) this.buf = Buffer.alloc(0);
      if (f[0] === 'ready') this.ready = true;
      this.emit('msg', f, payload);
    }
  }
  send(fields, payload) {
    const p = this.proc;
    if (!p || !p.stdin.writable) return false;
    const h = Buffer.from(fields.map(x => String(x).replace(/[\t\r\n]/g, ' ')).join('\t'));
    const pb = payload ? Buffer.from(payload.buffer ? payload.buffer : payload, payload.byteOffset || 0, payload.byteLength !== undefined ? payload.byteLength : payload.length) : null;
    const pre = Buffer.alloc(8); pre.writeUInt32LE(h.length, 0); pre.writeUInt32LE(pb ? pb.length : 0, 4);
    p.stdin.write(pb ? Buffer.concat([pre, h, pb]) : Buffer.concat([pre, h]));
    return true;
  }
  get backlog() { return this.proc ? this.proc.stdin.writableLength : 0; }
  stop() {
    const p = this.proc;
    if (!p) return Promise.resolve();
    return new Promise(resolve => {
      const t = setTimeout(() => { try { p.kill(); } catch (e) { /* */ } resolve(); }, 5000);
      p.once('exit', () => { clearTimeout(t); resolve(); });
      this.send(['quit']);
    });
  }
}

module.exports = { VstHost, vstExe, vstFolders, findModules, scan, scanOne };
