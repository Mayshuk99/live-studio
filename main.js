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

/* ---------- native engine (OBS-style): captures the cameras itself, mixes the program and feeds the encoders ---------- */
const { NativeEngine, enginePath } = require('./native-engine');
const nat = new NativeEngine();
outputs.engine = nat;
let natWanted = null; // the settings it was started with (restarted with them if it stops by itself)
const natWebs = new Map(); // web-page graphic id -> { cfg, sent, w, h }
function natSendEv(h, payload) { if (win && !win.isDestroyed()) win.webContents.send('native:ev', h, payload ? new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength) : null); }
// which FFmpeg is which (from the engine's stats): its camera readers and video files, for the processor shares
const natKids = new Map();
nat.on('msg', (h, payload) => {
  if (h.ev === 'stats') {
    natKids.clear();
    for (const c of Object.values(h.cams || {})) if (c && c.pid) natKids.set(c.pid, 'cam');
    for (const v of Object.values(h.videos || {})) if (v && v.pid) natKids.set(v.pid, 'video');
  }
  if (h.ev === 'out-log' || h.ev === 'out-exit' || h.ev === 'out-started') { outputs.engineEvent(h); return; }
  if (h.ev === 'ready') { for (const st of natWebs.values()) st.sent = false; for (const [id] of natWebs) webRepaint(id); }
  if (h.ev === 'exit') {
    outputs.engineGone();
    if (natWanted) setTimeout(() => { if (natWanted && !nat.proc) { const exe = enginePath(app); if (exe) nat.start(exe, natWanted); } }, 1500);
  }
  natSendEv(h, payload);
});
ipcMain.handle('native:start', (e, opts) => {
  const exe = enginePath(app);
  if (!exe) return { error: 'The native engine is missing from this installation — update Live Studio.' };
  natWanted = Object.assign({}, opts, { ffmpeg: outputs.ffmpegPath });
  if (nat.proc) { nat.send(Object.assign({ cmd: 'hello' }, natWanted)); return { ok: true, restarted: true }; }
  return nat.start(exe, natWanted) ? { ok: true } : { error: 'The native engine could not start.' };
});
ipcMain.handle('native:stop', async () => { natWanted = null; natWebs.clear(); await nat.stop(); return true; });
ipcMain.on('native:send', (e, h, payload) => { nat.send(h, payload || undefined); });
ipcMain.on('native:camera', (e, id, dev) => {
  // a network source: NDI through the NDI helper, SRT / RTSP / other addresses through FFmpeg — never the clock
  if (dev.net) {
    if (dev.net.type === 'ndi') {
      const exe = ndiExe();
      if (!exe) { natSendEv({ ev: 'cam-status', id, ok: false, text: 'The NDI helper is missing from this installation — update Live Studio.' }); return; }
      nat.send({ cmd: 'camera', id, exe, free: true, w: dev.w, h: dev.h, args: ['--recv', dev.net.name || '', ...(dev.net.url ? ['--url', dev.net.url] : []), ...(dev.net.low ? ['--low'] : [])] });
    } else nat.send({ cmd: 'camera', id, free: true, w: dev.w, h: dev.h, args: require('./streamer').netArgs(Object.assign({ w: dev.w, h: dev.h }, dev.net)) });
    return;
  }
  nat.send({ cmd: 'camera', id, fps: dev.fps, w: dev.w, h: dev.h, args: require('./streamer').captureArgs(dev) });
});
/* NDI: the helper finds the sources on the network (needs the NDI Runtime from NDI Tools) */
function ndiExe() {
  const exe = process.platform === 'win32' ? 'ls-ndi.exe' : 'ls-ndi';
  const c = [];
  if (app.isPackaged) c.push(path.join(process.resourcesPath, 'ndi', exe));
  c.push(path.join(__dirname, 'resources', 'ndi', exe), path.join(__dirname, 'ndihost', 'build', exe), path.join(__dirname, 'ndihost', 'build', 'Release', exe));
  return c.find(p => { try { return fs.statSync(p).isFile(); } catch (e) { return false; } }) || null;
}
ipcMain.handle('ndi:list', () => new Promise(resolve => {
  const exe = ndiExe();
  if (!exe) { resolve({ error: 'The NDI helper is missing from this installation — update Live Studio.' }); return; }
  require('child_process').execFile(exe, ['--list', '3000'], { timeout: 15000, windowsHide: true }, (err, out) => {
    try { resolve(JSON.parse(String(out).trim().split(/\r?\n/).pop())); }
    catch (x) { resolve({ error: err ? err.message : 'no answer from the NDI helper' }); }
  });
}));
ipcMain.on('native:audio', (e, rate, pcm) => { if (nat.soundRoom) nat.send({ cmd: 'audio', rate, ch: 2 }, pcm); });
// the direct line from the window's sound thread (does not wait for the window when it is busy)
ipcMain.on('native:audio-port', e => {
  const port = e.ports && e.ports[0];
  if (!port) return;
  let first = true;
  port.on('message', ev => {
    const d = ev.data;
    if (!d || !d.pcm) return;
    if (first) { first = false; natSendEv({ ev: 'audio-port-ok' }); }
    if (nat.soundRoom) nat.send({ cmd: 'audio', rate: d.rate, ch: 2 }, d.pcm);
  });
  port.start();
});
// where and how a web-page graphic is shown (the pictures come straight from the page, below)
ipcMain.on('native:web', (e, id, cfg) => {
  if (!cfg) { natWebs.delete(id); nat.send({ cmd: 'overlay-remove', id: 'web:' + id }); return; }
  const st = natWebs.get(id) || { sent: false };
  const moved = !st.cfg || ['x', 'y', 'w', 'h'].some(k => st.cfg[k] !== cfg[k]) || JSON.stringify(st.cfg.key) !== JSON.stringify(cfg.key);
  st.cfg = cfg; natWebs.set(id, st);
  if (!st.sent) { webRepaint(id); return; }
  nat.send(Object.assign({ cmd: 'overlay-set', id: 'web:' + id, visible: cfg.visible, opacity: cfg.opacity, fadeMs: cfg.fadeMs, z: cfg.z }, moved ? { x: cfg.x, y: cfg.y, w: cfg.w, h: cfg.h, key: cfg.key } : {}));
});
function natWebFrame(f) {
  const st = natWebs.get(f.id);
  if (!st || !st.cfg || !nat.ready) return;
  const c = st.cfg;
  if (f.full) {
    st.w = f.w; st.h = f.h; st.sent = true;
    nat.send({ cmd: 'overlay', id: 'web:' + f.id, sw: f.w, sh: f.h, bgra: true, premult: true, x: c.x, y: c.y, w: c.w, h: c.h, z: c.z, opacity: c.opacity, fadeMs: c.fadeMs, key: c.key, visible: c.visible }, f.data);
  } else if (st.sent && st.w === f.w && st.h === f.h) {
    nat.send({ cmd: 'overlay-patch', id: 'web:' + f.id, px: f.x, py: f.y, pw: f.rw, ph: f.rh }, f.data);
  }
}
function webRepaint(id) { const w = webPages.get(id); if (w) { w.needFull = true; try { w.win.webContents.invalidate(); } catch (e) { /* */ } } }
app.on('before-quit', () => { natWanted = null; });

/* ---------- interface language: the window tells us; dialogs from here use it too ---------- */
let uiLang = 'en';
const UI_RU = {
  'Folder with VST3 plug-ins': 'Папка с плагинами VST3',
  'Keep streaming': 'Продолжать трансляцию', 'End stream and quit': 'Завершить трансляцию и выйти',
  'You are live': 'Вы в эфире', 'You are live or recording right now.': 'Сейчас идёт трансляция или запись.',
  'Quitting will end the stream and finish the recording.': 'Выход завершит трансляцию и запись.',
  'Cancel': 'Отмена', 'Close without saving': 'Закрыть без сохранения', 'Could not save': 'Не удалось сохранить',
  'Your changes could not be saved.': 'Не удалось сохранить изменения.',
  'Add video, picture or music': 'Добавить видео, картинку или музыку', 'Video, pictures & music': 'Видео, картинки и музыка', 'All files': 'Все файлы',
  'Add video, picture, music or slides': 'Добавить видео, картинку, музыку или слайды', 'Everything Live Studio opens': 'Всё, что открывает Live Studio',
  'Video': 'Видео', 'Pictures and photos': 'Картинки и фото', 'Music and sound': 'Музыка и звук', 'Slides: PDF, PowerPoint, text': 'Слайды: PDF, PowerPoint, текст',
  'Save show': 'Сохранить шоу', 'Open show': 'Открыть шоу', 'Live Studio show': 'Шоу Live Studio',
  'Folder for recordings': 'Папка для записей',
  'Save': 'Сохранить', "Don't save": 'Не сохранять', 'Save changes?': 'Сохранить изменения?',
  'Do you want to save your changes?': 'Сохранить изменения?',
  'You changed shots, slides, titles, people or settings since you last saved. If you don\'t save, those changes are lost.': 'После последнего сохранения вы меняли кадры, слайды, титры, людей или настройки. Если не сохранить, эти изменения пропадут.',
  'Live Studio — unsaved changes': 'Live Studio — есть несохранённые изменения'
};
const T = s => (uiLang === 'ru' && UI_RU[s]) || s;
ipcMain.on('app:lang', (e, l) => { uiLang = l === 'ru' ? 'ru' : 'en'; if (win && !win.isDestroyed()) win.setTitle(unsaved ? T('Live Studio — unsaved changes') : 'Live Studio'); });

/* ---------- VST3 plug-ins on the Master (inserts): run in their own program (ls-vst), so a plug-in that crashes
   never takes Live Studio or the stream with it — the sound just goes on without it ---------- */
const VST = require('./vst-host');
const vh = new VST.VstHost();
const vstS = { want: null, route: 'port', port: null, sent: 0, lastSent: 0, lastReply: 0, restarts: [], scanning: null };
function vstEv(f, payload) { if (win && !win.isDestroyed()) win.webContents.send('vst:ev', f, payload ? new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength) : null); }
function vstStart() {
  const exe = VST.vstExe(app);
  if (!exe) return { error: 'The plug-in host is missing from this installation — update Live Studio.' };
  if (vh.proc) return { ok: true, ready: vh.ready };
  if (!vh.start(exe)) return { error: 'The plug-in host could not start.' };
  vstS.sent = 0; vstS.lastReply = Date.now();
  vh.send(['init', vstS.want.rate || 48000, 512]);
  return { ok: true, ready: false };
}
vh.on('msg', (f, payload) => {
  if (f[0] === 'audio') { // a processed block: back to the sound thread, the way it came
    vstS.lastReply = Date.now();
    if (!payload) return;
    const pcm = new Float32Array(payload.length >> 2);
    Buffer.from(pcm.buffer).set(payload.subarray(0, pcm.length * 4)); // copied: a Buffer may not sit on a 4-byte boundary
    const d = { seq: +f[1], lat: +f[3] || 0, pcm };
    if (vstS.route === 'port' && vstS.port) { try { vstS.port.postMessage(d); } catch (e) { vstS.route = 'ipc'; } }
    else if (win && !win.isDestroyed()) win.webContents.send('vst:audio', d);
    return;
  }
  if (f[0] === 'host-exit') {
    vstEv(f);
    if (vstS.want) { // came down by itself: back up (the window loads the plug-ins again when it says ready)
      const now = Date.now(); vstS.restarts = vstS.restarts.filter(t => now - t < 120000);
      if (vstS.restarts.length >= 3) { vstEv(['log', 'the plug-in host stopped 3 times in 2 minutes — the sound goes on without plug-ins until you load them again']); vstS.want = null; return; }
      vstS.restarts.push(now);
      setTimeout(() => { if (vstS.want && !vh.proc) vstStart(); }, 1000);
    }
    return;
  }
  vstEv(f, payload);
});
// a plug-in that hangs while processing: no answer for 4 s although sound is being sent → the host is restarted
setInterval(() => {
  if (!vh.proc || !vstS.want || !vh.ready) return;
  const now = Date.now();
  if (vstS.sent > 50 && now - vstS.lastSent < 1000 && now - vstS.lastReply > 4000) {
    vstEv(['log', 'a plug-in stopped answering — restarting the plug-in host']);
    vstS.sent = 0; vstS.lastReply = Date.now();
    try { vh.proc.kill('SIGKILL'); } catch (e) { /* */ }
  }
}, 1000);
function vstAudio(seq, pcm) {
  if (!vh.ready) return;
  if (vh.backlog > (4 << 20)) return; // the host is far behind: drop (the sound thread plays the untouched sound)
  const frames = (pcm.byteLength >> 3);
  if (frames <= 0) return;
  const now = Date.now();
  if (!vstS.sent || now - vstS.lastSent > 2000) vstS.lastReply = now; // (sound starting again after a pause)
  vstS.sent++; vstS.lastSent = now;
  vh.send(['audio', seq, frames], pcm);
}
ipcMain.handle('vst:start', (e, opts) => { vstS.want = Object.assign({ rate: 48000 }, opts); vstS.restarts = []; return vstStart(); });
ipcMain.handle('vst:stop', async () => { vstS.want = null; await vh.stop(); return true; });
ipcMain.on('vst:cmd', (e, fields, payload) => { if (Array.isArray(fields) && fields.length) vh.send(fields, payload || undefined); });
ipcMain.on('vst:audio', (e, seq, pcm) => { vstS.route = 'ipc'; vstAudio(seq, pcm); });
// the direct line from the window's sound thread
ipcMain.on('vst:port', e => {
  const port = e.ports && e.ports[0];
  if (!port) return;
  if (vstS.port) try { vstS.port.close(); } catch (err) { /* */ }
  vstS.port = port; vstS.route = 'port';
  port.on('message', ev => { const d = ev.data; if (d && d.pcm !== undefined) { vstS.route = 'port'; vstAudio(d.seq, d.pcm); } });
  port.on('close', () => { if (vstS.port === port) { vstS.port = null; vstS.route = 'ipc'; } });
  port.start();
  port.postMessage({ hello: 1 });
});
ipcMain.handle('vst:scan', async (e, force, extra) => {
  const exe = VST.vstExe(app);
  if (!exe) return { error: 'The plug-in host is missing from this installation — update Live Studio.' };
  if (!vstS.scanning) vstS.scanning = VST.scan(exe, VST.vstFolders(extra), path.join(userDir(), 'vst-plugins.json'), !!force,
    p => { if (win && !win.isDestroyed()) win.webContents.send('vst:scan-progress', p); }).finally(() => { vstS.scanning = null; });
  try { return await vstS.scanning; } catch (err) { return { error: err.message }; }
});
ipcMain.handle('vst:pick-folder', async () => {
  const r = await dialog.showOpenDialog(win, { title: T('Folder with VST3 plug-ins'), properties: ['openDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});
app.on('before-quit', () => { vstS.want = null; const p = vh.proc; if (p) { vh.send(['quit']); setTimeout(() => { try { p.kill(); } catch (e) { /* */ } }, 2000).unref(); } });

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
        type: 'warning', buttons: [T('Keep streaming'), T('End stream and quit')], defaultId: 0, cancelId: 0,
        title: T('You are live'), message: T('You are live or recording right now.'), detail: T('Quitting will end the stream and finish the recording.')
      });
      if (r === 0) { e.preventDefault(); return; }
    }
    const save = askSave();
    if (save === 'cancel') { e.preventDefault(); return; }
    if (!live && save === 'no') return;
    e.preventDefault();
    (async () => {
      if (save === 'yes' && !(await saveFromWindow())) {
        const r = dialog.showMessageBoxSync(win, { type: 'error', buttons: [T('Cancel'), T('Close without saving')], defaultId: 0, cancelId: 0, title: T('Could not save'), message: T('Your changes could not be saved.') });
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

/* ---------- service log: one plain text file per session (Documents\Live Studio\Logs) to send for troubleshooting ---------- */
const logDir = () => path.join(app.getPath('documents'), 'Live Studio', 'Logs');
let logFile = null;
function logOpen() {
  if (logFile) return logFile;
  const d = logDir();
  fs.mkdirSync(d, { recursive: true });
  const t = new Date(), z = n => String(n).padStart(2, '0');
  logFile = path.join(d, `Live Studio ${t.getFullYear()}-${z(t.getMonth() + 1)}-${z(t.getDate())} ${z(t.getHours())}-${z(t.getMinutes())}-${z(t.getSeconds())}.log`);
  try { // keep the newest 40
    const old = fs.readdirSync(d).filter(f => /^Live Studio .*\.log$/.test(f)).sort();
    for (const f of old.slice(0, Math.max(0, old.length - 40))) fs.unlinkSync(path.join(d, f));
  } catch (e) { /* */ }
  return logFile;
}
ipcMain.handle('log:write', async (e, text) => { try { await fs.promises.appendFile(logOpen(), String(text)); return true; } catch (err) { return false; } });
ipcMain.handle('log:info', () => { try { return { file: logOpen(), dir: logDir() }; } catch (e) { return { file: '', dir: '' }; } });
ipcMain.handle('log:show', () => { try { shell.showItemInFolder(logOpen()); } catch (e) { /* */ } });
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
  for (const d of Array.isArray(s.streams) ? s.streams : []) {
    if (d.keyEnc && safeStorage.isEncryptionAvailable()) { try { d.key = safeStorage.decryptString(Buffer.from(d.keyEnc, 'base64')); } catch (e) { d.key = ''; } }
    delete d.keyEnc;
  }
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
  for (const d of Array.isArray(s.streams) ? s.streams : []) {
    if (d.key && safeStorage.isEncryptionAvailable()) { d.keyEnc = safeStorage.encryptString(d.key).toString('base64'); delete d.key; }
  }
  writeJSON(settingsFile(), s);
  outputs.ffmpegPath = ffmpegPath();
  applyUpdMode();
  return true;
});

/* files: video, pictures, sound, documents (see media-import.js) */
const MI = require('./media-import');
function pdftoppmPath() {
  const exe = process.platform === 'win32' ? 'pdftoppm.exe' : 'pdftoppm';
  for (const c of [path.join(process.resourcesPath || '', 'poppler', exe), path.join(__dirname, 'resources', 'poppler', exe)]) if (fs.existsSync(c)) return c;
  return exe;
}
const mediaDir = () => path.join(userDir(), 'media');
ipcMain.handle('media:pick', async () => {
  const E = MI.EXT;
  const r = await dialog.showOpenDialog(win, {
    title: T('Add video, picture, music or slides'), properties: ['openFile', 'multiSelections'],
    filters: [
      { name: T('Everything Live Studio opens'), extensions: MI.ALL_EXT },
      { name: T('Video'), extensions: E.video },
      { name: T('Pictures and photos'), extensions: E.image },
      { name: T('Music and sound'), extensions: E.audio },
      { name: T('Slides: PDF, PowerPoint, text'), extensions: [...E.doc, ...E.text] },
      { name: T('All files'), extensions: ['*'] }
    ]
  });
  if (r.canceled) return [];
  return r.filePaths.map(p => Object.assign({ path: p, name: path.basename(p), size: fs.statSync(p).size }, MI.classify(p)));
});
ipcMain.handle('media:read', async (e, p) => {
  const buf = await fs.promises.readFile(p);
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
});
// a copy the player plays: video → MP4, sound → FLAC, picture → PNG (kept and reused)
ipcMain.handle('media:convert', async (e, src, kind) => {
  const prog = pct => { if (win && !win.isDestroyed()) win.webContents.send('media:progress', { src, percent: pct }); };
  try {
    const fn = kind === 'audio' ? MI.convertAudio : kind === 'image' ? MI.convertImage : MI.convertVideo;
    return await fn(ffmpegPath(), src, mediaDir(), prog);
  } catch (err) { return { error: err.message }; }
});
// slides: PDF / PowerPoint pages as pictures, or the words of a text file
ipcMain.handle('media:doc', (e, src) => MI.importDoc({ pdftoppm: pdftoppmPath() }, src, mediaDir(), p => {
  if (win && !win.isDestroyed()) win.webContents.send('media:progress', Object.assign({ src }, p));
}));
ipcMain.handle('media:exists', (e, list) => (list || []).map(p => { try { return fs.statSync(p).isFile(); } catch (err) { return false; } }));
ipcMain.handle('folder:pick', async () => {
  const r = await dialog.showOpenDialog(win, { title: T('Folder for recordings'), properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('folder:open', (e, p) => { if (p) { try { if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); } catch (err) { /* e.g. a whole drive */ } shell.openPath(p); } });
ipcMain.handle('file:show', (e, p) => { if (p) shell.showItemInFolder(p); });

ipcMain.handle('show:export', async (e, obj) => {
  const r = await dialog.showSaveDialog(win, {
    title: T('Save show'), defaultPath: `${obj.showName || 'Show'}.livestudio.json`,
    filters: [{ name: T('Live Studio show'), extensions: ['json'] }]
  });
  if (r.canceled) return false;
  writeJSON(r.filePath, obj);
  return true;
});
ipcMain.handle('show:import', async () => {
  const r = await dialog.showOpenDialog(win, { title: T('Open show'), filters: [{ name: T('Live Studio show'), extensions: ['json'] }], properties: ['openFile'] });
  if (r.canceled) return null;
  return readJSON(r.filePaths[0], null);
});

ipcMain.handle('out:start', (e, opts) => {
  try { return { id: outputs.start(opts) }; } catch (err) { return { error: err.message }; }
});
ipcMain.on('out:data', (e, id, data) => outputs.write(id, data));
// Live Studio's own picture, camera and graphics processes run above normal priority (like OBS can), so other
// programs and the encoders never make the program miss a frame. Checked every 10 s for new helper processes.
// The same reading also shows which part of Live Studio uses the processor (in the service log, every second).
const procCpu = { prev: new Map(), parts: null, tick: 0 };
function procSample() {
  const os = require('os');
  let metrics; try { metrics = app.getAppMetrics(); } catch (e) { return; }
  const now = Date.now(), cores = os.cpus().length || 1;
  if (procCpu.tick++ % 5 === 0) for (const m of metrics) {
    if (!['GPU', 'Tab', 'Utility', 'Browser'].includes(m.type)) continue;
    try { if (os.getPriority(m.pid) > os.constants.priority.PRIORITY_ABOVE_NORMAL) os.setPriority(m.pid, os.constants.priority.PRIORITY_ABOVE_NORMAL); } catch (e) { /* not allowed */ }
  }
  let pagePid = -1; try { if (win && !win.isDestroyed()) pagePid = win.webContents.getOSProcessId(); } catch (e) { /* */ }
  const overlay = new Set(); for (const w of webPages.values()) { try { if (w.win && !w.win.isDestroyed()) overlay.add(w.win.webContents.getOSProcessId()); } catch (e) { /* */ } }
  const parts = { page: 0, gpu: 0, capture: 0, audio: 0, overlays: 0, main: 0, helpers: 0 }, seen = new Set();
  for (const m of metrics) {
    const c = m.cpu || {}; let pct = 0; seen.add(m.pid);
    if (typeof c.cumulativeCPUUsage === 'number') { // seconds of processor time since the process started
      const p = procCpu.prev.get(m.pid); procCpu.prev.set(m.pid, { t: now, s: c.cumulativeCPUUsage });
      pct = p && now > p.t ? 100 * (c.cumulativeCPUUsage - p.s) / ((now - p.t) / 1000) / cores : 0;
    } else pct = c.percentCPUUsage || 0; // already a share of the whole PC
    const svc = `${m.serviceName || ''} ${m.name || ''}`;
    const k = m.pid === pagePid ? 'page' : m.type === 'GPU' ? 'gpu' : overlay.has(m.pid) ? 'overlays'
      : /video_capture|video capture/i.test(svc) ? 'capture' : /audio/i.test(svc) ? 'audio' : m.type === 'Browser' ? 'main' : 'helpers';
    parts[k] += Math.max(0, pct);
  }
  for (const pid of procCpu.prev.keys()) if (!seen.has(pid)) procCpu.prev.delete(pid);
  procCpu.parts = parts;
}
app.whenReady().then(() => { setTimeout(procSample, 3000); setInterval(procSample, 2000); });
// which way of decoding on the graphics card works here (the encoders use it from then on)
let decodeInfo = { mode: 'checking' };
app.whenReady().then(() => setTimeout(() => {
  const st = require('./streamer');
  st.probeDecode(outputs.ffmpegPath).then(r => { decodeInfo = r || { mode: 'auto' }; st.setDecodeMode(decodeInfo.mode); })
    .catch(e => { decodeInfo = { mode: 'auto', note: e.message }; });
}, 6000));
ipcMain.handle('native:devices', async () => { try { return await require('./streamer').listCaptureDevices(outputs.ffmpegPath); } catch (e) { return { video: [], audio: [], error: e.message }; } });
ipcMain.handle('out:stop', (e, id) => outputs.stop(id));
ipcMain.on('app:live', (e, live) => { isLive = !!live; });
// unsaved changes: the window tells us when there are some, and we ask before closing
let unsaved = false, closeOK = false;
ipcMain.on('app:dirty', (e, d) => { unsaved = !!d; if (win && !win.isDestroyed()) win.setTitle(unsaved ? T('Live Studio — unsaved changes') : 'Live Studio'); });
function askSave() {
  if (!unsaved || !win || win.isDestroyed()) return 'no';
  const r = dialog.showMessageBoxSync(win, {
    type: 'question', buttons: [T('Save'), T("Don't save"), T('Cancel')], defaultId: 0, cancelId: 2, noLink: true,
    title: T('Save changes?'), message: T('Do you want to save your changes?'),
    detail: T('You changed shots, slides, titles, people or settings since you last saved. If you don\'t save, those changes are lost.')
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
    // (the GPU counters are only read when there is no NVIDIA tool — reading them costs processor time itself)
    // FF| lists each FFmpeg's processor time in ms, and PS| this loop's own, so the log can show what each one costs
    const script = "$ErrorActionPreference='SilentlyContinue'; $nv=[bool](Get-Command nvidia-smi); while($true){ $g=''; $t=''; $s=$null; if(-not $nv){ $s=(Get-Counter '\\GPU Engine(*)\\Utilization Percentage').CounterSamples }; if($s){ $m=0; $s | Group-Object { if($_.InstanceName -match 'engtype_(\\w+)'){$matches[1]} } | ForEach-Object { $v=($_.Group | Measure-Object CookedValue -Sum).Sum; if($v -gt $m){$m=$v} }; $g=[math]::Min(100,[math]::Round($m)) }; $z=Get-CimInstance -Namespace root/wmi -ClassName MSAcpi_ThermalZoneTemperature; if($z){ $t=[math]::Round((($z | Measure-Object CurrentTemperature -Maximum).Maximum/10)-273.15) }; Write-Output ('PC|{0}|{1}' -f $g,$t); $f=(Get-Process -Name ffmpeg,ls-engine,ls-vst | ForEach-Object { '{0}:{1}' -f $_.Id,[long]$_.TotalProcessorTime.TotalMilliseconds }) -join ','; Write-Output ('FF|' + $f); Write-Output ('PS|' + [long](Get-Process -Id $PID).TotalProcessorTime.TotalMilliseconds); $o=(Get-Process | ForEach-Object { if($_.CPU){ '{0}:{1}:{2}' -f $_.Id,$_.ProcessName,[long]($_.CPU*1000) } }) -join ','; Write-Output ('OT|' + $o); Start-Sleep -Seconds 3 }";
    try {
      const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      const ffPrev = new Map(), otPrev = new Map(); let psPrev = null;
      ps.stdout.on('data', d => { for (const line of String(d).split(/\r?\n/)) {
        const now = Date.now(), cores = os.cpus().length || 1;
        if (line.startsWith('FF|')) { // processor share of each FFmpeg, named by what it does
          const by = {}, kindOf = new Map([...outputs.outs.values()].map(o => [o.proc.pid, o.kind]));
          for (const [pid, k] of natKids) kindOf.set(pid, k); // the engine's camera readers and video files
          if (nat.proc && nat.proc.pid) kindOf.set(nat.proc.pid, 'engine');
          if (vh.proc && vh.proc.pid) kindOf.set(vh.proc.pid, 'vst');
          for (const it of line.slice(3).split(',')) { const [pid, ms] = it.split(':').map(Number); if (!pid) continue;
            const p = ffPrev.get(pid); ffPrev.set(pid, { t: now, ms });
            if (p && now > p.t) { const k = { stream: 'yt', record: 'rec', iso: 'iso', native: 'native', engine: 'engine', vst: 'vst', cam: 'cams', video: 'video' }[kindOf.get(pid)] || 'ffmpeg'; by[k] = (by[k] || 0) + Math.max(0, 100 * (ms - p.ms) / (now - p.t) / cores); } }
          pc.ff = by; continue;
        }
        if (line.startsWith('OT|')) { // the other programs that use the processor most, by name (Live Studio's own left out)
          const own = new Set([ps.pid]); try { for (const m of app.getAppMetrics()) own.add(m.pid); } catch (e) { /* */ }
          const byName = {}, seen = new Set();
          for (const it of line.slice(3).split(',')) { const a = it.split(':'); if (a.length < 3) continue; const pid = +a[0], name = a.slice(1, -1).join(':'), ms = +a[a.length - 1];
            if (!pid || !isFinite(ms)) continue; seen.add(pid);
            const p = otPrev.get(pid); otPrev.set(pid, { t: now, ms });
            if (!p || now <= p.t || own.has(pid) || /^(ffmpeg|ls-engine|ls-vst|ls-ndi|Idle|Live Studio)$/i.test(name)) continue;
            const pct = 100 * (ms - p.ms) / (now - p.t) / cores; if (pct > 0) byName[name] = (byName[name] || 0) + pct; }
          for (const pid of otPrev.keys()) if (!seen.has(pid)) otPrev.delete(pid);
          pc.top = Object.entries(byName).filter(([, v]) => v >= 1).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([n, v]) => [n, Math.round(v * 10) / 10]);
          continue;
        }
        if (line.startsWith('PS|')) { const ms = +line.slice(3); if (psPrev && now > psPrev.t) pc.ps = Math.max(0, 100 * (ms - psPrev.ms) / (now - psPrev.t) / cores); psPrev = { t: now, ms }; continue; }
        const m = line.match(/^PC\|(\d*)\|(-?\d*)/); if (!m) continue; if (!pc.nv && m[1] !== '') pc.gpu = +m[1]; if (m[2] !== '' && +m[2] > 0 && +m[2] < 120) pc.cpuTemp = +m[2];
      } });
      ps.on('error', () => {});
      app.on('before-quit', () => { try { ps.kill(); } catch (e) { /* */ } });
      if (win) win.on('closed', () => { try { ps.kill(); } catch (e) { /* */ } });
    } catch (e) { /* no powershell */ }
  }
}
ipcMain.handle('pc:stats', () => {
  pcStart();
  // processor share (of the whole PC, %) of each part: Live Studio's own processes, each FFmpeg, and everything else
  let parts = null;
  if (procCpu.parts) {
    const r1 = x => Math.round(x * 10) / 10;
    parts = {}; for (const [k, v] of Object.entries(procCpu.parts)) parts[k] = r1(v);
    for (const [k, v] of Object.entries(pc.ff || {})) parts[k] = r1(v);
    if (pc.ps !== undefined) parts.monitor = r1(pc.ps);
    if (pc.cpu !== null) parts.otherPrograms = r1(Math.max(0, pc.cpu - Object.values(parts).reduce((a, b) => a + b, 0)));
  }
  return { cpu: pc.cpu, cpuTemp: pc.cpuTemp, gpu: pc.gpu, gpuTemp: pc.gpuTemp, gpuName: pc.gpuName, mem: pc.mem, cores: os.cpus().length, cpuName: (os.cpus()[0] || {}).model, parts, topOther: pc.top || [], decode: decodeInfo };
});

/* ---------- web page overlays: pages rendered off-screen (like a browser source) ---------- */
const webPages = new Map(); // id -> { win, cfg }
function webSend(ch, payload) { if (ch === 'web:frame') natWebFrame(payload); if (win && !win.isDestroyed()) win.webContents.send(ch, payload); }
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

/* ---------- updates (GitHub Releases) — Settings → About → Updates:
   ask  (default) look for a new version and offer it; nothing downloads or installs until the user presses the button
   off  never look by itself — only when "Check for updates" is pressed (then it asks the same way)
   auto download in the background and install when the program closes ---------- */
let lastUpdate = null;
function sendUpdate(status, extra) { lastUpdate = { status, ...extra }; if (win && !win.isDestroyed()) win.webContents.send('update:status', lastUpdate); }
const updMode = () => { const m = readJSON(settingsFile(), {}).updates; return ['ask', 'off', 'auto'].includes(m) ? m : 'ask'; };
function applyUpdMode() {
  if (!autoUpdater) return;
  const auto = updMode() === 'auto';
  autoUpdater.autoDownload = auto;
  autoUpdater.autoInstallOnAppQuit = auto;
}
function setupUpdater() {
  if (!autoUpdater || !app.isPackaged) return;
  applyUpdMode();
  autoUpdater.on('checking-for-update', () => sendUpdate('checking'));
  autoUpdater.on('update-available', i => sendUpdate(autoUpdater.autoDownload ? 'downloading' : 'available', { version: i.version }));
  autoUpdater.on('update-not-available', () => sendUpdate('current'));
  autoUpdater.on('download-progress', p => sendUpdate('downloading', { percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', i => sendUpdate('ready', { version: i.version }));
  autoUpdater.on('error', err => sendUpdate('error', { message: String(err && err.message || err) }));
  const check = () => { if (!outputs.active && updMode() !== 'off') autoUpdater.checkForUpdates().catch(() => {}); };
  setTimeout(check, 4000);
  setInterval(check, 2 * 60 * 60 * 1000);
}
ipcMain.handle('update:check', async () => {
  if (!autoUpdater || !app.isPackaged) return { status: 'dev' };
  try { if (lastUpdate && lastUpdate.status === 'ready') { sendUpdate('ready', { version: lastUpdate.version }); return { status: 'ready' }; } await autoUpdater.checkForUpdates(); return { status: 'checking' }; } catch (e) { return { status: 'error', message: e.message }; }
});
// the user chose to get the version that was found
ipcMain.handle('update:download', async () => {
  if (!autoUpdater || !app.isPackaged) return { status: 'dev' };
  if (outputs.active) return { status: 'error', message: 'Finish streaming/recording first.' };
  try { sendUpdate('downloading', { version: lastUpdate && lastUpdate.version }); await autoUpdater.downloadUpdate(); return { status: 'ok' }; }
  catch (e) { sendUpdate('error', { message: e.message }); return { status: 'error', message: e.message }; }
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
