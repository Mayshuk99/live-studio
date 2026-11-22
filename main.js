/* Live Studio — desktop app (Electron main process) */
'use strict';
const { app, BrowserWindow, ipcMain, dialog, session, shell, safeStorage, powerSaveBlocker, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const http = require('http');
const crypto = require('crypto');
const { OutputManager } = require('./streamer');

let autoUpdater = null;
try { autoUpdater = require('electron-updater').autoUpdater; } catch (e) { /* dev without updater */ }

// keep video running smoothly even when the window is covered or minimised
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('force_high_performance_gpu');

if (!app.requestSingleInstanceLock()) { app.quit(); }

const userDir = () => app.getPath('userData');
const showFile = () => path.join(userDir(), 'current-show.json');
const settingsFile = () => path.join(userDir(), 'settings.json');

function ffmpegPath() {
  const custom = readJSON(settingsFile(), {}).ffmpegPath;
  if (custom && fs.existsSync(custom)) return custom;
  const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const candidates = [
    path.join(process.resourcesPath || '', 'ffmpeg', exe),
    path.join(__dirname, 'resources', 'ffmpeg', exe)
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return exe; // fall back to PATH
}

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
}
function writeJSON(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}

let win = null;
let isLive = false;
let blocker = null;
const outputs = new OutputManager(ffmpegPath());
outputs.on('event', ev => { if (win && !win.isDestroyed()) win.webContents.send('out:event', ev); updateBlocker(); });

function updateBlocker() {
  const need = outputs.active;
  if (need && blocker === null) blocker = powerSaveBlocker.start('prevent-display-sleep');
  if (!need && blocker !== null) { powerSaveBlocker.stop(blocker); blocker = null; }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1680, height: 1000, minWidth: 1100, minHeight: 700,
    backgroundColor: '#0b0e14',
    title: 'Live Studio',
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false
    }
  });
  Menu.setApplicationMenu(null);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.maximize();

  win.webContents.on('will-navigate', e => e.preventDefault());
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') win.webContents.toggleDevTools();
    if (input.type === 'keyDown' && input.key === 'F11') win.setFullScreen(!win.isFullScreen());
  });

  // hidden web-overlay pages must not keep the app running after the main window closes
  win.on('closed', () => { for (const id of [...webPages.keys()]) webClose(id); app.quit(); });
  win.on('close', e => {
    if (closeOK) return;
    const live = isLive || outputs.active;
    if (live) {
      const r = dialog.showMessageBoxSync(win, {
        type: 'warning', buttons: ['Keep streaming', 'End stream and quit'], defaultId: 0, cancelId: 0,
        title: 'You are live', message: 'You are live or recording right now.', detail: 'Quitting will end the stream and finish the recording.'
      });
      if (r === 0) { e.preventDefault(); return; }
    }
    const save = askSave();
    if (save === 'cancel') { e.preventDefault(); return; }
    if (!live && save === 'no') return;
    e.preventDefault();
    (async () => {
      if (save === 'yes' && !(await saveFromWindow())) {
        const r = dialog.showMessageBoxSync(win, { type: 'error', buttons: ['Cancel', 'Close without saving'], defaultId: 0, cancelId: 0, title: 'Could not save', message: 'Your changes could not be saved.' });
        if (r === 0) return;
      }
      if (live) { await outputs.stopAll(); isLive = false; }
      closeOK = true; win.destroy();
    })();
  });
}

app.whenReady().then(() => {
  const ses = session.defaultSession;
  // allow cameras / capture cards / audio interfaces
  ses.setPermissionRequestHandler((wc, perm, cb) => cb(['media', 'fullscreen', 'clipboard-sanitized-write'].includes(perm)));
  ses.setPermissionCheckHandler((wc, perm) => ['media', 'fullscreen', 'clipboard-sanitized-write'].includes(perm));
  createWindow();
  setupUpdater();
});

app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.on('window-all-closed', () => app.quit());

/* ---------- IPC ---------- */
ipcMain.handle('app:version', () => app.getVersion());
// which FFmpeg (the encoder engine) is installed, shown in Settings → About
ipcMain.handle('app:ffmpeg', () => new Promise(resolve => {
  require('child_process').execFile(ffmpegPath(), ['-hide_banner', '-version'], { timeout: 5000, windowsHide: true }, (err, out) => {
    resolve(err ? 'not found' : String(out).split(/\r?\n/)[0].replace(/^ffmpeg version /, '').replace(/ Copyright.*$/, ''));
  });
}));
ipcMain.handle('show:load', () => readJSON(showFile(), null));
ipcMain.handle('show:save', (e, obj) => { writeJSON(showFile(), obj); return true; });

ipcMain.handle('settings:load', () => {
  const s = readJSON(settingsFile(), {});
  if (s.youtube && s.youtube.keyEnc && safeStorage.isEncryptionAvailable()) {
    try { s.youtube.key = safeStorage.decryptString(Buffer.from(s.youtube.keyEnc, 'base64')); } catch (e) { s.youtube.key = ''; }
  }
  if (s.youtube && s.youtube.clientSecretEnc && safeStorage.isEncryptionAvailable()) {
    try { s.youtube.clientSecret = safeStorage.decryptString(Buffer.from(s.youtube.clientSecretEnc, 'base64')); } catch (e) { s.youtube.clientSecret = ''; }
  }
  if (s.youtube) { delete s.youtube.keyEnc; delete s.youtube.clientSecretEnc; }
  if (!s.recordDir) s.recordDir = path.join(app.getPath('videos'), 'Live Studio');
  return s;
});
ipcMain.handle('settings:save', (e, obj) => {
  const s = JSON.parse(JSON.stringify(obj || {}));
  if (s.youtube && s.youtube.key && safeStorage.isEncryptionAvailable()) {
    s.youtube.keyEnc = safeStorage.encryptString(s.youtube.key).toString('base64');
    delete s.youtube.key;
  }
  if (s.youtube && s.youtube.clientSecret && safeStorage.isEncryptionAvailable()) {
    s.youtube.clientSecretEnc = safeStorage.encryptString(s.youtube.clientSecret).toString('base64');
    delete s.youtube.clientSecret;
  }
  writeJSON(settingsFile(), s);
  outputs.ffmpegPath = ffmpegPath();
  return true;
});

ipcMain.handle('media:pick', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Add video, picture or music', properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Video, pictures & music', extensions: ['mp4', 'mov', 'm4v', 'webm', 'mkv', 'png', 'jpg', 'jpeg', 'jfif', 'bmp', 'avif', 'webp', 'gif', 'mp3', 'wav', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'flac'] },
      { name: 'All files', extensions: ['*'] }
    ]
  });
  if (r.canceled) return [];
  return r.filePaths.map(p => ({ path: p, name: path.basename(p), size: fs.statSync(p).size }));
});
ipcMain.handle('media:read', async (e, p) => {
  const buf = await fs.promises.readFile(p);
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
});
ipcMain.handle('media:convert', (e, src) => new Promise(resolve => {
  const dir = path.join(userDir(), 'media');
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `${path.basename(src).replace(/\.[^.]+$/, '')} (converted ${Date.now().toString(36)}).mp4`);
  const p = spawn(ffmpegPath(), ['-hide_banner', '-y', '-i', src, '-map', '0:v:0', '-map', '0:a:0?',
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
    '-movflags', '+faststart', out], { windowsHide: true });
  let dur = 0, buf = '', last = -1;
  p.stderr.on('data', d => {
    buf = (buf + d.toString()).slice(-4000);
    const dm = buf.match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
    if (dm && !dur) dur = (+dm[1]) * 3600 + (+dm[2]) * 60 + (+dm[3]);
    const tm = [...buf.matchAll(/time=\s*(\d+):(\d+):([\d.]+)/g)].pop();
    if (tm && dur) {
      const pct = Math.min(99, Math.round(((+tm[1]) * 3600 + (+tm[2]) * 60 + (+tm[3])) / dur * 100));
      if (pct !== last && win && !win.isDestroyed()) { last = pct; win.webContents.send('media:progress', { src, percent: pct }); }
    }
  });
  p.on('error', err => resolve({ error: `Encoder could not start: ${err.message}` }));
  p.on('exit', code => resolve(code === 0 && fs.existsSync(out) ? { path: out } : { error: 'This file could not be converted.' }));
}));
ipcMain.handle('folder:pick', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('folder:open', (e, p) => { if (p) { try { if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); } catch (err) { /* e.g. a whole drive */ } shell.openPath(p); } });
ipcMain.handle('file:show', (e, p) => { if (p) shell.showItemInFolder(p); });

ipcMain.handle('show:export', async (e, obj) => {
  const r = await dialog.showSaveDialog(win, {
    title: 'Save show', defaultPath: `${obj.showName || 'Show'}.livestudio.json`,
    filters: [{ name: 'Live Studio show', extensions: ['json'] }]
  });
  if (r.canceled) return false;
  writeJSON(r.filePath, obj);
  return true;
});
ipcMain.handle('show:import', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Open show', filters: [{ name: 'Live Studio show', extensions: ['json'] }], properties: ['openFile'] });
  if (r.canceled) return null;
  return readJSON(r.filePaths[0], null);
});

ipcMain.handle('out:start', (e, opts) => {
  try { return { id: outputs.start(opts) }; } catch (err) { return { error: err.message }; }
});
ipcMain.on('out:data', (e, id, data) => outputs.write(id, data));
ipcMain.handle('out:stop', (e, id) => outputs.stop(id));
ipcMain.on('app:live', (e, live) => { isLive = !!live; });
// unsaved changes: the window tells us when there are some, and we ask before closing
let unsaved = false, closeOK = false;
ipcMain.on('app:dirty', (e, d) => { unsaved = !!d; if (win && !win.isDestroyed()) win.setTitle(unsaved ? 'Live Studio — unsaved changes' : 'Live Studio'); });
function askSave() {
  if (!unsaved || !win || win.isDestroyed()) return 'no';
  const r = dialog.showMessageBoxSync(win, {
    type: 'question', buttons: ['Save', "Don't save", 'Cancel'], defaultId: 0, cancelId: 2, noLink: true,
    title: 'Save changes?', message: 'Do you want to save your changes?',
    detail: 'You changed shots, slides, titles, people or settings since you last saved. If you don\'t save, those changes are lost.'
  });
  return r === 0 ? 'yes' : r === 1 ? 'no' : 'cancel';
}
function saveFromWindow() {
  return new Promise(resolve => {
    const t = setTimeout(() => { ipcMain.removeListener('app:saved', done); resolve(false); }, 10000);
    function done(e, ok) { clearTimeout(t); resolve(!!ok); }
    ipcMain.once('app:saved', done);
    win.webContents.send('app:save');
  });
}

/* ---------- PC monitoring: CPU / GPU usage and temperatures ---------- */
const os = require('os');
const { execFile } = require('child_process');
const pc = { cpu: null, cpuTemp: null, gpu: null, gpuTemp: null, gpuName: null, mem: null, started: false };
function pcStart() {
  if (pc.started) return; pc.started = true;
  let prev = os.cpus();
  setInterval(() => {
    const cur = os.cpus(); let idle = 0, total = 0;
    cur.forEach((c, i) => { const p = prev[i] ? prev[i].times : { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 }; for (const k of Object.keys(c.times)) total += c.times[k] - (p[k] || 0); idle += c.times.idle - p.idle; });
    prev = cur;
    if (total > 0) pc.cpu = Math.round(100 * (1 - idle / total));
    pc.mem = Math.round(100 * (1 - os.freemem() / os.totalmem()));
  }, 2000);
  // NVIDIA cards: exact usage and temperature from the driver's own tool
  let nvOk = true;
  const nv = () => { if (!nvOk) return; execFile('nvidia-smi', ['--query-gpu=utilization.gpu,temperature.gpu,name', '--format=csv,noheader,nounits'], { timeout: 4000, windowsHide: true }, (err, out) => {
    if (err) { nvOk = false; return; }
    const p = String(out).trim().split('\n')[0].split(',').map(x => x.trim());
    if (p.length >= 2) { pc.gpu = +p[0]; pc.gpuTemp = +p[1]; pc.gpuName = p[2] || 'NVIDIA'; pc.nv = true; }
  }); };
  nv(); setInterval(nv, 3000);
  // Windows: GPU usage for any card, and CPU temperature where the PC reports it
  if (process.platform === 'win32') {
    const script = "$ErrorActionPreference='SilentlyContinue'; while($true){ $g=''; $t=''; $s=(Get-Counter '\\GPU Engine(*)\\Utilization Percentage').CounterSamples; if($s){ $m=0; $s | Group-Object { if($_.InstanceName -match 'engtype_(\\w+)'){$matches[1]} } | ForEach-Object { $v=($_.Group | Measure-Object CookedValue -Sum).Sum; if($v -gt $m){$m=$v} }; $g=[math]::Min(100,[math]::Round($m)) }; $z=Get-CimInstance -Namespace root/wmi -ClassName MSAcpi_ThermalZoneTemperature; if($z){ $t=[math]::Round((($z | Measure-Object CurrentTemperature -Maximum).Maximum/10)-273.15) }; Write-Output ('PC|{0}|{1}' -f $g,$t); Start-Sleep -Seconds 4 }";
    try {
      const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      ps.stdout.on('data', d => { for (const line of String(d).split(/\r?\n/)) { const m = line.match(/^PC\|(\d*)\|(-?\d*)/); if (!m) continue; if (!pc.nv && m[1] !== '') pc.gpu = +m[1]; if (m[2] !== '' && +m[2] > 0 && +m[2] < 120) pc.cpuTemp = +m[2]; } });
      ps.on('error', () => {});
      app.on('before-quit', () => { try { ps.kill(); } catch (e) { /* */ } });
      if (win) win.on('closed', () => { try { ps.kill(); } catch (e) { /* */ } });
    } catch (e) { /* no powershell */ }
  }
}
ipcMain.handle('pc:stats', () => { pcStart(); return { cpu: pc.cpu, cpuTemp: pc.cpuTemp, gpu: pc.gpu, gpuTemp: pc.gpuTemp, gpuName: pc.gpuName, mem: pc.mem, cores: os.cpus().length, cpuName: (os.cpus()[0] || {}).model }; });

/* ---------- web page overlays: pages rendered off-screen (like a browser source) ---------- */
const webPages = new Map(); // id -> { win, cfg }
function webSend(ch, payload) { if (win && !win.isDestroyed()) win.webContents.send(ch, payload); }
function webClose(id) {
  const w = webPages.get(id);
  if (w) { try { w.win.destroy(); } catch (e) { /* */ } webPages.delete(id); }
}
function webOpen(id, cfg) {
  webClose(id);
  const width = Math.max(64, Math.min(3840, Math.round(cfg.width || 1920)));
  const height = Math.max(64, Math.min(2160, Math.round(cfg.height || 1080)));
  const page = new BrowserWindow({
    show: false, width, height, useContentSize: true, frame: false, transparent: true, backgroundColor: '#00000000',
    webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, partition: 'persist:web-overlays' }
  });
  const entry = { win: page, cfg };
  webPages.set(id, entry);
  const wc = page.webContents;
  wc.setAudioMuted(cfg.muted !== false);
  wc.setFrameRate(Math.max(1, Math.min(60, cfg.fps || 15)));
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  wc.on('paint', (e, dirty, image) => {
    if (webPages.get(id) !== entry) return;
    // Send only the part of the page that changed (usually a line of text) instead of the whole 1920×1080 picture.
    // The whole picture is sent first, after a resize/reload, when most of the page changed, or if the
    // picture is scaled by Windows display settings (then the changed area can't be mapped exactly).
    const size = image.getSize();
    const unscaled = size.width === width && size.height === height;
    const d = dirty || { x: 0, y: 0, width: size.width, height: size.height };
    const big = d.width * d.height > size.width * size.height * 0.4;
    // (plus a whole picture every 5 s as a safety net, so any piece that went wrong is corrected quickly)
    if (!entry.sentFull || entry.needFull || !unscaled || big || entry.w !== size.width || entry.h !== size.height || Date.now() - (entry.fullAt || 0) > 5000) {
      const buf = image.toBitmap(); // BGRA, premultiplied
      entry.sentFull = true; entry.needFull = false; entry.w = size.width; entry.h = size.height; entry.fullAt = Date.now();
      webSend('web:frame', { id, full: true, w: size.width, h: size.height, x: 0, y: 0, rw: size.width, rh: size.height, data: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength) });
      return;
    }
    const x = Math.max(0, Math.floor(d.x)), y = Math.max(0, Math.floor(d.y));
    const rw = Math.min(size.width - x, Math.ceil(d.width)), rh = Math.min(size.height - y, Math.ceil(d.height));
    if (rw <= 0 || rh <= 0) return;
    const part = image.crop({ x, y, width: rw, height: rh }), ps = part.getSize();
    if (ps.width !== rw || ps.height !== rh) { entry.needFull = true; wc.invalidate(); return; } // unexpected: resend everything
    const buf = part.toBitmap();
    webSend('web:frame', { id, full: false, w: size.width, h: size.height, x, y, rw, rh, data: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength) });
  });
  const css = () => {
    let c = cfg.transparent ? 'html, body { background: transparent !important; background-color: transparent !important; }\n' : '';
    if (cfg.css) c += cfg.css;
    if (c) wc.insertCSS(c).catch(() => {});
    if (cfg.zoom) wc.setZoomFactor(Math.max(0.25, Math.min(5, cfg.zoom)));
  };
  wc.on('dom-ready', css);
  wc.on('did-finish-load', () => { entry.needFull = true; wc.invalidate(); webSend('web:status', { id, ok: true, text: 'Loaded' }); });
  wc.on('did-fail-load', (e, code, desc, url, isMain) => { if (isMain && code !== -3) webSend('web:status', { id, ok: false, text: `Could not load page (${desc})` }); });
  wc.on('render-process-gone', () => { webSend('web:status', { id, ok: false, text: 'Page crashed — reloading…' }); setTimeout(() => { if (webPages.get(id) === entry) wc.reload(); }, 2000); });
  let url = String(cfg.url || '').trim();
  if (url && !/^[a-z]+:/i.test(url)) url = 'https://' + url;
  if (!/^https?:/i.test(url)) { webSend('web:status', { id, ok: false, text: 'Enter a web address (https://…)' }); return; }
  webSend('web:status', { id, ok: false, text: 'Loading…' });
  wc.loadURL(url).catch(() => {});
}
ipcMain.handle('web:open', (e, id, cfg) => { webOpen(id, cfg); return true; });
ipcMain.handle('web:close', (e, id) => { webClose(id); return true; });
ipcMain.handle('web:reload', (e, id) => { const w = webPages.get(id); if (w) { w.needFull = true; w.win.webContents.reloadIgnoringCache(); } return true; });
app.on('before-quit', () => { for (const id of [...webPages.keys()]) webClose(id); });

/* ---------- YouTube account (Google sign-in + YouTube Live API) ---------- */
const ytFile = () => path.join(userDir(), 'youtube-account.json');
const YT_SCOPE = 'https://www.googleapis.com/auth/youtube';
let ytAccess = { token: '', exp: 0 };
function ytCreds() {
  const s = readJSON(settingsFile(), {}).youtube || {};
  let secret = s.clientSecret || '';
  if (s.clientSecretEnc && safeStorage.isEncryptionAvailable()) { try { secret = safeStorage.decryptString(Buffer.from(s.clientSecretEnc, 'base64')); } catch (e) { secret = ''; } }
  return { id: (s.clientId || '').trim(), secret: secret.trim() };
}
function ytSaveRefresh(token, channel) {
  const data = { channel };
  if (safeStorage.isEncryptionAvailable()) data.refreshEnc = safeStorage.encryptString(token).toString('base64');
  else data.refresh = token;
  writeJSON(ytFile(), data);
}
function ytAccount() {
  const d = readJSON(ytFile(), null);
  if (!d) return null;
  let refresh = d.refresh || '';
  if (d.refreshEnc && safeStorage.isEncryptionAvailable()) { try { refresh = safeStorage.decryptString(Buffer.from(d.refreshEnc, 'base64')); } catch (e) { refresh = ''; } }
  return refresh ? { refresh, channel: d.channel } : null;
}
async function ytTokenRequest(params) {
  const c = ytCreds();
  const body = new URLSearchParams(Object.assign({ client_id: c.id, client_secret: c.secret }, params));
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error_description || j.error || `Google sign-in failed (${r.status})`);
  return j;
}
async function ytToken() {
  if (ytAccess.token && Date.now() < ytAccess.exp - 60000) return ytAccess.token;
  const acc = ytAccount();
  if (!acc) throw new Error('Not signed in to YouTube');
  const j = await ytTokenRequest({ grant_type: 'refresh_token', refresh_token: acc.refresh });
  ytAccess = { token: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  return ytAccess.token;
}
async function ytCall(method, endpoint, query, body) {
  const url = new URL('https://www.googleapis.com/youtube/v3/' + endpoint);
  for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  const r = await fetch(url, { method, headers: Object.assign({ Authorization: 'Bearer ' + await ytToken() }, body ? { 'Content-Type': 'application/json' } : {}), body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = j.error || {};
    throw new Error(((e.errors && e.errors[0] && e.errors[0].reason) ? e.errors[0].reason + ': ' : '') + (e.message || `YouTube error ${r.status}`));
  }
  return j;
}
ipcMain.handle('yt:status', () => {
  const c = ytCreds(), acc = ytAccount();
  return { configured: !!(c.id && c.secret), signedIn: !!acc, channel: acc ? acc.channel : null };
});
ipcMain.handle('yt:signOut', () => { try { fs.unlinkSync(ytFile()); } catch (e) { /* */ } ytAccess = { token: '', exp: 0 }; return true; });
ipcMain.handle('yt:api', async (e, method, endpoint, query, body) => {
  try { return { data: await ytCall(method, endpoint, query, body) }; } catch (err) { return { error: err.message }; }
});
ipcMain.handle('yt:signIn', () => new Promise(resolve => {
  const c = ytCreds();
  if (!c.id || !c.secret) return resolve({ error: 'Enter the Client ID and Client secret first.' });
  const verifier = crypto.randomBytes(48).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const state = crypto.randomBytes(16).toString('hex');
  let done = false;
  const finish = r => { if (done) return; done = true; clearTimeout(timer); try { server.close(); } catch (e) { /* */ } if (win && !win.isDestroyed()) win.focus(); resolve(r); };
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    if (u.pathname !== '/') { res.writeHead(404); return res.end(); }
    const page = (msg) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(`<html><body style="font-family:Segoe UI,sans-serif;background:#0b0e14;color:#e8edf6;display:flex;align-items:center;justify-content:center;height:100vh"><div style="text-align:center"><h2>${msg}</h2><p>You can close this window and go back to Live Studio.</p></div></body></html>`); };
    if (u.searchParams.get('state') !== state) { page('Sign-in did not match. Please try again.'); return finish({ error: 'Sign-in did not match' }); }
    if (u.searchParams.get('error')) { page('Sign-in was cancelled.'); return finish({ error: u.searchParams.get('error') }); }
    try {
      const port = server.address().port;
      const j = await ytTokenRequest({ grant_type: 'authorization_code', code: u.searchParams.get('code'), redirect_uri: `http://127.0.0.1:${port}`, code_verifier: verifier });
      if (!j.refresh_token) throw new Error('Google did not return a long-term sign-in. Remove Live Studio from your Google account permissions and try again.');
      ytAccess = { token: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
      ytSaveRefresh(j.refresh_token, null);
      let channel = null;
      try { const ch = await ytCall('GET', 'channels', { part: 'snippet', mine: 'true' }); const it = ch.items && ch.items[0]; if (it) channel = { id: it.id, title: it.snippet.title, thumb: (it.snippet.thumbnails.default || {}).url }; } catch (e) { /* */ }
      ytSaveRefresh(j.refresh_token, channel);
      page('Live Studio is connected to YouTube ✓');
      finish({ ok: true, channel });
    } catch (err) { page('Sign-in failed: ' + err.message); finish({ error: err.message }); }
  });
  const timer = setTimeout(() => finish({ error: 'Sign-in timed out' }), 5 * 60 * 1000);
  server.listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    const q = new URLSearchParams({ client_id: c.id, redirect_uri: `http://127.0.0.1:${port}`, response_type: 'code', scope: YT_SCOPE, code_challenge: challenge, code_challenge_method: 'S256', access_type: 'offline', prompt: 'consent', state });
    shell.openExternal('https://accounts.google.com/o/oauth2/v2/auth?' + q.toString());
  });
}));

/* ---------- automatic updates (GitHub Releases) ---------- */
let lastUpdate = null;
function sendUpdate(status, extra) { lastUpdate = { status, ...extra }; if (win && !win.isDestroyed()) win.webContents.send('update:status', lastUpdate); }
function setupUpdater() {
  if (!autoUpdater || !app.isPackaged) return;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('checking-for-update', () => sendUpdate('checking'));
  autoUpdater.on('update-available', i => sendUpdate('downloading', { version: i.version }));
  autoUpdater.on('update-not-available', () => sendUpdate('current'));
  autoUpdater.on('download-progress', p => sendUpdate('downloading', { percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', i => sendUpdate('ready', { version: i.version }));
  autoUpdater.on('error', err => sendUpdate('error', { message: String(err && err.message || err) }));
  const check = () => { if (!outputs.active) autoUpdater.checkForUpdates().catch(() => {}); };
  setTimeout(check, 4000);
  setInterval(check, 2 * 60 * 60 * 1000);
}
ipcMain.handle('update:check', async () => {
  if (!autoUpdater || !app.isPackaged) return { status: 'dev' };
  try { if (lastUpdate && lastUpdate.status === 'ready') { sendUpdate('ready', { version: lastUpdate.version }); return { status: 'ready' }; } await autoUpdater.checkForUpdates(); return { status: 'checking' }; } catch (e) { return { status: 'error', message: e.message }; }
});
ipcMain.on('update:install', () => {
  if (outputs.active) return;
  if (!autoUpdater) return;
  (async () => {
    const save = askSave();
    if (save === 'cancel') return;
    if (save === 'yes' && !(await saveFromWindow())) return;
    isLive = false; closeOK = true; autoUpdater.quitAndInstall(false, true);
  })();
});
