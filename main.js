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

  win.on('close', e => {
    if (!isLive && !outputs.active) return;
    const r = dialog.showMessageBoxSync(win, {
      type: 'warning', buttons: ['Keep streaming', 'End stream and quit'], defaultId: 0, cancelId: 0,
      title: 'You are live', message: 'You are live or recording right now.', detail: 'Quitting will end the stream and finish the recording.'
    });
    if (r === 0) { e.preventDefault(); return; }
    e.preventDefault();
    outputs.stopAll().then(() => { isLive = false; win.destroy(); });
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
    title: 'Add video or image', properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Video & images', extensions: ['mp4', 'mov', 'm4v', 'webm', 'mkv', 'png', 'jpg', 'jpeg', 'webp', 'gif'] },
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
ipcMain.handle('folder:open', (e, p) => { if (p) { fs.mkdirSync(p, { recursive: true }); shell.openPath(p); } });
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
function sendUpdate(status, extra) { if (win && !win.isDestroyed()) win.webContents.send('update:status', { status, ...extra }); }
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
  try { await autoUpdater.checkForUpdates(); return { status: 'checking' }; } catch (e) { return { status: 'error', message: e.message }; }
});
ipcMain.on('update:install', () => {
  if (outputs.active) return;
  if (autoUpdater) { isLive = false; autoUpdater.quitAndInstall(false, true); }
});
