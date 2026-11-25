/* Live Studio — safe bridge between the interface and the desktop app */
'use strict';
const { contextBridge, ipcRenderer } = require('electron');
window.addEventListener('message', e => {
  if (e.source !== window || !e.ports || !e.ports[0]) return;
  if (e.data === 'ls-native-audio-port') ipcRenderer.postMessage('native:audio-port', null, [e.ports[0]]);
  else if (e.data === 'ls-vst-port') ipcRenderer.postMessage('vst:port', null, [e.ports[0]]);
});

contextBridge.exposeInMainWorld('studio', {
  isApp: true,
  platform: process.platform,
  version: () => ipcRenderer.invoke('app:version'),
  logWrite: text => ipcRenderer.invoke('log:write', text),
  nativeDevices: () => ipcRenderer.invoke('native:devices'),
  // native engine (OBS-style)
  nativeStart: opts => ipcRenderer.invoke('native:start', opts),
  nativeStop: () => ipcRenderer.invoke('native:stop'),
  nativeSend: (h, payload) => ipcRenderer.send('native:send', h, payload || null),
  nativeCamera: (id, dev) => ipcRenderer.send('native:camera', id, dev),
  nativeAudio: (rate, pcm) => ipcRenderer.send('native:audio', rate, pcm),
  nativeWeb: (id, cfg) => ipcRenderer.send('native:web', id, cfg),
  onNative: cb => ipcRenderer.on('native:ev', (e, h, payload) => cb(h, payload)),
  setLang: l => ipcRenderer.send('app:lang', l),
  // VST3 plug-ins on the master
  vstStart: opts => ipcRenderer.invoke('vst:start', opts),
  vstStop: () => ipcRenderer.invoke('vst:stop'),
  vstCmd: (fields, payload) => ipcRenderer.send('vst:cmd', fields, payload || null),
  vstAudio: (seq, pcm) => ipcRenderer.send('vst:audio', seq, pcm),
  vstScan: (force, extra) => ipcRenderer.invoke('vst:scan', !!force, extra || []),
  vstPickFolder: () => ipcRenderer.invoke('vst:pick-folder'),
  onVst: cb => ipcRenderer.on('vst:ev', (e, f, payload) => cb(f, payload)),
  onVstAudio: cb => ipcRenderer.on('vst:audio', (e, d) => cb(d)),
  onVstScan: cb => ipcRenderer.on('vst:scan-progress', (e, p) => cb(p)),
  logInfo: () => ipcRenderer.invoke('log:info'),
  logShow: () => ipcRenderer.invoke('log:show'),
  ffmpegVersion: () => ipcRenderer.invoke('app:ffmpeg'),
  loadShow: () => ipcRenderer.invoke('show:load'),
  saveShow: obj => ipcRenderer.invoke('show:save', obj),
  loadSettings: () => ipcRenderer.invoke('settings:load'),
  saveSettings: obj => ipcRenderer.invoke('settings:save', obj),
  setDirty: d => ipcRenderer.send('app:dirty', !!d),
  onSaveRequest: fn => ipcRenderer.on('app:save', () => fn()),
  saved: ok => ipcRenderer.send('app:saved', !!ok),
  pickMedia: () => ipcRenderer.invoke('media:pick'),
  // reads a video/image file; the interface turns it into a playable in-memory URL
  readMedia: p => ipcRenderer.invoke('media:read', p),
  // converts a video the app can't play (e.g. ProRes .mov) into an MP4 copy; reports progress 0–100
  convertMedia: (p, onProgress) => {
    const h = (e, d) => { if (d && d.src === p && typeof onProgress === 'function') onProgress(d.percent); };
    ipcRenderer.on('media:progress', h);
    return ipcRenderer.invoke('media:convert', p).finally(() => ipcRenderer.removeListener('media:progress', h));
  },
  pickFolder: () => ipcRenderer.invoke('folder:pick'),
  openFolder: p => ipcRenderer.invoke('folder:open', p),
  showFile: p => ipcRenderer.invoke('file:show', p),
  exportShow: obj => ipcRenderer.invoke('show:export', obj),
  importShow: () => ipcRenderer.invoke('show:import'),
  outStart: opts => ipcRenderer.invoke('out:start', opts),
  outWrite: (id, buf) => ipcRenderer.send('out:data', id, new Uint8Array(buf)),
  outStop: id => ipcRenderer.invoke('out:stop', id),
  onOutEvent: cb => ipcRenderer.on('out:event', (e, ev) => cb(ev)),
  setLive: live => ipcRenderer.send('app:live', live),
  onUpdate: cb => ipcRenderer.on('update:status', (e, s) => cb(s)),
  checkUpdates: () => ipcRenderer.invoke('update:check'),
  installUpdate: () => ipcRenderer.send('update:install'),
  downloadUpdate: () => ipcRenderer.invoke('update:download'),
  webOpen: (id, cfg) => ipcRenderer.invoke('web:open', id, cfg),
  webClose: id => ipcRenderer.invoke('web:close', id),
  webReload: id => ipcRenderer.invoke('web:reload', id),
  onWebFrame: cb => ipcRenderer.on('web:frame', (e, f) => cb(f)),
  onWebStatus: cb => ipcRenderer.on('web:status', (e, st) => cb(st)),
  pcStats: () => ipcRenderer.invoke('pc:stats'),
  yt: {
    status: () => ipcRenderer.invoke('yt:status'),
    signIn: () => ipcRenderer.invoke('yt:signIn'),
    signOut: () => ipcRenderer.invoke('yt:signOut'),
    api: (method, endpoint, query, body) => ipcRenderer.invoke('yt:api', method, endpoint, query, body)
  }
});
