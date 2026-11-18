/* Live Studio — desktop app (Electron main process) */
'use strict';
const { app, BrowserWindow, ipcMain, dialog, session, shell, safeStorage, powerSaveBlocker, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
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
  if (s.youtube) delete s.youtube.keyEnc;
  if (!s.recordDir) s.recordDir = path.join(app.getPath('videos'), 'Live Studio');
  return s;
});
ipcMain.handle('settings:save', (e, obj) => {
  const s = JSON.parse(JSON.stringify(obj || {}));
  if (s.youtube && s.youtube.key && safeStorage.isEncryptionAvailable()) {
    s.youtube.keyEnc = safeStorage.encryptString(s.youtube.key).toString('base64');
    delete s.youtube.key;
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
