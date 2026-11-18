/* Live Studio — browser fallback for the desktop bridge.
 * Inside the installed app, preload.js provides window.studio (files, settings, encoder, updates).
 * When the interface is opened in a normal browser (for design work or testing) this stand-in is used.
 */
(function () {
  'use strict';
  if (window.studio) return;
  const ls = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage unavailable */ } }
  };
  const urls = new Map();
  const outListeners = [];
  const webListeners = { frame: [], status: [] };
  const webTimers = new Map();
  const outs = new Map();
  let n = 0;
  const emit = ev => outListeners.forEach(cb => cb(ev));

  window.studio = {
    isApp: false,
    platform: 'browser',
    version: async () => 'dev',
    loadShow: async () => ls.get('ls.show'),
    saveShow: async obj => ls.set('ls.show', obj),
    loadSettings: async () => ls.get('ls.settings') || {},
    saveSettings: async obj => ls.set('ls.settings', obj),
    pickMedia: () => new Promise(resolve => {
      const inp = document.createElement('input');
      inp.type = 'file'; inp.multiple = true; inp.accept = 'video/*,image/*';
      inp.onchange = () => resolve([...inp.files].map(f => {
        const u = URL.createObjectURL(f);
        urls.set(u, u);
        return { path: u, name: f.name, size: f.size };
      }));
      inp.click();
    }),
    mediaURL: async path => {
      if (urls.has(path) || /^(blob:|https?:|data:)/.test(path)) return path;
      throw new Error('File not available in browser mode');
    },
    pickFolder: async () => null,
    exportShow: async obj => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' }));
      a.download = (obj.showName || 'show') + '.livestudio.json';
      a.click();
      return true;
    },
    importShow: () => new Promise(resolve => {
      const inp = document.createElement('input');
      inp.type = 'file'; inp.accept = '.json';
      inp.onchange = async () => { try { resolve(JSON.parse(await inp.files[0].text())); } catch (e) { resolve(null); } };
      inp.click();
    }),
    outStart: async opts => {
      const id = 'o' + (++n);
      const o = { opts, bytes: 0, t0: performance.now() };
      o.timer = setInterval(() => {
        const secs = (performance.now() - o.t0) / 1000;
        emit({ id, type: 'stats', kind: opts.kind, bitrate: Math.round(o.bytes * 8 / secs / 1000), fps: opts.fps, speed: 1, time: secs });
      }, 1000);
      outs.set(id, o);
      emit({ id, type: 'log', kind: opts.kind, line: 'Browser mode: output simulated (no encoder).' });
      window.__outputs = outs;
      return { id };
    },
    outWrite: (id, buf) => { const o = outs.get(id); if (o) o.bytes += buf.byteLength; },
    outStop: async id => {
      const o = outs.get(id);
      if (o) { clearInterval(o.timer); outs.delete(id); emit({ id, type: 'exit', kind: o.opts.kind, code: 0, file: null }); }
    },
    onOutEvent: cb => outListeners.push(cb),
    openFolder: async () => {},
    setLive: () => {},
    onUpdate: () => {},
    checkUpdates: async () => ({ status: 'dev' }),
    installUpdate: () => {},
    confirmQuit: () => {},
    // browser stand-in for web overlays: draws a fake caption page (the real app renders the actual web page)
    webOpen: async (id, cfg) => {
      clearInterval(webTimers.get(id));
      const c = document.createElement('canvas'); c.width = cfg.width; c.height = cfg.height;
      const g = c.getContext('2d');
      const lines = ['Добро пожаловать на служение', 'Welcome to the service', 'Today we read from the Gospel of John', 'Сегодня мы читаем Евангелие от Иоанна'];
      let n = 0;
      const tick = () => {
        g.clearRect(0, 0, c.width, c.height);
        if (!cfg.transparent) { g.fillStyle = '#000'; g.fillRect(0, 0, c.width, c.height); }
        g.fillStyle = 'rgba(0,0,0,.6)'; g.fillRect(c.width * 0.08, c.height * 0.25, c.width * 0.84, c.height * 0.5);
        g.fillStyle = '#fff'; g.font = `600 ${Math.round(c.height * 0.2 * (cfg.zoom || 1))}px Inter, sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText(lines[n++ % lines.length], c.width / 2, c.height / 2);
        const d = g.getImageData(0, 0, c.width, c.height).data, out = new Uint8Array(d.length);
        for (let i = 0; i < d.length; i += 4) { const a = d[i + 3] / 255; out[i] = d[i + 2] * a; out[i + 1] = d[i + 1] * a; out[i + 2] = d[i] * a; out[i + 3] = d[i + 3]; }
        webListeners.frame.forEach(cb => cb({ id, w: c.width, h: c.height, x: 0, y: 0, rw: c.width, rh: c.height, data: out }));
      };
      webListeners.status.forEach(cb => cb({ id, ok: true, text: 'Browser preview (simulated page)' }));
      tick(); webTimers.set(id, setInterval(tick, 2500));
      return true;
    },
    webClose: async id => { clearInterval(webTimers.get(id)); webTimers.delete(id); return true; },
    webReload: async () => true,
    onWebFrame: cb => webListeners.frame.push(cb),
    onWebStatus: cb => webListeners.status.push(cb),
    yt: {
      status: async () => ({ configured: false, signedIn: false, channel: null, browser: true }),
      signIn: async () => ({ error: 'YouTube sign-in works in the installed app.' }),
      signOut: async () => true,
      api: async () => ({ error: 'Not available in browser mode' })
    }
  };
})();
