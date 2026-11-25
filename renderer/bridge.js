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
  const vstSyncWorker = L => { if (L.worker) L.worker.postMessage({ n: L.chain.filter(id => L.slots[id] && !L.slots[id].bypass).length, delay: L.delayMs, running: L.running }); };
  const vstL = () => window.__vst = window.__vst || { sent: [], cbs: [], audioCbs: [], slots: {}, chain: [], delayMs: 4, latOf: {},
    list: [{ path: 'C:\\Program Files\\Common Files\\VST3\\WaveShell1-VST3 14.12_x64.vst3', cid: '57415645534C324C3220537465726500', name: 'L2 Stereo', vendor: 'Waves', sub: 'Fx|Dynamics' },
      { path: 'C:\\Program Files\\Common Files\\VST3\\WaveShell1-VST3 14.12_x64.vst3', cid: '57415645535251533352657665726200', name: 'RVerb Stereo', vendor: 'Waves', sub: 'Fx|Reverb' },
      { path: 'C:\\Program Files\\Common Files\\VST3\\FabFilter Pro-Q 3.vst3', cid: '72C4DB717A4D459AB97E51745D84B39D', name: 'Pro-Q 3', vendor: 'FabFilter', sub: 'Fx|EQ' },
      { path: 'C:\\Program Files\\Common Files\\VST3\\Synth.vst3', cid: '00000000000000000000000000000001', name: 'Some Synth', vendor: 'X', sub: 'Instrument|Synth' }] };

  window.studio = {
    isApp: false,
    platform: 'browser',
    // like the church PC (24 Nov 13:00 log): three WDM entries without 1080p59.94, three Decklink ones with it
    nativeDevices: async () => ({ video: [{ name: 'Blackmagic WDM Capture', n: 0, modes: [{ kind: 'pixel_format', fmt: 'uyvy422', w: 1920, h: 1080, minFps: 23.976, maxFps: 23.976 }, { kind: 'pixel_format', fmt: 'uyvy422', w: 1920, h: 1080, minFps: 24, maxFps: 24 }, { kind: 'pixel_format', fmt: 'uyvy422', w: 1920, h: 1080, minFps: 25, maxFps: 25 }, { kind: 'pixel_format', fmt: 'uyvy422', w: 1920, h: 1080, minFps: 29.97, maxFps: 29.97 }, { kind: 'pixel_format', fmt: 'uyvy422', w: 1920, h: 1080, minFps: 30, maxFps: 30 }] }, { name: 'Blackmagic WDM Capture', n: 1, modes: [] }, { name: 'Blackmagic WDM Capture', n: 2, modes: [] },
      { name: 'Decklink Video Capture (3)', n: 0, modes: [{ kind: 'pixel_format', fmt: 'uyvy422', w: 1920, h: 1080, minFps: 25, maxFps: 25 }, { kind: 'pixel_format', fmt: 'uyvy422', w: 1920, h: 1080, minFps: 29.97, maxFps: 29.97 }, { kind: 'pixel_format', fmt: 'uyvy422', w: 1920, h: 1080, minFps: 50, maxFps: 50 }, { kind: 'pixel_format', fmt: 'uyvy422', w: 1920, h: 1080, minFps: 59.9402, maxFps: 59.9402 }, { kind: 'pixel_format', fmt: 'uyvy422', w: 1920, h: 1080, minFps: 60, maxFps: 60 }, { kind: 'vcodec', fmt: 'v210', w: 1920, h: 1080, minFps: 59.9402, maxFps: 59.9402 }, { kind: 'vcodec', fmt: 'v210', w: 1920, h: 1080, minFps: 29.97, maxFps: 29.97 }, { kind: 'pixel_format', fmt: 'uyvy422', w: 1280, h: 720, minFps: 59.9402, maxFps: 59.9402 }] }, { name: 'Decklink Video Capture', n: 0, modes: [{ kind: 'pixel_format', fmt: 'uyvy422', w: 1920, h: 1080, minFps: 25, maxFps: 25 }, { kind: 'pixel_format', fmt: 'uyvy422', w: 1920, h: 1080, minFps: 29.97, maxFps: 29.97 }, { kind: 'pixel_format', fmt: 'uyvy422', w: 1920, h: 1080, minFps: 50, maxFps: 50 }, { kind: 'pixel_format', fmt: 'uyvy422', w: 1920, h: 1080, minFps: 59.9402, maxFps: 59.9402 }, { kind: 'pixel_format', fmt: 'uyvy422', w: 1920, h: 1080, minFps: 60, maxFps: 60 }, { kind: 'vcodec', fmt: 'v210', w: 1920, h: 1080, minFps: 59.9402, maxFps: 59.9402 }, { kind: 'vcodec', fmt: 'v210', w: 1920, h: 1080, minFps: 29.97, maxFps: 29.97 }, { kind: 'pixel_format', fmt: 'uyvy422', w: 1280, h: 720, minFps: 59.9402, maxFps: 59.9402 }] }, { name: 'Decklink Video Capture (2)', n: 0, modes: [{ kind: 'pixel_format', fmt: 'uyvy422', w: 1920, h: 1080, minFps: 25, maxFps: 25 }, { kind: 'pixel_format', fmt: 'uyvy422', w: 1920, h: 1080, minFps: 29.97, maxFps: 29.97 }, { kind: 'pixel_format', fmt: 'uyvy422', w: 1920, h: 1080, minFps: 50, maxFps: 50 }, { kind: 'pixel_format', fmt: 'uyvy422', w: 1920, h: 1080, minFps: 59.9402, maxFps: 59.9402 }, { kind: 'pixel_format', fmt: 'uyvy422', w: 1920, h: 1080, minFps: 60, maxFps: 60 }, { kind: 'vcodec', fmt: 'v210', w: 1920, h: 1080, minFps: 59.9402, maxFps: 59.9402 }, { kind: 'vcodec', fmt: 'v210', w: 1920, h: 1080, minFps: 29.97, maxFps: 29.97 }, { kind: 'pixel_format', fmt: 'uyvy422', w: 1280, h: 720, minFps: 59.9402, maxFps: 59.9402 }] }],
      audio: [{ name: 'Input (SSL 2 USB Audio Device)', n: 0 }], raw: 'test' }),
    logWrite: async t => { (window.__log = window.__log || []).push(t); return true; },
    logInfo: async () => ({ file: 'C:\\Users\\you\\Documents\\Live Studio\\Logs\\Live Studio test.log', dir: '' }),
    logShow: async () => {},
    version: async () => 'dev',
    loadShow: async () => ls.get('ls.show'),
    saveShow: async obj => ls.set('ls.show', obj),
    loadSettings: async () => ls.get('ls.settings') || {},
    saveSettings: async obj => ls.set('ls.settings', obj),
    pickMedia: () => new Promise(resolve => {
      const inp = document.createElement('input');
      inp.type = 'file'; inp.multiple = true; inp.accept = 'video/*,image/*,audio/*';
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
        emit({ id, type: 'stats', kind: opts.kind, frame: Math.round(secs * opts.fps), bitrate: Math.round(o.bytes * 8 / secs / 1000), fps: opts.fps, speed: 1, time: secs });
      }, 1000);
      outs.set(id, o);
      emit({ id, type: 'log', kind: opts.kind, line: 'Browser mode: output simulated (no encoder).' });
      window.__outputs = outs;
      return { id };
    },
    outWrite: (id, buf) => { const o = outs.get(id); if (o) o.bytes += buf.byteLength; },
    outStop: async id => {
      const o = outs.get(id);
      if (o) { clearInterval(o.timer); outs.delete(id); emit({ id, type: 'exit', kind: o.opts.kind, code: 0, expected: true, file: null }); }
    },
    onOutEvent: cb => outListeners.push(cb),
    // native engine stand-in for tests: remembers every command, answers ready, sends small camera pictures
    nativeStart: async opts => { const L = window.__nat = window.__nat || { sent: [], cbs: [] }; L.opts = opts; setTimeout(() => L.cbs.forEach(cb => cb({ ev: 'ready', w: opts.w, h: opts.h })), 50); clearInterval(L.timer);
      L.timer = setInterval(() => { for (const c of L.sent.filter(m => m.cmd === 'camera' && !m.closed)) { const w = 64, h = 36, px = new Uint8Array(w * h * 4); for (let i = 0; i < w * h; i++) { px[i * 4] = (L.n || 0) * 7 % 255; px[i * 4 + 1] = 120; px[i * 4 + 2] = c.id.length * 30; px[i * 4 + 3] = 255; } L.cbs.forEach(cb => cb({ ev: 'cam-frame', id: c.id, w, h }, px)); } L.n = (L.n || 0) + 1;
        L.cbs.forEach(cb => cb({ ev: 'stats', ticks: 60, late: 0, repeat: 0, skip: 0, clock: '', phaseMs: 0, renderMs: 0.4, renderMaxMs: 1, cams: {}, videos: {}, outputs: {}, audioMs: 60, audioUnder: 0, audioOver: 0, audioPpm: 12 })); }, 1000);
      return { ok: true }; },
    nativeStop: async () => { const L = window.__nat; if (L) clearInterval(L.timer); return true; },
    nativeSend: (h, payload) => { const L = window.__nat = window.__nat || { sent: [], cbs: [] }; L.sent.push(Object.assign({}, h, payload ? { bytes: payload.byteLength } : {})); if (h.cmd === 'camera-close') L.sent.filter(m => m.cmd === 'camera' && m.id === h.id).forEach(m => { m.closed = true; }); },
    nativeCamera: (id, dev) => { const L = window.__nat = window.__nat || { sent: [], cbs: [] }; L.sent.push({ cmd: 'camera', id, dev }); setTimeout(() => L.cbs.forEach(cb => cb({ ev: 'cam-status', id, ok: true, text: 'Running' })), 100); },
    nativeAudio: (rate, pcm) => { const L = window.__nat = window.__nat || { sent: [], cbs: [] }; L.audio = (L.audio || 0) + pcm.length; },
    nativeWeb: (id, cfg) => { const L = window.__nat = window.__nat || { sent: [], cbs: [] }; L.sent.push({ cmd: 'web', id, cfg }); },
    onNative: cb => { const L = window.__nat = window.__nat || { sent: [], cbs: [] }; L.cbs.push(cb); },
    // VST3 plug-in host stand-in for tests: every plug-in halves the level; answers after L.delayMs
    vstStart: async () => { const L = vstL(); L.running = true; vstSyncWorker(L); setTimeout(() => L.cbs.forEach(cb => cb(['ready', 'test'])), 50); return { ok: true, ready: false }; },
    vstStop: async () => { const L = vstL(); L.running = false; L.chain = []; vstSyncWorker(L); return true; },
    vstCmd: (f, payload) => {
      const L = vstL(); L.sent.push({ f, bytes: payload ? payload.byteLength : 0 });
      const ev = (...a) => setTimeout(() => L.cbs.forEach(cb => cb(a[0], a[1])), 5);
      if (f[0] === 'load') { L.slots[f[1]] = { bypass: false, lat: L.latOf[f[3]] || 0 }; if (!L.chain.includes(f[1])) L.chain.push(f[1]); const p = L.list.find(x => x.cid === f[3]); ev(p ? ['loaded', f[1], '1', String(L.slots[f[1]].lat), p.name, '2', '2'] : ['loaded', f[1], '0', 'this plug-in is no longer in its file (updated or removed?)']); }
      else if (f[0] === 'unload') { delete L.slots[f[1]]; L.chain = L.chain.filter(x => x !== f[1]); ev(['unloaded', f[1]]); }
      else if (f[0] === 'order') L.chain = f.slice(1).filter(id => L.slots[id]);
      else if (f[0] === 'bypass') { if (L.slots[f[1]]) L.slots[f[1]].bypass = f[2] === '1'; }
      else if (f[0] === 'edit') { ev(['editor', f[1], 'open']); setTimeout(() => L.cbs.forEach(cb => cb(['edited', f[1]])), 300); }
      else if (f[0] === 'get-state') ev(['state', f[1]], new Uint8Array([1, 2, 3, 4]));
      vstSyncWorker(L);
    },
    vstAudio: (seq, pcm) => {
      const L = vstL(); L.blocks = (L.blocks || 0) + 1;
      if (!L.running) return;
      const act = L.chain.filter(id => L.slots[id] && !L.slots[id].bypass), g = Math.pow(0.5, act.length), lat = act.reduce((a, id) => a + L.slots[id].lat, 0);
      const out = new Float32Array(pcm.length); for (let i = 0; i < pcm.length; i++) out[i] = pcm[i] * g; // (the stand-in has no real delay: lat is only reported)
      setTimeout(() => L.audioCbs.forEach(cb => cb({ seq, lat: 0, pcm: out })), L.delayMs);
    },
    vstScan: async () => { const L = vstL(); await new Promise(r => setTimeout(r, 200)); return { plugins: L.list, problems: [], folders: ['C:\\Program Files\\Common Files\\VST3'], modules: 2 }; },
    vstPickFolder: async () => null,
    setLang: () => {},
    // the direct line: a worker stands in for the host program (its own thread, like the real one)
    vstPortSink: port => {
      const L = vstL();
      const src = `let n = 0, delay = 4, running = true, port = null;
        onmessage = e => { const d = e.data; if (d.port) { port = d.port; port.onmessage = m => { const b = m.data; if (!running || b.pcm === undefined) return; const g = Math.pow(0.5, n), out = new Float32Array(b.pcm.length); for (let i = 0; i < out.length; i++) out[i] = b.pcm[i] * g; setTimeout(() => port.postMessage({ seq: b.seq, lat: 0, pcm: out }), delay); }; port.postMessage({ hello: 1 }); } else { n = d.n; delay = d.delay; running = d.running; } };`;
      L.worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
      L.worker.postMessage({ port }, [port]);
      vstSyncWorker(L);
    },
    onVst: cb => vstL().cbs.push(cb),
    onVstAudio: cb => vstL().audioCbs.push(cb),
    onVstScan: () => {},
    openFolder: async () => {},
    setLive: () => {},
    onUpdate: fn => { window.__upd = fn; },
    setDirty: d => { window.__dirty = d; },
    onSaveRequest: fn => { window.__saveReq = fn; },
    saved: ok => { window.__saved = ok; },
    checkUpdates: async () => ({ status: 'dev' }),
    installUpdate: () => { window.__installs = (window.__installs || 0) + 1; },
    downloadUpdate: async () => { window.__downloads = (window.__downloads || 0) + 1; return { status: 'ok' }; },
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
        // like the real app: the whole picture first, then only the strip that changed
        if (!n || n === 1) webListeners.frame.forEach(cb => cb({ id, full: true, w: c.width, h: c.height, x: 0, y: 0, rw: c.width, rh: c.height, data: out }));
        else {
          const x = Math.round(c.width * 0.08), y = Math.round(c.height * 0.25), rw = Math.round(c.width * 0.84), rh = Math.round(c.height * 0.5), part = new Uint8Array(rw * rh * 4);
          for (let r = 0; r < rh; r++) part.set(out.subarray(((y + r) * c.width + x) * 4, ((y + r) * c.width + x + rw) * 4), r * rw * 4);
          webListeners.frame.forEach(cb => cb({ id, full: false, w: c.width, h: c.height, x, y, rw, rh, data: part }));
        }
      };
      webListeners.status.forEach(cb => cb({ id, ok: true, text: 'Browser preview (simulated page)' }));
      tick(); webTimers.set(id, setInterval(tick, 2500));
      return true;
    },
    webClose: async id => { clearInterval(webTimers.get(id)); webTimers.delete(id); return true; },
    webReload: async () => true,
    onWebFrame: cb => webListeners.frame.push(cb),
    onWebStatus: cb => webListeners.status.push(cb),
    pcStats: async () => ({ cpu: 23, cpuTemp: 58, gpu: 41, gpuTemp: 64, gpuName: 'Test GPU', mem: 47, cores: 8, cpuName: 'Test CPU', parts: { page: 9.2, gpu: 4.1, capture: 1.2, audio: 0.4, yt: 3.3, rec: 2.1, main: 0.6, monitor: 0.3, otherPrograms: 1.8 }, decode: { mode: 'cuda-zc', tried: ['cuda-zc ok'] } }),
    yt: {
      status: async () => ({ configured: false, signedIn: false, channel: null, browser: true }),
      signIn: async () => ({ error: 'YouTube sign-in works in the installed app.' }),
      signOut: async () => true,
      api: async () => ({ error: 'Not available in browser mode' })
    }
  };
})();
