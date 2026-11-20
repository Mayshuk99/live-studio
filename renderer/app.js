/* Live Studio — interface and show control */
(async function () {
  'use strict';
  const S = window.studio;
  const { Engine, makeBars, NEUTRAL, LABEL_PRESETS, labelDesign, drawLabel } = window.LiveEngine;
  const { Mixer } = window.LiveAudio;

  /* ================= helpers ================= */
  const $ = (s, r = document) => r.querySelector(s);
  function el(tag, props, ...kids) {
    const e = document.createElement(tag);
    if (props) for (const [k, v] of Object.entries(props)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'style') e.setAttribute('style', v);
      else if (k === 'html') e.innerHTML = v;
      else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
      else if (k === 'value' || k === 'checked' || k === 'selected' || k === 'disabled') e[k] = v;
      else if (k === 'dataset') Object.assign(e.dataset, v);
      else e.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) e.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    return e;
  }
  // append children, skipping empty values and flattening lists
  function put(parent, ...kids) { for (const k of kids.flat(Infinity)) if (k !== null && k !== undefined && k !== false) parent.append(k); return parent; }
  const uid = p => `${p}_${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-3)}`;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
  const fmt = s => { s = Math.max(0, Math.floor(s)); const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, x = s % 60; return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}`; };
  const fmtShort = s => { s = Math.max(0, Math.ceil(s)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
  const clone = o => JSON.parse(JSON.stringify(o));
  function toast(msg, type = '', action) {
    const t = el('div', { class: `toast ${type}` }, msg);
    if (action) t.append(' ', el('button', { class: 'btn small', onclick: () => { action.fn(); t.remove(); } }, action.label));
    $('#toasts').append(t);
    setTimeout(() => t.remove(), type === 'error' ? 9000 : 5000);
  }
  function select(options, value, onchange, attrs = {}) {
    const s = el('select', attrs, options.map(([v, l]) => el('option', { value: v, selected: String(v) === String(value) }, l)));
    s.addEventListener('change', () => onchange(s.value));
    return s;
  }
  function check(label, value, onchange) {
    const i = el('input', { type: 'checkbox', checked: !!value });
    i.addEventListener('change', () => onchange(i.checked));
    return el('label', { class: 'check' }, i, label);
  }
  function slider({ label, min, max, step, value, fmt: f, onInput, reset }) {
    const val = el('span', { class: 'val mono' }, f(value));
    const inp = el('input', { type: 'range', min, max, step, value });
    inp.addEventListener('input', () => { val.textContent = f(+inp.value); onInput(+inp.value); });
    inp.addEventListener('dblclick', () => { if (reset !== undefined) { inp.value = reset; val.textContent = f(reset); onInput(reset); } });
    return el('div', { class: 'slider', title: 'Double-click to reset' }, el('span', { class: 'lbl' }, label), inp, val);
  }

  /* ================= defaults ================= */
  const SHOT_COLORS = ['#64748b', '#2563eb', '#16a34a', '#d97706', '#dc2626', '#9333ea', '#0891b2', '#db2777'];
  const PANEL_DEFS = {
    monitors: { title: 'Video', hint: 'left = preview (next) · right = live' },
    audio: { title: 'Audio', hint: 'what the stream hears' },
    shots: { title: 'Shots', hint: 'click = next · double-click = on air' },
    media: { title: 'Service', hint: 'start and end the service' },
    speakers: { title: 'People', hint: 'click = preview, then TAKE · double-click = on screen now' },
    labels: { title: 'Titles & Graphics', hint: 'click to show / hide' },
    inputs: { title: 'Cameras & Files' },
    editor: { title: 'Shot Framing', hint: 'zoom and move the picture' },
    color: { title: 'Color & Exposure' }
  };
  // Two screens: "Run Show" has only what you touch during a service; "Setup" has the things you prepare beforehand.
  const LAYOUTS = {
    live: [['monitors', 9, 5], ['media', 3, 4], ['audio', 3, 4], ['shots', 9, 3], ['speakers', 6, 2], ['labels', 6, 2]],
    setup: [['monitors', 9, 5], ['audio', 3, 5], ['inputs', 4, 5], ['editor', 4, 5], ['color', 4, 5]]
  };
  const layoutFrom = name => {
    const L = LAYOUTS[name].map(([id, w, h]) => ({ id, w, h, hidden: false }));
    for (const id of Object.keys(PANEL_DEFS)) if (!L.find(x => x.id === id)) L.push({ id, w: 4, h: 4, hidden: true });
    return L;
  };
  const defaultLayouts = () => ({ live: layoutFrom('live'), setup: layoutFrom('setup') });

  const newShot = (name, source, color) => ({
    id: uid('shot'), name, color: color || SHOT_COLORS[1], role: '',
    main: { source: source || 'bars', frame: { zoom: 1, x: 0.5, y: 0.5 } },
    pip: { enabled: false, source: '', corner: 'tr', size: 0.3, frame: { zoom: 1, x: 0.5, y: 0.5 } },
    labelId: '', onEnd: { action: 'none', target: '' }
  });
  function defaultShow() {
    return {
      version: 1, showName: 'Live Show', firstRunDone: false,
      cameras: [], files: [],
      shots: [Object.assign(newShot('Color Bars', 'bars', SHOT_COLORS[0]), { id: 'shot_bars' }), Object.assign(newShot('Black', 'black', '#111827'), { id: 'shot_black' })],
      labels: [
        { id: uid('lbl'), title: 'Welcome', subtitle: 'We are glad you are here', style: 'lower', color: '#2563eb', autoHide: 0 },
        { id: uid('lbl'), title: 'LIVE', subtitle: '', style: 'corner', color: '#dc2626', autoHide: 0 }
      ],
      audio: { inputs: [], media: { gain: 0, mute: false }, master: { gain: 0, limiter: true, monitor: false, monitorGain: -6, mono: false } },
      transition: { ms: 600 },
      service: {
        hold: { mode: 'clock', target: '10:00', org: 'Pilgrim Baptist Church · Spokane, WA', title: 'Welcome', subtitle: 'Service will begin shortly', title2: 'Добро пожаловать', subtitle2: 'Служение скоро начнётся', lang2: 'ru', layout: 'side', dim: 0.35, blur: 0, accent: '#d4a24c', zoom: 1.06, focusX: 0.4, focusY: 0, bgColor: '#0b1a33', bgColor2: '#1e1b4b', bgFile: '', textColor: '#ffffff', autoStart: false },
        start: { record: true, goLive: true, videoId: '', fadeMs: 2000, cameraShot: '', ytLive: true },
        end: { videoId: '', fadeMs: 1500, then: 'hold', stopRec: true, endStream: true, endAfter: 30, ytComplete: true }
      },
      webs: [],
      pics: [],
      speakers: [
        { id: uid('spk'), name: 'Pastor Name', title: 'Senior Pastor', hotkey: '' },
        { id: uid('spk'), name: 'Worship Leader', title: 'Worship Team', hotkey: '' }
      ],
      speakerStyle: { style: 'lower', color: '#2563eb', autoHide: 8 }
    };
  }
  const defaultSettings = () => ({
    youtube: { server: 'rtmps://a.rtmps.youtube.com:443/live2', custom: '', key: '' },
    output: { width: 1920, height: 1080, fps: 30, bitrate: 8000, encoder: 'x264', audioBitrate: 160, recordBitrate: 20000, recordAudioBitrate: 256 },
    recordDir: '', autoRecord: false, ftbAudio: true, zebra: false, moveSpeed: 0.12,
    ui: { scale: 1, accent: '#3b82f6', card: 1, layouts: defaultLayouts(), layoutV: 4 },
    hotkeys: {}
  });
  function merge(base, over) {
    if (!over || typeof over !== 'object' || Array.isArray(over)) return over === undefined ? base : over;
    const out = Array.isArray(base) ? [] : Object.assign({}, base);
    for (const k of Object.keys(over)) out[k] = (base && typeof base[k] === 'object' && !Array.isArray(base[k]) && base[k] !== null) ? merge(base[k], over[k]) : over[k];
    return out;
  }

  /* ================= state ================= */
  let show = merge(defaultShow(), (await S.loadShow()) || {});
  let settings = merge(defaultSettings(), (await S.loadSettings()) || {});
  if (settings.ui.layoutV !== 4 || !settings.ui.layouts) { settings.ui.layouts = defaultLayouts(); settings.ui.layoutV = 4; delete settings.ui.layout; }
  for (const v of ['live', 'setup']) {
    if (!Array.isArray(settings.ui.layouts[v]) || !settings.ui.layouts[v].length) settings.ui.layouts[v] = layoutFrom(v);
    for (const id of Object.keys(PANEL_DEFS)) if (!settings.ui.layouts[v].find(x => x.id === id)) settings.ui.layouts[v].push({ id, w: 4, h: 4, hidden: true });
  }
  // 1.4.1: slimmer audio panel — give its space to the Service panel (keeps any other changes you made)
  if (!settings.ui.audioSlim) {
    const L = settings.ui.layouts.live, au = L.find(p => p.id === 'audio'), me = L.find(p => p.id === 'media');
    if (au && me && au.h === 5 && me.h === 3) { au.h = 4; me.h = 4; }
    settings.ui.audioSlim = true;
  }
  // 1.8.2: the stripe pattern on bright areas of the Preview (zebra) is now off unless you turn it on in Color & Exposure
  if (!settings.zebraV) { settings.zebra = false; settings.zebraV = 1; }
  let view = 'live';
  const curLayout = () => settings.ui.layouts[view];

  const saveShow = debounce(() => S.saveShow(show), 400);
  const saveSettings = debounce(() => S.saveSettings(settings), 400);
  const changed = () => saveShow();

  const rt = {
    previewId: null, editingId: null, colorSrc: null, padTarget: 'main',
    cams: new Map(), camStatus: new Map(), files: new Map(), audRetry: new Map(), audFail: new Map(),
    bodies: {}, thumbs: new Map(), views: new Map(), meters: new Map(),
    devices: { video: [], audio: [] },
    live: null, rec: null, liveStart: 0, recStart: 0, liveStats: null, recStats: null,
    reconnecting: false, slowSince: 0, labelTimers: new Map(), editing: false
  };
  const getShot = id => show.shots.find(s => s.id === id);
  const fileById = id => show.files.find(f => f.id === id);
  const camById = id => show.cameras.find(c => c.id === id);

  /* ================= engine + mixer ================= */
  let engine;
  try {
    engine = new Engine({ width: settings.output.width, height: settings.output.height, fps: settings.output.fps });
  } catch (e) {
    document.body.innerHTML = `<div style="padding:40px;font-size:18px">Live Studio could not start the video engine.<br><br>${e.message}<br><br>Update your graphics driver and restart.</div>`;
    return;
  }
  engine.getShot = getShot;
  engine.moveSpeed = settings.moveSpeed;
  engine.zebra = settings.zebra;
  engine.setSource('bars', makeBars(settings.output.width, settings.output.height), 'image');
  const blackCanvas = el('canvas', { width: 16, height: 9 }); blackCanvas.getContext('2d').fillRect(0, 0, 16, 9);
  engine.setSource('black', blackCanvas, 'image');
  engine.onTransitionEnd = () => { renderTally(); };
  const previewCanvas = el('canvas', { width: 960, height: Math.round(960 * settings.output.height / settings.output.width) });
  engine.previewCanvas = previewCanvas;
  engine.previewCtx = previewCanvas.getContext('2d');
  // keep the Preview picture pixel-sharp: match its resolution to the size it is shown at
  new ResizeObserver(() => {
    const w = Math.min(engine.W, Math.max(320, Math.round(previewCanvas.clientWidth * devicePixelRatio)));
    const h = Math.round(w * engine.H / engine.W);
    if (w && (previewCanvas.width !== w || previewCanvas.height !== h)) { previewCanvas.width = w; previewCanvas.height = h; }
  }).observe(previewCanvas);

  const mixer = new Mixer();
  mixer.setMaster(show.audio.master);
  mixer.update('media', show.audio.media);

  const BUILTIN = [['bars', 'Color bars'], ['black', 'Black']];
  function sourceOptions(includeNone) {
    const o = [];
    if (includeNone) o.push(['', '— none —']);
    show.cameras.forEach(c => o.push([c.id, `🎥 ${c.name}`]));
    show.files.forEach(f => o.push([f.id, `${f.kind === 'image' ? '🖼' : '🎞'} ${f.name}`]));
    BUILTIN.forEach(b => o.push(b));
    return o;
  }
  const sourceName = id => (camById(id) || fileById(id) || { name: (BUILTIN.find(b => b[0] === id) || [0, '—'])[1] }).name;

  /* ================= cameras ================= */
  /* Windows hands out new device ids each time the program starts, so devices are remembered by
     name + position among same-named devices (e.g. the 2nd "Blackmagic WDM Capture") and matched again on start-up. */
  function rememberDevice(item, kind) {
    const list = rt.devices[kind], d = list.find(x => x.id === item.deviceId);
    if (!d) return;
    item.deviceLabel = d.label; item.deviceIdx = list.filter(x => x.label === d.label).indexOf(d);
  }
  // Windows sometimes renames a card slightly ("Line In (2- Blackmagic…)", "Default - …"); compare without those bits
  const devKey = l => String(l || '').toLowerCase().replace(/^(default|communications)\s*-\s*/, '').replace(/\(\d+-\s*/g, '(').replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)/g, '').replace(/\s+/g, ' ').trim();
  function resolveDevices() {
    for (const [kind, items] of [['video', show.cameras], ['audio', show.audio.inputs]]) {
      const list = rt.devices[kind], claimed = new Set();
      for (const it of items) {                       // 1st pass: by remembered name + position
        if (!it.deviceLabel) { if (list.find(d => d.id === it.deviceId)) { rememberDevice(it, kind); claimed.add(it.deviceId); } continue; }
        const same = list.filter(d => d.label === it.deviceLabel);
        const d = it.deviceIdx !== undefined ? same[it.deviceIdx] : null;
        if (d && !claimed.has(d.id)) { it.deviceId = d.id; claimed.add(d.id); it._ok = true; } else it._ok = false;
      }
      for (const it of items) {                       // 2nd pass: next free device with the same name
        if (!it.deviceLabel || it._ok) { delete it._ok; continue; }
        delete it._ok;
        const d = list.find(x => x.label === it.deviceLabel && !claimed.has(x.id))
          || list.find(x => devKey(x.label) === devKey(it.deviceLabel) && !claimed.has(x.id) && x.id !== 'default' && x.id !== 'communications')
          || list.find(x => devKey(x.label) === devKey(it.deviceLabel));
        if (d) { it.deviceId = d.id; claimed.add(d.id); rememberDevice(it, kind); }
      }
    }
    changed();
  }
  async function refreshDevices() {
    try {
      let list = await navigator.mediaDevices.enumerateDevices();
      if (!list.some(d => d.kind === 'audioinput' && d.label) || !list.some(d => d.kind === 'videoinput' && d.label)) {
        try { const p = await navigator.mediaDevices.getUserMedia({ video: true, audio: true }); p.getTracks().forEach(t => t.stop()); } catch (e) { /* no permission */ }
        list = await navigator.mediaDevices.enumerateDevices();
      }
      rt.devices.video = list.filter(d => d.kind === 'videoinput').map(d => ({ id: d.deviceId, label: d.label || 'Camera' }));
      rt.devices.audio = list.filter(d => d.kind === 'audioinput').map(d => ({ id: d.deviceId, label: d.label || 'Audio input' }));
    } catch (e) { console.warn(e); }
  }
  navigator.mediaDevices && navigator.mediaDevices.addEventListener('devicechange', async () => {
    await refreshDevices();
    resolveDevices();
    for (const c of show.cameras) if (!rt.cams.has(c.id) && rt.devices.video.find(d => d.id === c.deviceId)) openCamera(c);
    for (const a of show.audio.inputs) if (!mixer.strips.has(a.id) && rt.devices.audio.find(d => d.id === a.deviceId)) openAudioInput(a, true);
    refresh('inputs');
  });
  function closeCamera(id) {
    const c = rt.cams.get(id);
    if (c) { c.stream.getTracks().forEach(t => t.stop()); c.v.remove(); rt.cams.delete(id); }
    engine.removeSource(id);
  }
  rt.camNote = new Map();
  async function openCamera(cam) {
    rt.camNote.delete(cam.id);
    closeCamera(cam.id);
    if (!cam.deviceId) { rt.camStatus.set(cam.id, { ok: false, text: 'Choose a device' }); refresh('inputs'); return; }
    if (!rt.devices.video.find(d => d.id === cam.deviceId)) {
      // device ids can change; try matching by name
      const byLabel = rt.devices.video.find(d => d.label === cam.deviceLabel);
      if (byLabel) cam.deviceId = byLabel.id;
    }
    const res = { 2160: [3840, 2160], 1080: [1920, 1080], 720: [1280, 720] }[cam.res || '1080'];
    rt.camStatus.set(cam.id, { ok: false, text: 'Connecting…' });
    try {
      // Blackmagic cards only give a picture when the requested format matches the camera's signal exactly (e.g. 1080p59.94)
      if (cam.fps === undefined) cam.fps = /blackmagic|decklink|intensity|ultrastudio/i.test(cam.deviceLabel || '') ? '59.94' : '';
      const fps = +cam.fps || 0;
      const base = { deviceId: { exact: cam.deviceId }, width: fps ? { exact: res[0] } : { ideal: res[0] }, height: fps ? { exact: res[1] } : { ideal: res[1] } };
      let stream;
      try { stream = await navigator.mediaDevices.getUserMedia({ video: Object.assign({}, base, { frameRate: fps ? { min: fps - 0.5, max: fps + 0.5, ideal: fps } : { ideal: settings.output.fps } }), audio: false }); }
      catch (e1) {
        if (!fps || e1.name !== 'OverconstrainedError') throw e1;
        stream = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: cam.deviceId }, width: { ideal: res[0] }, height: { ideal: res[1] }, frameRate: { ideal: fps } }, audio: false });
        rt.camNote.set(cam.id, ` — the card did not offer ${cam.res || 1080}p at ${cam.fps} fps`);
      }
      const v = el('video', { playsinline: true });
      v.muted = true; v.srcObject = stream;
      $('#sourceBin').append(v);
      await v.play().catch(() => {});
      rt.cams.set(cam.id, { stream, v });
      engine.setSource(cam.id, v, 'video');
      engine.setColor(cam.id, cam.color);
      const tr = stream.getVideoTracks()[0];
      const update = () => { const st = tr.getSettings(); rt.camStatus.set(cam.id, { ok: true, text: `${v.videoWidth || st.width}×${v.videoHeight || st.height} · ${(+(st.frameRate || 0).toFixed(2))} fps${rt.camNote.get(cam.id) || ''}` }); refreshInputStatus(); };
      v.addEventListener('resize', update); v.addEventListener('loadedmetadata', update);
      tr.addEventListener('ended', () => {
        rt.camStatus.set(cam.id, { ok: false, text: 'Disconnected — retrying…' }); refreshInputStatus();
        setTimeout(() => { if (camById(cam.id)) refreshDevices().then(() => openCamera(cam)); }, 3000);
      });
    } catch (e) {
      rt.camStatus.set(cam.id, { ok: false, text: e.name === 'NotReadableError' ? 'Device busy (close other apps using it)' : `Not available: ${e.message || e.name}` });
    }
    refreshInputStatus();
  }

  /* ================= files (intro / ending / clips / images) ================= */
  async function urlForFile(f) {
    if (S.readMedia) {
      const bytes = await S.readMedia(f.path);
      const ext = (f.path.split('.').pop() || '').toLowerCase();
      const types = { mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', jfif: 'image/jpeg', bmp: 'image/bmp', avif: 'image/avif', webp: 'image/webp', gif: 'image/gif' };
      return URL.createObjectURL(new Blob([bytes], { type: types[ext] || '' }));
    }
    return S.mediaURL(f.path);
  }
  function unloadFile(id) {
    const m = rt.files.get(id);
    if (m && m.el) { try { m.el.pause(); } catch (e) { /* */ } m.el.remove(); if (m.url && m.url.startsWith('blob:') && S.isApp) URL.revokeObjectURL(m.url); }
    mixer.detachMedia(id);
    engine.removeSource(id);
    rt.files.delete(id);
  }
  async function loadFile(f) {
    unloadFile(f.id);
    rt.files.set(f.id, { ok: false, text: 'Loading…' });
    let v = null;
    try {
      const url = await urlForFile(f);
      if (f.kind === 'image') {
        const img = new Image(); img.src = url; await img.decode();
        engine.setSource(f.id, img, 'image');
        rt.files.set(f.id, { ok: true, el: img, url, text: `${img.naturalWidth}×${img.naturalHeight}` });
      } else {
        v = el('video', { playsinline: true, preload: 'auto' });
        v.src = url; v.loop = !!f.loop;
        $('#sourceBin').append(v);
        await new Promise((res, rej) => {
          v.addEventListener('loadeddata', res, { once: true });
          v.addEventListener('error', () => { const err = new Error('This video format can\'t be played directly.'); err.unsupported = !!(v.error && v.error.code >= 3); rej(err); }, { once: true });
        });
        if (!v.videoWidth) { const err = new Error('The picture in this video can\'t be played directly (only sound).'); err.unsupported = true; throw err; }
        v.pause(); v.currentTime = 0;
        engine.setSource(f.id, v, 'video');
        engine.setColor(f.id, f.color);
        mixer.attachMedia(f.id, v);
        v.addEventListener('ended', () => onMediaEnded(f.id));
        rt.files.set(f.id, { ok: true, el: v, url, text: `${v.videoWidth}×${v.videoHeight} · ${fmtShort(v.duration)}`, duration: v.duration });
      }
    } catch (e) {
      if (v) { v.removeAttribute('src'); v.remove(); }
      if (e.unsupported) rt.files.set(f.id, { ok: false, unsupported: true, text: `${e.message} Click “Convert to MP4”.` });
      else rt.files.set(f.id, { ok: false, text: S.isApp ? `Missing or unreadable: ${e.message}` : 'Re-add this file (browser mode)' });
    }
    refresh('inputs'); refresh('media');
    if (show.pics.some(p2 => p2.fileId === f.id)) { refreshWebs(); refresh('labels'); }
  }
  async function addFiles() {
    const picked = await S.pickMedia();
    const added = [];
    for (const p of picked || []) {
      const kind = /\.(png|jpe?g|jfif|webp|gif|bmp|avif)$/i.test(p.name) ? 'image' : 'video';
      const f = { id: uid('file'), name: p.name.replace(/\.[^.]+$/, ''), path: p.path, kind, loop: false, color: clone(NEUTRAL) };
      show.files.push(f); added.push(f);
      await loadFile(f);
    }
    if (added.length) { changed(); refreshAll(); }
    return added;
  }
  const mediaOf = shot => shot ? [shot.main && shot.main.source, shot.pip && shot.pip.enabled ? shot.pip.source : null]
    .filter(id => id && (fileById(id) || {}).kind === 'video') : [];

  /* ================= switching ================= */
  function setPreview(id) {
    rt.previewId = id; engine.previewId = id;
    const onAir = mediaOf(getShot(engine.programId));
    for (const m of mediaOf(getShot(id))) {
      const f = rt.files.get(m);
      if (f && f.el && !onAir.includes(m) && f.el.paused) f.el.currentTime = 0;
    }
    renderTally();
  }
  function startProgram(toId, fromId, ms) {
    const to = getShot(toId), from = getShot(fromId);
    const toM = mediaOf(to), fromM = mediaOf(from);
    for (const id of toM) {
      if (fromM.includes(id)) continue;
      const f = rt.files.get(id);
      if (f && f.el) {
        // the before-service video can loop until you start the service
        f.el.loop = !!(fileById(id) || {}).loop && !to.role;
        f.el.currentTime = 0; f.el.play().catch(() => {}); mixer.setMediaActive(id, true, Math.max(60, ms));
      }
    }
    for (const id of fromM) {
      if (toM.includes(id)) continue;
      mixer.setMediaActive(id, false, Math.max(60, ms));
      setTimeout(() => {
        if (!mediaOf(getShot(engine.programId)).includes(id)) { const f = rt.files.get(id); if (f && f.el) f.el.pause(); }
      }, ms + 80);
    }
    // labels linked to shots
    if (from && from.labelId && (!to || to.labelId !== from.labelId)) setLabelVisible(from.labelId, false);
    if (to && to.labelId) setLabelVisible(to.labelId, true);
  }
  function take(kind, msOverride) {
    // a person cued in Preview goes on air with TAKE / CUT (the camera shot stays as it is)
    if (rt.armedSpk && msOverride === undefined) { const id = rt.armedSpk; armSpeaker(null); showSpeaker(id); return; }
    if (engine.inTransition) return;
    const to = rt.previewId, from = engine.programId;
    if (!to || to === from) return;
    const ms = kind === 'cut' ? 0 : (msOverride !== undefined ? msOverride : show.transition.ms);
    startProgram(to, from, ms);
    if (ms) engine.fade(to, ms); else engine.cut(to);
    audioGate(ms, to);
    rt.previewId = from || to; engine.previewId = rt.previewId;
    rt.webSuppress.clear();
    refreshWebs();
    renderTally();
  }
  function takeShot(id, kind, ms) { if (!getShot(id) || id === engine.programId) return; setPreview(id); take(kind, ms); }
  // the stream is silent while the holding slide is on air (and during fade to black)
  function audioGate(ms, targetId) {
    const sh = getShot(targetId || (engine.trans ? engine.trans.to : engine.programId));
    const silent = (engine.isBlack && settings.ftbAudio) || (!!sh && sh.role === 'hold' && SV().hold.mute !== false);
    // coming out of the holding slide, the sound fades in gently even on a hard cut
    if (!silent && rt.holdSilent) ms = Math.max(ms || 0, SV().hold.audioFade ?? 1500);
    rt.holdSilent = !!sh && sh.role === 'hold' && SV().hold.mute !== false;
    rt.gated = silent;
    mixer.fadeMaster(!silent, Math.max(50, ms || 300));
  }
  function setBlack(on) {
    engine.setBlack(on, show.transition.ms || 500);
    audioGate(show.transition.ms || 500);
    renderTally();
  }
  function onMediaEnded(fileId) {
    const shot = getShot(engine.programId);
    if (!shot || shot.main.source !== fileId) return;
    const a = shot.onEnd || {};
    if (a.action === 'goto' && getShot(a.target)) takeShot(a.target, 'auto', a.fadeMs);
    else if (a.action === 'black') setBlack(true);
    else if (a.action === 'stop') { setBlack(true); setTimeout(() => { if (rt.live) stopLive(); }, (show.transition.ms || 500) + 1500); }
    else if (a.action === 'serviceEnded') serviceEnded();
    if (a.action === 'goto' && shot.role === 'open') setServiceState('running');
  }

  /* ================= service: holding screen → START SERVICE → … → END SERVICE ================= */
  // Three built-in shots with a role: 'hold' (clock screen), 'open' (opening video), 'close' (closing video).
  const firstCameraShot = () => show.shots.find(x => !x.role && show.cameras.some(c => c.id === x.main.source)) || show.shots.find(x => !x.role);
  const roleShot = role => show.shots.find(x => x.role === role);
  const SV = () => show.service;
  function syncRoleShots() {
    show.shots = show.shots.filter(x => !['intro', 'ending'].includes(x.role)); // older versions
    let h = roleShot('hold');
    if (!h) { h = newShot('Holding screen', 'hold', '#0891b2'); h.role = 'hold'; h.id = 'shot_hold'; show.shots.unshift(h); }
    // if the slide's picture source was swapped for a photo (older versions allowed that), use the photo as the slide's background instead
    if (h.main.source !== 'hold') { const f = fileById(h.main.source); if (f && f.kind === 'image') SV().hold.bgFile = f.id; h.main.frame = { zoom: 1, x: 0.5, y: 0.5 }; }
    h.main.source = 'hold';
    h.main.frame = { zoom: 1, x: 0.5, y: 0.5 }; h.pip.enabled = false;
    for (const [role, cfg, name] of [['open', SV().start, 'Opening video'], ['close', SV().end, 'Closing video']]) {
      let s = roleShot(role);
      if (!cfg.videoId || !fileById(cfg.videoId)) { if (s && s.id !== engine.programId) show.shots = show.shots.filter(x => x !== s); continue; }
      if (!s) { s = newShot(name, cfg.videoId, '#d97706'); s.role = role; show.shots.push(s); }
      s.main.source = cfg.videoId;
    }
    if (!getShot(SV().start.cameraShot)) { const c = firstCameraShot(); SV().start.cameraShot = c ? c.id : ''; }
    const o = roleShot('open');
    if (o) o.onEnd = { action: 'goto', target: SV().start.cameraShot, fadeMs: SV().start.fadeMs };
    const c = roleShot('close');
    if (c) c.onEnd = { action: 'serviceEnded' };
  }
  function setServiceState(st) { rt.service = st; refreshServiceState(); }
  async function startService() {
    syncRoleShots();
    const st = SV().start;
    const cam = getShot(st.cameraShot) || firstCameraShot();
    if (!cam) { toast('Add a camera first (Setup → Cameras).', 'error'); return; }
    clearEndTimer();
    if (engine.isBlack) setBlack(false);
    if (st.goLive && !rt.live) await goLive(true);
    if (st.record && !rt.rec) startRec();
    const o = roleShot('open');
    if (o && rt.files.get(o.main.source) && rt.files.get(o.main.source).ok) { takeShot(o.id, 'auto', 800); setServiceState('opening'); }
    else { takeShot(cam.id, 'auto', st.fadeMs); setServiceState('running'); }
    if (st.ytLive) ytGoLiveWhenReady();
  }
  function endService() {
    syncRoleShots();
    clearEndTimer();
    const c = roleShot('close');
    if (c && rt.files.get(c.main.source) && rt.files.get(c.main.source).ok) { takeShot(c.id, 'auto', SV().end.fadeMs); setServiceState('closing'); }
    else serviceEnded();
  }
  function serviceEnded() {
    const e = SV().end;
    if (e.then === 'hold') takeShot('shot_hold', 'auto', e.fadeMs);
    else setBlack(true);
    if (e.stopRec && rt.rec) setTimeout(stopRec, e.fadeMs + 500);
    setServiceState('ended');
    if (e.endStream && rt.live) {
      rt.endAt = Date.now() + e.endAfter * 1000;
      rt.endTimer = setInterval(() => {
        if (!rt.live) return clearEndTimer();
        if (Date.now() >= rt.endAt) { clearEndTimer(); if (e.ytComplete) ytComplete(); stopLive(); }
        refreshServiceState();
      }, 500);
    } else if (e.ytComplete && !rt.live) ytComplete();
  }
  function clearEndTimer() { clearInterval(rt.endTimer); rt.endTimer = null; rt.endAt = 0; refreshServiceState(); }
  function showHold() { if (engine.isBlack) setBlack(false); takeShot('shot_hold', 'auto'); setServiceState('hold'); }

  /* the holding screen: a clock or countdown drawn into its own picture source */
  const holdCanvas = el('canvas', { width: 1920, height: 1080 });
  const holdCtx = holdCanvas.getContext('2d');
  let holdBg = null, holdBgKey = '';
  function holdTarget() {
    const h = SV().hold;
    if (h.mode === 'youtube' && rt.yt && rt.yt.event && rt.yt.event.start) return new Date(rt.yt.event.start);
    const [hh, mm] = (h.target || '10:00').split(':').map(Number);
    const t = new Date(); t.setHours(hh || 0, mm || 0, 0, 0);
    if (t - Date.now() < -60 * 60 * 1000) t.setDate(t.getDate() + 1);
    return t;
  }
  /* The holding slide is made of items (text lines, accent line, clock) that can each be moved and styled. */
  const HOLD_LAYOUTS = {
    side: { org: [150, 150, 30, 'left'], bar: [150, 190, 0, 'left'], title: [145, 320, 124, 'left'], title2: [148, 406, 66, 'left'], sub: [150, 486, 46, 'left'], sub2: [150, 544, 46, 'left'], clock: [146, 640, 150, 'left'] },
    center: { org: [960, 110, 30, 'center'], bar: [960, 150, 0, 'center'], title: [960, 290, 110, 'center'], title2: [960, 372, 62, 'center'], sub: [960, 450, 46, 'center'], sub2: [960, 508, 46, 'center'], clock: [960, 590, 150, 'center'] }
  };
  function ensureHold() {
    const h = SV().hold;
    if (!Array.isArray(h.elements)) {
      const T = (id, name, text, weight, color, extra) => Object.assign({ id, type: 'text', name, text: text || '', weight, color, on: true }, extra);
      h.elements = [
        T('org', 'Church name', h.org, 600, '#e6e9f0', { upper: true, spacing: 4 }),
        { id: 'bar', type: 'bar', name: 'Accent line', w: 90, h: 8, on: true },
        T('title', 'Title', h.title, 700, '#ffffff'), T('title2', 'Title (2nd language)', h.title2, 600, '#f1f3f7'),
        T('sub', 'Message', h.subtitle, 300, '#eef0f5'), T('sub2', 'Message (2nd language)', h.subtitle2, 300, '#c9ced9'),
        { id: 'clock', type: 'clock', name: 'Clock', color: h.textColor || '#ffffff', card: true, label: true, on: true }
      ];
      h.bgStyle = h.layout === 'center' ? 'full' : 'side';
      applyHoldLayout(h, h.layout === 'center' ? 'center' : 'side');
    }
    if (!h.font) h.font = 'Segoe UI';
    return h;
  }
  function applyHoldLayout(h, name) {
    const L = HOLD_LAYOUTS[name];
    for (const e of h.elements) { const p = L[e.id]; if (!p) continue; e.x = p[0]; e.y = p[1]; if (p[2]) e.size = p[2]; e.align = p[3]; }
  }
  function drawHold() {
    const h = Object.assign({ dim: 0.35, blur: 0, accent: '#d4a24c' }, ensureHold()), W = 1920, H = 1080, g = holdCtx;
    const f = h.bgFile && rt.files.get(h.bgFile);
    if (holdBgKey !== h.bgFile) { holdBgKey = h.bgFile; holdBg = null; }
    if (f && f.ok && f.el && f.el.tagName === 'IMG') holdBg = f.el;
    g.save();
    if (holdBg && h.bgFile) {
      const iw = holdBg.naturalWidth, ih = holdBg.naturalHeight;
      if (h.bgStyle === 'side') {
        const x0 = W * 0.30, rw = W - x0;
        g.fillStyle = '#090b12'; g.fillRect(0, 0, W, H);
        g.filter = h.blur ? `blur(${h.blur}px)` : 'none';
        const sc = Math.max(rw / iw, H / ih) * (h.zoom || 1), dw = iw * sc, dh = ih * sc;
        g.save(); g.beginPath(); g.rect(x0, 0, rw, H); g.clip();
        g.drawImage(holdBg, x0 + (rw - dw) * (h.focusX ?? 0.5), (H - dh) * (h.focusY ?? 0.5), dw, dh);
        g.restore(); g.filter = 'none';
        const fw = rw * (h.fade ?? 0.5);
        const gr = g.createLinearGradient(x0 - 1, 0, x0 + fw, 0);
        gr.addColorStop(0, 'rgba(9,11,18,1)'); gr.addColorStop(0.3, 'rgba(9,11,18,.82)'); gr.addColorStop(0.65, 'rgba(9,11,18,.35)'); gr.addColorStop(1, 'rgba(9,11,18,0)');
        g.fillStyle = gr; g.fillRect(x0 - 1, 0, fw + 1, H);
        g.fillStyle = `rgba(6,8,14,${h.dim * 0.45})`; g.fillRect(x0, 0, rw, H);
      } else {
        const sc = Math.max(W / iw, H / ih) * (h.blur ? 1.04 : 1) * (h.zoom || 1);
        if (h.blur) g.filter = `blur(${h.blur}px)`;
        g.drawImage(holdBg, (W - iw * sc) * (h.focusX ?? 0.5), (H - ih * sc) * (h.focusY ?? 0.5), iw * sc, ih * sc);
        g.filter = 'none';
        g.fillStyle = `rgba(6,8,14,${h.dim})`; g.fillRect(0, 0, W, H);
      }
    } else {
      const gr = g.createLinearGradient(0, 0, W, H); gr.addColorStop(0, h.bgColor); gr.addColorStop(1, h.bgColor2 || h.bgColor);
      g.fillStyle = gr; g.fillRect(0, 0, W, H);
    }
    g.restore();
    const font = `"${h.font}", "Segoe UI", Inter, system-ui, sans-serif`;
    const now = new Date();
    let big, small;
    const second = h.lang2 && Math.floor(now / 6000) % 2 === 1;
    const loc = second ? h.lang2 : 'en-US';
    const TX = { en: ['Service starts in', 'Starting now'], ru: ['Служение начнётся через', 'Начинаем'], uk: ['Служіння почнеться через', 'Починаємо'] };
    const tx = TX[second ? h.lang2 : 'en'] || TX.en;
    if (h.mode === 'clock') { big = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }); small = now.toLocaleDateString(loc, { weekday: 'long', month: 'long', day: 'numeric' }); }
    else {
      const left = Math.round((holdTarget() - now) / 1000);
      if (left > 0) { const m = Math.floor(left / 60), sec = left % 60, hr = Math.floor(m / 60); big = hr ? `${hr}:${String(m % 60).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`; small = tx[0]; }
      else { big = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }); small = tx[1]; }
      if (left <= 0 && h.autoStart && rt.service === 'hold' && !rt.autoStarted) { rt.autoStarted = true; startService(); }
    }
    const boxes = [];
    g.textBaseline = 'alphabetic';
    for (const e of h.elements) {
      if (!e.on) continue;
      const al = e.align || 'left';
      const left = w => al === 'left' ? e.x : al === 'center' ? e.x - w / 2 : e.x - w;
      if (e.type === 'bar') {
        g.fillStyle = e.color || h.accent; g.fillRect(left(e.w), e.y, e.w, e.h);
        boxes.push({ id: e.id, x: left(e.w), y: e.y - 8, w: e.w, h: e.h + 16 });
      } else if (e.type === 'clock') {
        const z = e.size, pad = z * 0.27;
        g.font = `200 ${z}px ${font}`; const tw = g.measureText(big).width;
        const lab = e.label !== false ? small.toUpperCase() : '';
        g.font = `600 ${z * 0.2}px ${font}`; const lw = lab ? g.measureText(lab).width : 0;
        const cw = Math.max(tw, lw) + pad * 2, top = lab ? z * 0.5 : z * 0.15, chh = top + z * 1.15;
        const x0 = left(cw);
        if (e.card !== false) { g.fillStyle = 'rgba(255,255,255,.08)'; roundRectPath(g, x0, e.y, cw, chh, z * 0.15); g.fill(); g.strokeStyle = 'rgba(255,255,255,.16)'; g.lineWidth = 2; g.stroke(); }
        g.textAlign = al === 'center' ? 'center' : 'left';
        const tx0 = al === 'center' ? x0 + cw / 2 : x0 + pad;
        if (lab) { g.fillStyle = h.accent; g.font = `600 ${z * 0.2}px ${font}`; g.fillText(lab, tx0, e.y + z * 0.4); }
        g.shadowColor = 'rgba(0,0,0,.5)'; g.shadowBlur = e.card !== false ? 0 : 20;
        g.fillStyle = e.color || '#fff'; g.font = `200 ${z}px ${font}`; g.fillText(big, tx0 - (al === 'center' ? 0 : z * 0.04), e.y + top + z * 0.87);
        g.shadowBlur = 0;
        boxes.push({ id: e.id, x: x0, y: e.y, w: cw, h: chh });
      } else {
        const txt = e.upper ? (e.text || '').toUpperCase() : (e.text || '');
        g.font = `${e.weight || 400} ${e.size}px ${font}`; g.letterSpacing = `${e.spacing || 0}px`;
        g.textAlign = al; g.fillStyle = e.color || '#fff';
        g.shadowColor = 'rgba(0,0,0,.55)'; g.shadowBlur = e.shadow === false ? 0 : Math.max(6, e.size * 0.18); g.shadowOffsetY = 2;
        g.fillText(txt, e.x, e.y);
        const w = Math.max(40, g.measureText(txt).width);
        g.shadowBlur = 0; g.shadowOffsetY = 0; g.letterSpacing = '0px';
        boxes.push({ id: e.id, x: left(w), y: e.y - e.size * 0.85, w, h: e.size * 1.1 });
      }
    }
    g.textAlign = 'left';
    rt.holdBoxes = boxes;
    const src = engine.sources.get('hold'); if (src) src.dirty = true;
  }

  /* slide designer: drag items on the preview, style each one, set the background and the clock */
  function openHoldDesigner() {
    const h = ensureHold();
    let sel = 'title', tab = 'items', raf = 0, drag = null;
    const pv = el('canvas', { width: 960, height: 540, class: 'hold-stage' });
    const side = el('div', { class: 'hd-side' });
    const done = () => { changed(); drawHold(); };
    const E = () => h.elements.find(e => e.id === sel);
    const paint = () => {
      if (!pv.isConnected) return;
      const g = pv.getContext('2d');
      g.drawImage(holdCanvas, 0, 0, 960, 540);
      const b = (rt.holdBoxes || []).find(x => x.id === sel);
      if (b && tab === 'items') { g.strokeStyle = '#38bdf8'; g.lineWidth = 2; g.setLineDash([6, 4]); g.strokeRect(b.x / 2 - 4, b.y / 2 - 4, b.w / 2 + 8, b.h / 2 + 8); g.setLineDash([]); }
      raf = requestAnimationFrame(paint);
    };
    const pos = ev => { const r = pv.getBoundingClientRect(); return [(ev.clientX - r.left) / r.width * 1920, (ev.clientY - r.top) / r.height * 1080]; };
    pv.addEventListener('pointerdown', ev => {
      const [x, y] = pos(ev);
      const hit = [...(rt.holdBoxes || [])].reverse().find(b => x >= b.x - 10 && x <= b.x + b.w + 10 && y >= b.y - 10 && y <= b.y + b.h + 10);
      if (!hit) return;
      sel = hit.id; tab = 'items'; const e = E();
      drag = { x, y, ex: e.x, ey: e.y }; pv.setPointerCapture(ev.pointerId); draw();
    });
    pv.addEventListener('pointermove', ev => { if (!drag) return; const [x, y] = pos(ev), e = E(); e.x = Math.round(drag.ex + x - drag.x); e.y = Math.round(drag.ey + y - drag.y); drawHold(); });
    pv.addEventListener('pointerup', () => { if (drag) { drag = null; done(); draw(); } });
    const colorIn = (label, value, fn) => el('label', { class: 'inline' }, el('input', { type: 'color', value, oninput: e => fn(e.target.value) }), label);
    const draw = () => {
      side.innerHTML = '';
      put(side, el('div', { class: 'tabs' }, [['items', '✏ Text & items'], ['bg', '🖼 Background'], ['clock', '🕘 Clock']].map(([k, t]) => el('button', { class: 'tab' + (tab === k ? ' sel' : ''), onclick: () => { tab = k; draw(); } }, t))));
      if (tab === 'items') {
        const e = E() || h.elements[0]; sel = e.id;
        put(side,
          el('div', { class: 'hd-list' }, h.elements.map(x => el('div', { class: 'hd-item' + (x.id === sel ? ' sel' : ''), onclick: () => { sel = x.id; draw(); } },
            el('input', { type: 'checkbox', checked: x.on, title: 'Show / hide', onclick: ev => ev.stopPropagation(), onchange: ev => { x.on = ev.target.checked; done(); } }),
            el('span', { class: 'grow' }, x.type === 'text' ? (x.text || x.name) : x.name)))),
          el('button', { class: 'btn small', style: 'margin:6px 0 12px', onclick: () => { const n = { id: uid('txt'), type: 'text', name: 'Text line', text: 'New text', x: 150, y: 900, size: 46, weight: 400, color: '#ffffff', align: 'left', on: true, custom: true }; h.elements.push(n); sel = n.id; done(); draw(); } }, '+ Add text line'),
          el('h3', null, e.name),
          e.type === 'text' ? el('div', { class: 'field' }, el('span', null, 'Text'), el('input', { type: 'text', value: e.text, oninput: ev => { e.text = ev.target.value; done(); } })) : null,
          e.type !== 'bar' ? slider({ label: 'Size', min: 16, max: 320, step: 1, value: e.size, fmt: v => `${v}`, onInput: v => { e.size = v; done(); } }) : null,
          e.type === 'bar' ? slider({ label: 'Length', min: 20, max: 1200, step: 2, value: e.w, fmt: v => `${v}`, onInput: v => { e.w = v; done(); } }) : null,
          e.type === 'bar' ? slider({ label: 'Thickness', min: 2, max: 40, step: 1, value: e.h, fmt: v => `${v}`, onInput: v => { e.h = v; done(); } }) : null,
          slider({ label: 'Left ↔ right', min: 0, max: 1920, step: 1, value: e.x, fmt: v => `${v}`, onInput: v => { e.x = v; done(); } }),
          slider({ label: 'Up ↕ down', min: 0, max: 1080, step: 1, value: e.y, fmt: v => `${v}`, onInput: v => { e.y = v; done(); } }),
          el('div', { class: 'row wrap', style: 'gap:10px;margin:8px 0' },
            select([['left', 'Align left'], ['center', 'Centre'], ['right', 'Align right']], e.align || 'left', v => { e.align = v; done(); }),
            e.type === 'text' ? select([[300, 'Light'], [400, 'Regular'], [600, 'Semi-bold'], [700, 'Bold'], [800, 'Extra bold']], e.weight, v => { e.weight = +v; done(); }) : null,
            colorIn('Colour', e.color || h.accent, v => { e.color = v; done(); })),
          e.type === 'text' ? el('div', { class: 'row wrap', style: 'gap:14px' }, check(' ALL CAPS', e.upper, v => { e.upper = v; done(); }), check(' Shadow', e.shadow !== false, v => { e.shadow = v; done(); }),
            el('label', { class: 'inline' }, 'Letter spacing', el('input', { type: 'number', value: e.spacing || 0, min: 0, max: 30, style: 'width:64px', oninput: ev => { e.spacing = +ev.target.value || 0; done(); } }))) : null,
          e.type === 'clock' ? el('div', { class: 'row wrap', style: 'gap:14px' }, check(' Box behind the clock', e.card !== false, v => { e.card = v; done(); }), check(' Date / “starts in” line', e.label !== false, v => { e.label = v; done(); })) : null,
          e.custom ? el('button', { class: 'btn small danger', style: 'margin-top:10px', onclick: () => { h.elements = h.elements.filter(x => x !== e); sel = 'title'; done(); draw(); } }, 'Delete this line') : null,
          el('h3', null, 'Whole slide'),
          el('div', { class: 'row wrap', style: 'gap:8px' },
            el('button', { class: 'btn small', onclick: () => { applyHoldLayout(h, 'side'); h.bgStyle = 'side'; done(); draw(); } }, 'Arrange: text on left'),
            el('button', { class: 'btn small', onclick: () => { applyHoldLayout(h, 'center'); h.bgStyle = 'full'; done(); draw(); } }, 'Arrange: centred'),
            select(['Segoe UI', 'Arial', 'Calibri', 'Verdana', 'Trebuchet MS', 'Bahnschrift', 'Georgia', 'Times New Roman', 'Impact'].map(f => [f, 'Font: ' + f]), h.font, v => { h.font = v; done(); }),
            colorIn('Accent', h.accent || '#d4a24c', v => { h.accent = v; done(); })));
      } else if (tab === 'bg') {
        const imgs = show.files.filter(f => f.kind === 'image'), st = h.bgFile ? rt.files.get(h.bgFile) : null;
        put(side,
          el('div', { class: 'field' }, el('span', null, 'Background picture'), el('div', { class: 'row' },
            select([['', '— none (use colours) —'], ...imgs.map(f => [f.id, f.name])], h.bgFile, v => { h.bgFile = v; done(); draw(); }, { class: 'grow' }),
            el('button', { class: 'btn small primary', onclick: async () => { const a2 = await addFiles(); const i = a2.find(f => f.kind === 'image'); if (i) { h.bgFile = i.id; done(); } else if (a2.length) toast('That file is not a picture. Use JPG or PNG.', 'error'); draw(); } }, 'Import picture…'))),
          h.bgFile ? el('div', { class: st && st.ok ? 'status-ok' : 'status-bad', style: 'font-size:.9em;margin:-4px 0 10px' }, st ? (st.ok ? `✓ Picture loaded (${st.text})` : `✗ ${st.text}`) : '✗ Picture file not found — import it again') : null,
          h.bgFile ? el('div', null,
            el('div', { class: 'field' }, el('span', null, 'Picture style'), select([['side', 'Picture on the right, dark panel behind text'], ['full', 'Picture fills the whole slide']], h.bgStyle, v => { h.bgStyle = v; done(); })),
            slider({ label: 'Darken', min: 0, max: 0.9, step: 0.01, value: h.dim ?? 0.35, reset: 0.35, fmt: v => `${Math.round(v * 100)}%`, onInput: v => { h.dim = v; done(); } }),
            slider({ label: 'Blur', min: 0, max: 20, step: 1, value: h.blur || 0, reset: 0, fmt: v => v ? `${v}` : 'off', onInput: v => { h.blur = v; done(); } }),
            slider({ label: 'Zoom', min: 1, max: 2.5, step: 0.01, value: h.zoom || 1, reset: 1, fmt: v => `${Math.round(v * 100)}%`, onInput: v => { h.zoom = v; done(); } }),
            slider({ label: 'Move left / right', min: 0, max: 1, step: 0.01, value: h.focusX ?? 0.5, reset: 0.5, fmt: v => `${Math.round(v * 100)}`, onInput: v => { h.focusX = v; done(); } }),
            slider({ label: 'Move up / down', min: 0, max: 1, step: 0.01, value: h.focusY ?? 0.5, reset: 0.5, fmt: v => `${Math.round(v * 100)}`, onInput: v => { h.focusY = v; done(); } }),
            h.bgStyle === 'side' ? slider({ label: 'Edge fade', min: 0.05, max: 1, step: 0.01, value: h.fade ?? 0.5, reset: 0.5, fmt: v => `${Math.round(v * 100)}%`, onInput: v => { h.fade = v; done(); } }) : null) : null,
          el('h3', null, 'Colours (when there is no picture)'),
          el('div', { class: 'row wrap', style: 'gap:14px' }, colorIn('Colour 1', h.bgColor, v => { h.bgColor = v; done(); }), colorIn('Colour 2', h.bgColor2 || h.bgColor, v => { h.bgColor2 = v; done(); })));
      } else {
        put(side,
          el('div', { class: 'field' }, el('span', null, 'The clock shows'), select([['clock', 'The time now'], ['countdown', 'Countdown to a start time'], ['youtube', 'Countdown to the YouTube event time']], h.mode, v => { h.mode = v; done(); draw(); })),
          h.mode === 'countdown' ? el('div', { class: 'field' }, el('span', null, 'Service starts at'), el('input', { type: 'time', value: h.target, oninput: e => { h.target = e.target.value; done(); } })) : null,
          h.mode !== 'clock' ? check(' Press START SERVICE automatically when the countdown ends', h.autoStart, v => { h.autoStart = v; done(); }) : null,
          el('div', { class: 'field', style: 'margin-top:10px' }, el('span', null, 'Date and countdown words'), select([['', 'English only'], ['ru', 'English and Russian (switch every 6 s)'], ['uk', 'English and Ukrainian (switch every 6 s)']], h.lang2 || '', v => { h.lang2 = v; done(); })),
          el('div', { style: 'margin:10px 0' }, check(' Mute all audio while the holding slide is on air', h.mute !== false, v => { h.mute = v; done(); audioGate(200); })),
          el('div', { class: 'field' }, el('span', null, 'Sound fades in when leaving the slide'), select([[300, 'Quick — 0.3 s'], [1000, '1 second'], [1500, '1.5 seconds'], [2000, '2 seconds'], [3000, '3 seconds'], [5000, '5 seconds']], h.audioFade ?? 1500, v => { h.audioFade = +v; done(); })),
          el('div', { class: 'muted', style: 'font-size:.85em' }, 'To move or resize the clock, click it on the slide (Text & items tab).'));
      }
      put(side, el('div', { class: 'row', style: 'margin-top:16px' }, el('span', { class: 'grow' }), el('button', { class: 'btn primary', onclick: () => { closeModal(); refresh('media'); refresh('shots'); } }, 'Done')));
    };
    draw();
    openModal('Design the holding slide', el('div', { class: 'hold-designer' }, el('div', { class: 'hd-stage' }, pv, el('div', { class: 'muted', style: 'font-size:.85em;margin-top:6px' }, 'Click an item on the slide to select it, then drag it to move it.')), side));
    cancelAnimationFrame(raf); raf = requestAnimationFrame(paint);
  }
  function roundRectPath(g, x, y, w, h, r) { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); }
  engine.setSource('hold', holdCanvas, 'image');
  let lastHoldSec = -1;
  setInterval(() => { const s2 = Math.floor(Date.now() / 1000); if (s2 !== lastHoldSec) { lastHoldSec = s2; drawHold(); } }, 100);

  /* ================= labels ================= */
  function setLabelVisible(id, on) {
    if (id && id.startsWith('spk_')) { if (on) showSpeaker(id); else if (rt.speakerId === id) hideSpeaker(); return; }
    const L = show.labels.find(l => l.id === id);
    if (!L) return;
    engine.setLabel(L, on);
    clearTimeout(rt.labelTimers.get(id));
    rt.hideAt.delete(id);
    if (on && L.autoHide > 0) { rt.labelTimers.set(id, setTimeout(() => setLabelVisible(id, false), L.autoHide * 1000)); rt.hideAt.set(id, { at: Date.now() + L.autoHide * 1000, total: L.autoHide * 1000 }); }
    refreshLabelStates();
  }
  const toggleLabel = id => setLabelVisible(id, !engine.labelVisible(id));
  show.labels.forEach(l => engine.setLabel(l, false));

  /* ================= speakers: one-click name captions for the person talking ================= */
  const SPK = '__speaker';
  const speakerLabel = p => ({ id: SPK, title: p.name, subtitle: p.title, style: show.speakerStyle.style, color: show.speakerStyle.color, design: show.speakerStyle.design });
  // countdown until a caption hides itself: shown on its tile and on the Hide button
  rt.hideAt = new Map();
  setInterval(() => {
    const now = Date.now();
    let spkLeft = 0;
    document.querySelectorAll('.spk[data-spk], .gtile[data-gid]').forEach(t => {
      const id = t.dataset.spk || t.dataset.gid, h = rt.hideAt.get(id);
      const left = h ? Math.max(0, h.at - now) : 0;
      t.style.setProperty('--cd', h ? left / h.total : 0);
      t.classList.toggle('counting', !!h && left > 0);
      const air = t.querySelector('.spk-air');
      if (air && h && left > 0) air.textContent = `ON AIR · ${Math.ceil(left / 1000)} s`;
      if (t.dataset.spk && left > 0) spkLeft = left;
    });
    const b = document.querySelector('#spkHide span');
    if (b) b.textContent = spkLeft ? `Hide · ${Math.ceil(spkLeft / 1000)} s` : 'Hide';
    for (const [id, h] of rt.hideAt) if (h.at < now - 500) rt.hideAt.delete(id);
  }, 150);
  function showSpeaker(id) {
    const p = show.speakers.find(x => x.id === id);
    if (!p) return;
    clearTimeout(rt.speakerTimer); clearTimeout(rt.speakerSwap);
    const go = () => {
      rt.speakerObj = speakerLabel(p);
      engine.setLabel(rt.speakerObj, true);
      rt.speakerId = id;
      refreshSpeakerStates();
      const sec = show.speakerStyle.autoHide;
      if (sec > 0) { rt.speakerTimer = setTimeout(hideSpeaker, sec * 1000); rt.hideAt.set(id, { at: Date.now() + sec * 1000, total: sec * 1000 }); }
    };
    if (rt.speakerObj && engine.labelVisible(SPK) && rt.speakerId !== id) {
      // another person's caption is up: slide it out, then bring the new one in
      engine.setLabel(rt.speakerObj, false);
      rt.speakerId = id; refreshSpeakerStates();
      rt.speakerSwap = setTimeout(go, labelDesign(rt.speakerObj).fadeMs + 80);
    } else go();
  }
  function hideSpeaker() {
    if (rt.armedSpk) armSpeaker(null);
    clearTimeout(rt.speakerTimer); clearTimeout(rt.speakerSwap);
    show.speakers.forEach(p => rt.hideAt.delete(p.id));
    if (rt.speakerObj) engine.setLabel(rt.speakerObj, false);
    rt.speakerId = null;
    refreshSpeakerStates();
  }
  const speakerOnAir = id => rt.speakerId === id && engine.labelVisible(SPK);
  function toggleSpeaker(id) { if (speakerOnAir(id)) hideSpeaker(); else showSpeaker(id); }
  function hideAllGraphics() { show.labels.forEach(l => { if (engine.labelVisible(l.id)) setLabelVisible(l.id, false); }); hideSpeaker(); }

  /* ================= outputs: YouTube stream + recording ================= */
  function pickMime() {
    const c = ['video/x-matroska;codecs=avc1,opus', 'video/webm;codecs=h264,opus', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
    return c.find(m => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || '';
  }
  const codecOf = m => /avc1|h264/.test(m) ? 'h264' : /vp9/.test(m) ? 'vp9' : 'vp8';
  function streamURL() {
    const y = settings.youtube;
    if (y.server === 'custom') return (y.custom || '').trim().replace(/\/$/, '') + (y.key ? '/' + y.key.trim() : '');
    return y.server.replace(/\/$/, '') + '/' + (y.key || '').trim();
  }
  class Output {
    constructor(kind) { this.kind = kind; this.active = false; this.id = null; this.chain = Promise.resolve(); }
    async start() {
      const o = settings.output;
      const mime = pickMime();
      if (!mime) throw new Error('This computer cannot encode video in the app.');
      // if the graphics-card encoder refused to start: 1 = plain settings, 2 = software encoder (for this session)
      const fb = rt.encFallback && rt.encFallback.for === o.encoder ? rt.encFallback.level : 0;
      const encoder = fb >= 2 ? 'x264' : o.encoder, safe = fb === 1;
      const opts = this.kind === 'stream'
        ? { kind: 'stream', url: streamURL(), fps: o.fps, bitrate: o.bitrate, encoder, safe, audioBitrate: o.audioBitrate, inputCodec: codecOf(mime) }
        : { kind: 'record', dir: settings.recordDir, name: show.showName, fps: o.fps, encoder, safe, bitrate: o.recordBitrate, audioBitrate: o.recordAudioBitrate || 256, inputCodec: codecOf(mime) };
      const r = await S.outStart(opts);
      if (!r || r.error) throw new Error(r ? r.error : 'Encoder did not start');
      this.id = r.id;
      this.track = engine.videoTrack().clone();
      const ms = new MediaStream([this.track, ...mixer.stream().getAudioTracks()]);
      const vbps = this.kind === 'stream' ? clamp(o.bitrate * 3000, 10e6, 40e6) : clamp(o.recordBitrate * 1000, 4e6, 100e6);
      this.rec = new MediaRecorder(ms, { mimeType: mime, videoBitsPerSecond: vbps, audioBitsPerSecond: 510000 });
      const id = this.id;
      this.rec.ondataavailable = e => {
        if (!e.data || !e.data.size) return;
        const blob = e.data;
        this.chain = this.chain.then(() => blob.arrayBuffer()).then(b => S.outWrite(id, b)).catch(() => {});
      };
      this.rec.start(250);
      this.active = true;
    }
    async stopRecorder() {
      if (this.rec && this.rec.state !== 'inactive') await new Promise(res => { this.rec.addEventListener('stop', res, { once: true }); this.rec.stop(); });
      await this.chain;
      if (this.track) this.track.stop();
    }
    async stop() { this.active = false; await this.stopRecorder(); if (this.id) await S.outStop(this.id); }
  }

  async function goLive() {
    if (!settings.youtube.key && settings.youtube.server !== 'custom') { toast('Add your YouTube stream key first.', 'error'); openSettings('youtube'); return; }
    mixer.resume();
    const btn = $('#btnLive'); btn.disabled = true; btn.textContent = 'STARTING…';
    try {
      rt.live = new Output('stream');
      await rt.live.start();
      rt.liveStart = Date.now(); rt.liveStats = null; rt.reconnects = 0; resetFrameStats();
      S.setLive(true);
      document.body.classList.add('is-live');
      if (settings.autoRecord && !rt.rec) startRec();
      ytAfterGoLive();
    } catch (e) { rt.live = null; toast(`Could not go live: ${e.message}`, 'error'); }
    btn.disabled = false; renderHeader();
  }
  async function stopLive() {
    const o = rt.live; if (!o) return;
    rt.live = null; rt.reconnecting = false;
    await o.stop();
    S.setLive(!!rt.rec);
    document.body.classList.remove('is-live');
    toast(`Stream ended after ${fmt((Date.now() - rt.liveStart) / 1000)}.`, 'ok');
    renderHeader();
  }
  async function reconnect(fast) {
    const o = rt.live; if (!o) return;
    rt.reconnecting = true; renderHeader();
    await o.stopRecorder();
    const wait = fast || Math.min(15000, 2000 * (1 + (rt.reconnects || 0)));
    rt.reconnects = (rt.reconnects || 0) + 1;
    setTimeout(async () => {
      if (rt.live !== o) return;
      try { const n = new Output('stream'); await n.start(); rt.live = n; rt.reconnecting = false; rt.reconnPending = true; }
      catch (e) { reconnect(); }
      renderHeader();
    }, wait);
  }
  async function startRec() {
    try { rt.rec = new Output('record'); await rt.rec.start(); rt.recStart = Date.now(); S.setLive(true); }
    catch (e) { rt.rec = null; toast(`Could not record: ${e.message}`, 'error'); }
    renderHeader();
  }
  async function stopRec() { const o = rt.rec; rt.rec = null; if (o) await o.stop(); S.setLive(!!rt.live); renderHeader(); }

  S.onOutEvent(ev => {
    if (ev.type === 'stats') {
      if (ev.kind === 'stream') { rt.liveStats = ev; if (rt.reconnPending && ev.frame > 30) { rt.reconnPending = false; rt.reconnects = 0; toast('Stream is running again.', 'ok'); } }
      else rt.recStats = ev;
      return;
    }
    if (ev.type === 'exit') {
      if (ev.file) toast(`Recording saved: ${ev.file}`, 'ok', S.showFile ? { label: 'Show', fn: () => S.showFile(ev.file) } : null);
      if (ev.expected) return;
      // graphics-card encoder refused to start → step down by itself instead of failing over and over
      const hwName = { nvenc: 'NVIDIA', qsv: 'Intel', amf: 'AMD' }[settings.output.encoder];
      const mineOut = (ev.kind === 'stream' && rt.live && rt.live.id === ev.id) || (ev.kind === 'record' && rt.rec && rt.rec.id === ev.id);
      if (ev.encoderFailed && hwName && mineOut) {
        const cur = rt.encFallback && rt.encFallback.for === settings.output.encoder ? rt.encFallback.level : 0;
        if (cur < 2) {
          rt.encFallback = { for: settings.output.encoder, level: cur + 1, detail: ev.detail };
          toast(cur === 0 ? `The ${hwName} encoder refused these settings — trying its plain settings…` : `The ${hwName} encoder will not start on this PC — using the software encoder instead. (${ev.detail || ev.error})`, 'error');
          if (ev.kind === 'stream') { rt.reconnects = 0; reconnect(300); }
          else { const o2 = rt.rec; rt.rec = null; o2.active = false; o2.stopRecorder().then(startRec); }
          renderHeader();
          return;
        }
      }
      if (ev.kind === 'stream' && rt.live && rt.live.id === ev.id) {
        toast(`Stream connection problem: ${ev.error || 'disconnected'}. Reconnecting…`, 'error');
        reconnect();
      } else if (ev.kind === 'record' && rt.rec && rt.rec.id === ev.id) {
        toast(`Recording stopped: ${ev.error || 'encoder closed'}`, 'error');
        const o = rt.rec; rt.rec = null; o.active = false; o.stopRecorder(); renderHeader();
      }
    }
  });

  /* ================= header ================= */
  let liveConfirm = 0;
  $('#btnLive').addEventListener('click', () => {
    if (!rt.live) return goLive();
    if (Date.now() - liveConfirm < 3000) { liveConfirm = 0; stopLive(); return; }
    liveConfirm = Date.now();
    renderHeader();
    setTimeout(renderHeader, 3100);
  });
  let recConfirm = 0;
  $('#btnRec').addEventListener('click', () => {
    if (!rt.rec) return startRec();
    if (Date.now() - recConfirm < 3000) { recConfirm = 0; stopRec(); return; }
    recConfirm = Date.now(); renderHeader(); setTimeout(renderHeader, 3100);
  });
  /* ---------- frame counter & drop statistics ---------- */
  function frameDrops() {
    const enc = (rt.live && rt.liveStats ? (rt.liveStats.drop || 0) : 0) + (rt.rec && rt.recStats ? (rt.recStats.drop || 0) : 0);
    const cam = 0;
    return { engine: engine.stats.missed, enc, cam, total: engine.stats.missed + enc }; // camera skips are shown in the window only
  }
  function resetFrameStats() {
    engine.stats.frames = 0; engine.stats.missed = 0; engine.stats.recent = []; engine.stats.worst = 0; engine.stats.since = performance.now();
    for (const c of show.cameras) { const src = engine.sources.get(c.id); if (src) { src.skipBase = src.skipped || 0; src.pfBase = src.pf || 0; src.fpsNow = 0; src.countAt = performance.now(); } }
    rt.dropSeen = 0;
  }
  function openPerf() {
    const body = el('div');
    const draw = () => {
      if (!body.isConnected && body.dataset.open) return clearInterval(timer);
      body.dataset.open = '1';
      const d = frameDrops(), st = engine.stats, secs = (performance.now() - st.since) / 1000;
      const row = (a, b, bad) => el('div', { class: 'key-row' }, el('span', { class: 'grow' }, a), el('b', { class: 'mono ' + (bad ? 'status-bad' : '') }, b));
      body.innerHTML = '';
      put(body,
        el('h3', null, 'Program output'),
        row('Frames made', `${st.frames.toLocaleString()}  (${fmt(secs)})`),
        row('Frame rate now / target', `${st.fps} / ${engine.fps} fps`, st.fps < engine.fps - 2),
        row('Frames missed by this computer', `${d.engine}${d.engine ? `  (${(d.engine / Math.max(1, st.frames + d.engine) * 100).toFixed(d.engine / Math.max(1, st.frames + d.engine) < 0.001 ? 3 : 2)}%)` : ''}`, d.engine / Math.max(1, st.frames + d.engine) > 0.001),
        row('…in the last minute', String((st.recent || []).filter(x => performance.now() - x[0] < 60000).reduce((a, x) => a + x[1], 0)), (st.recent || []).filter(x => performance.now() - x[0] < 60000).length > 3),
        row('Longest hiccup', st.worst ? `${Math.round(st.worst)} ms` : '—', st.worst > 100),
        row('Time to draw one frame', `${st.renderMs.toFixed(1)} ms of ${(1000 / engine.fps).toFixed(1)} ms`, st.renderMs > 1000 / engine.fps),
        el('h3', null, 'This computer'),
        rt.pc && rt.pc.cpu !== null ? [
          row(`Processor (CPU) — ${(rt.pc.cpuName || '').trim()}`, `${rt.pc.cpu}%`, rt.pc.cpu >= 90),
          row('CPU temperature', rt.pc.cpuTemp !== null ? `${rt.pc.cpuTemp} °C` : 'not reported by this PC', rt.pc.cpuTemp >= 85),
          row(`Graphics (GPU)${rt.pc.gpuName ? ' — ' + rt.pc.gpuName : ''}`, rt.pc.gpu !== null ? `${rt.pc.gpu}%` : 'not available', rt.pc.gpu >= 95),
          row('GPU temperature', rt.pc.gpuTemp !== null ? `${rt.pc.gpuTemp} °C` : 'only available for NVIDIA cards', rt.pc.gpuTemp >= 85),
          row('Memory in use', `${rt.pc.mem}%`, rt.pc.mem >= 90)] : el('div', { class: 'muted' }, 'Reading…'),
        el('h3', null, 'Cameras'),
        show.cameras.length ? show.cameras.map(c => {
          const src = engine.sources.get(c.id), now = performance.now();
          // counted from the card's own frame numbers, averaged over ~10 s, so a busy moment in this window can't fake a low reading
          if (src && (!src.countAt || src.pfBase === undefined)) { src.pfBase = src.pf || 0; src.countAt = now; }
          const secs = src ? (now - src.countAt) / 1000 : 0;
          if (src && secs >= 3) { src.fpsNow = ((src.pf || 0) - src.pfBase) / secs; if (secs > 10) { src.pfBase = src.pf || 0; src.countAt = now; } }
          const want = +c.fps || 0, got = src && src.fpsNow;
          const low = got && want && got < want - 2;
          return row(`${c.name} — frames arriving`, got ? `${got.toFixed(1)} fps${want ? ` of ${want}` : ''} ${low ? '⚠ low' : '✓'}` : 'measuring…', low);
        }) : el('div', { class: 'muted' }, 'No cameras.'),
        el('h3', null, 'YouTube stream encoder'),
        rt.live && rt.liveStats ? [row('Frames sent', (rt.liveStats.frame || 0).toLocaleString()), row('Dropped by the encoder', String(rt.liveStats.drop || 0), rt.liveStats.drop > 0), row('Repeated to fill gaps', String(rt.liveStats.dup || 0), rt.liveStats.dup > engine.fps), row('Encoder speed', `${(rt.liveStats.speed || 0).toFixed(2)}×`, rt.liveStats.speed && rt.liveStats.speed < 0.97)] : el('div', { class: 'muted' }, 'Not live.'),
        rt.rec && rt.recStats ? [el('h3', null, 'Recording'), row('Frames written', (rt.recStats.frame || 0).toLocaleString()), row('Dropped', String(rt.recStats.drop || 0), rt.recStats.drop > 0)] : null,
        el('div', { class: 'muted', style: 'font-size:.85em;margin-top:12px' }, d.total ? 'If frames are being missed: close other programs, use a hardware encoder (Settings → Encoder), or lower the frame rate or resolution.' : 'No dropped frames. ✓'),
        el('div', { class: 'row', style: 'margin-top:14px' }, el('button', { class: 'btn', onclick: () => { resetFrameStats(); draw(); } }, 'Reset counters'), el('span', { class: 'grow' }), el('button', { class: 'btn primary', onclick: () => { clearInterval(timer); closeModal(); } }, 'Done')));
    };
    openModal('Frame counter & PC monitor', body);
    draw();
    const timer = setInterval(draw, 1000);
  }
  $('#health').addEventListener('click', openPerf);
  $('#btnSettings').addEventListener('click', () => openSettings());
  // Save button: everything also saves by itself, this writes it to disk right now and confirms it
  async function saveAll(quiet) {
    try { await S.saveShow(show); await S.saveSettings(settings); if (!quiet) { const b = $('#btnSave'); b.textContent = '✓ Saved'; b.classList.add('ok'); setTimeout(() => { b.textContent = '💾 Save'; b.classList.remove('ok'); }, 2000); } }
    catch (e) { toast('Could not save: ' + e.message, 'error'); }
  }
  $('#btnSave').addEventListener('click', () => saveAll());
  window.addEventListener('beforeunload', () => { S.saveShow(show); S.saveSettings(settings); });
  setInterval(() => saveAll(true), 60000);
  document.addEventListener('keydown', e => { if (e.ctrlKey && e.shiftKey && e.code === 'KeyS') { e.preventDefault(); saveAll(); } });
  $('#btnLayout').addEventListener('click', () => setEditing(!rt.editing));
  const showNameInput = $('#showName');
  showNameInput.value = show.showName;
  showNameInput.addEventListener('input', () => { show.showName = showNameInput.value; changed(); });

  function renderHeader() {
    const lb = $('#btnLive'), rb = $('#btnRec');
    const confirming = Date.now() - liveConfirm < 3000;
    lb.className = 'btn live-btn' + (rt.live ? (confirming ? ' confirm' : ' on') : '');
    lb.textContent = rt.live ? (confirming ? 'CLICK AGAIN TO END' : 'END STREAM') : 'GO LIVE';
    const rc = Date.now() - recConfirm < 3000;
    rb.className = 'btn rec-btn' + (rt.rec ? ' on' : '');
    rb.textContent = rt.rec ? (rc ? 'CLICK TO STOP' : '■ STOP REC') : '● REC';
    tickHeader();
  }
  function tickHeader() {
    const ls = $('#liveStatus'), rs = $('#recStatus'), hl = $('#health');
    if (rt.live) {
      ls.className = 'pill ' + (rt.reconnecting ? 'warn' : 'on');
      ls.querySelector('.txt').textContent = rt.reconnecting ? 'RECONNECTING…' : `LIVE ${fmt((Date.now() - rt.liveStart) / 1000)}`;
    } else { ls.className = 'pill off'; ls.querySelector('.txt').textContent = 'OFF AIR'; }
    if (rt.rec) { rs.className = 'pill rec on'; rs.querySelector('.txt').textContent = `REC ${fmt((Date.now() - rt.recStart) / 1000)}`; }
    else { rs.className = 'pill off'; rs.querySelector('.txt').textContent = 'NOT RECORDING'; }
    const parts = [];
    const st = rt.liveStats;
    if (rt.live && st) {
      if (st.bitrate) parts.push(`${(st.bitrate / 1000).toFixed(1)} Mb/s`);
      if (st.fps) parts.push(`${Math.round(st.fps)} fps`);
      const slow = (st.speed && st.speed < 0.97) || (st.backlog > 8e6);
      if (slow) { if (!rt.slowSince) rt.slowSince = Date.now(); } else rt.slowSince = 0;
      if (rt.slowSince && Date.now() - rt.slowSince > 5000) parts.push('<span class="bad">⚠ Computer or internet can\'t keep up — lower bitrate or use a hardware encoder</span>');
    }
    const yp = $('#ytStatus');
    if (yp) {
      const [cls, txt] = rt.yt && rt.yt.event ? ytHealthText() : ['', ''];
      yp.classList.toggle('hidden', !txt || !rt.live);
      yp.querySelector('.yt-dot').className = 'yt-dot ' + cls;
      yp.querySelector('.txt').textContent = txt + (rt.yt && rt.yt.viewers ? ` · 👁 ${rt.yt.viewers}` : '');
    }
    parts.push(`engine ${engine.stats.fps} fps`);
    const P = rt.pc;
    if (P && P.cpu !== null) {
      const hot = v => v !== null && v !== undefined && v >= 85, t = v => v !== null && v !== undefined ? ` ${v}°C` : '';
      parts.push(`<span class="${P.cpu >= 90 || hot(P.cpuTemp) ? 'bad' : ''}">CPU ${P.cpu}%${t(P.cpuTemp)}</span>`);
      if (P.gpu !== null) parts.push(`<span class="${P.gpu >= 95 || hot(P.gpuTemp) ? 'bad' : ''}">GPU ${P.gpu}%${t(P.gpuTemp)}</span>`);
    }
    const drops = frameDrops();
    parts.push(`frame ${engine.stats.frames.toLocaleString()}`);
    parts.push(drops.total ? `<span class="bad">⚠ ${drops.total} dropped</span>` : '<span class="good">0 dropped</span>');
    hl.innerHTML = parts.join(' · ');
    hl.title = 'Click for frame statistics';
    // warn once when frames start dropping while live or recording
    if ((rt.live || rt.rec) && drops.total - (rt.dropSeen || 0) >= Math.max(5, engine.fps / 2) && Date.now() - (rt.dropWarnAt || 0) > 60000) { rt.dropWarnAt = Date.now(); toast(`Frames are being dropped (${drops.total} so far). Click the frame counter at the top for details.`, 'error'); }
    if (Date.now() - (rt.dropSeenAt || 0) > 10000) { rt.dropSeenAt = Date.now(); rt.dropSeen = drops.total; }
  }
  setInterval(tickHeader, 500);

  /* ================= layout ================= */
  function applyUI() {
    const r = document.documentElement.style;
    r.setProperty('--scale', settings.ui.scale);
    r.setProperty('--accent', settings.ui.accent);
    document.body.style.setProperty('--card', settings.ui.card || 1);
  }
  function setEditing(on) {
    rt.editing = on;
    document.body.classList.toggle('editing', on);
    $('#layoutBar').classList.toggle('hidden', !on);
    $('#uiScale').value = settings.ui.scale;
    $('#uiAccent').value = settings.ui.accent;
    renderGrid();
  }
  $('#layoutDone').addEventListener('click', () => setEditing(false));
  $('#uiScale').addEventListener('input', e => { settings.ui.scale = +e.target.value; applyUI(); saveSettings(); });
  $('#uiAccent').addEventListener('input', e => { settings.ui.accent = e.target.value; applyUI(); saveSettings(); });
  $('#layoutReset').addEventListener('click', () => { settings.ui.layouts = defaultLayouts(); saveSettings(); renderGrid(); });
  function setView(v) {
    view = v;
    $('#viewLive').classList.toggle('sel', v === 'live');
    $('#viewSetup').classList.toggle('sel', v === 'setup');
    renderGrid();
  }
  $('#viewLive').addEventListener('click', () => setView('live'));
  $('#viewSetup').addEventListener('click', () => setView('setup'));
  $('#addPanel').addEventListener('change', e => { const p = curLayout().find(x => x.id === e.target.value); if (p) { p.hidden = false; saveSettings(); renderGrid(); } });

  let dragId = null;
  function renderGrid() {
    const grid = $('#grid');
    grid.innerHTML = '';
    rt.bodies = {};
    for (const p of curLayout()) {
      if (p.hidden || !PANEL_DEFS[p.id]) continue;
      const tools = el('div', { class: 'panel-tools' },
        el('button', { class: 'btn small', title: 'Narrower', onclick: () => resize(p, -1, 0) }, '◂'),
        el('button', { class: 'btn small', title: 'Wider', onclick: () => resize(p, 1, 0) }, '▸'),
        el('button', { class: 'btn small', title: 'Shorter', onclick: () => resize(p, 0, -1) }, '▴'),
        el('button', { class: 'btn small', title: 'Taller', onclick: () => resize(p, 0, 1) }, '▾'),
        el('button', { class: 'btn small danger', title: 'Hide panel', onclick: () => { p.hidden = true; saveSettings(); renderGrid(); } }, '✕'));
      const head = el('div', { class: 'panel-head' }, el('h3', null, PANEL_DEFS[p.id].title), el('span', { class: 'head-hint' }, PANEL_DEFS[p.id].hint || ''), tools);
      const body = el('div', { class: 'panel-body' });
      const panel = el('section', { class: 'panel', style: `grid-column: span ${p.w}; grid-row: span ${p.h};`, dataset: { id: p.id } }, head, body);
      if (rt.editing) {
        panel.draggable = true;
        panel.addEventListener('dragstart', e => { dragId = p.id; e.dataTransfer.effectAllowed = 'move'; });
        panel.addEventListener('dragover', e => { e.preventDefault(); panel.classList.add('drag-over'); });
        panel.addEventListener('dragleave', () => panel.classList.remove('drag-over'));
        panel.addEventListener('drop', e => {
          e.preventDefault(); panel.classList.remove('drag-over');
          if (!dragId || dragId === p.id) return;
          const L = curLayout(), from = L.findIndex(x => x.id === dragId);
          const item = L.splice(from, 1)[0];
          L.splice(L.findIndex(x => x.id === p.id), 0, item);
          saveSettings(); renderGrid();
        });
      }
      rt.bodies[p.id] = body;
      grid.append(panel);
      refresh(p.id);
    }
    const add = $('#addPanel');
    add.innerHTML = '';
    add.append(el('option', { value: '' }, '+ Show hidden panel…'));
    curLayout().filter(p => p.hidden).forEach(p => add.append(el('option', { value: p.id }, PANEL_DEFS[p.id].title)));
  }
  function resize(p, dw, dh) { p.w = clamp(p.w + dw, 2, 12); p.h = clamp(p.h + dh, 2, 10); saveSettings(); renderGrid(); }
  const RENDER = {};
  function refresh(id) { const b = rt.bodies[id]; if (b && RENDER[id]) RENDER[id](b); }
  function refreshAll() { Object.keys(rt.bodies).forEach(refresh); }

  /* ================= panel: monitors ================= */
  const progInfo = el('div', { class: 'media-time hidden' });
  const progBar = el('div', { class: 'media-bar hidden' }, el('i'));
  // slim master meter beside the program screen (like a hardware switcher)
  const monMeter = el('canvas', { class: 'mon-meter', width: 40, height: 300 });
  function drawMonMeter(A) {
    if (!monMeter.isConnected) return;
    const r = monMeter.getBoundingClientRect(), k = devicePixelRatio;
    const w = Math.max(10, Math.round(r.width * k)), h = Math.max(10, Math.round(r.height * k));
    if (monMeter.width !== w || monMeter.height !== h) { monMeter.width = w; monMeter.height = h; }
    const g = monMeter.getContext('2d'), top = 6 * k, mh = h - top - 18 * k;
    g.clearRect(0, 0, w, h);
    const y = db => top + mh * (1 - Math.max(0, Math.min(1, (db + 60) / 60)));
    const bw = (w - 6 * k) / 2;
    [[A.peakL, A.holdL, A.clipL], [A.peakR, A.holdR, A.clipR]].forEach(([p, hd, clip], i) => {
      const x = 2 * k + i * (bw + 2 * k);
      g.fillStyle = '#0a0a0b'; g.fillRect(x, top, bw, mh);
      const gr = g.createLinearGradient(0, top + mh, 0, top);
      gr.addColorStop(0, '#16a34a'); gr.addColorStop(0.7, '#22c55e'); gr.addColorStop(0.82, '#eab308'); gr.addColorStop(0.95, '#ef4444');
      g.fillStyle = gr; g.fillRect(x, y(p), bw, top + mh - y(p));
      g.fillStyle = '#fff'; g.fillRect(x, y(hd) - k, bw, 2 * k);
      if (clip) { g.fillStyle = '#ef4444'; g.fillRect(x, 0, bw, 4 * k); }
    });
    g.fillStyle = A.silent ? '#555' : A.corr < -0.2 ? '#ef4444' : A.corr < 0.2 ? '#f59e0b' : '#22c55e';
    g.beginPath(); g.arc(w / 2, h - 8 * k, 4 * k, 0, 7); g.fill();
  }
  RENDER.monitors = body => {
    body.innerHTML = '';
    const pvName = el('span', { class: 'name', id: 'pvName' });
    const pgName = el('span', { class: 'name', id: 'pgName' });
    const durSel = select([[0, 'Cut'], [300, 'Fade 0.3 s'], [600, 'Smooth 0.6 s'], [1000, 'Fade 1 s'], [2000, 'Fade 2 s']], show.transition.ms, v => { show.transition.ms = +v; changed(); }, { class: 'trans-sel' });
    put(body, el('div', { class: 'mon-wrap' },
      el('div', { class: 'monitors' },
        el('div', { class: 'monitor preview' }, el('div', { class: 'screen' }, previewCanvas), el('div', { class: 'monitor-label' }, el('span', { class: 'ldot green' }), el('span', { class: 'tagtxt' }, 'Preview'), pvName)),
        el('div', { class: 'monitor program' }, el('div', { class: 'screen' }, engine.canvas, progInfo, progBar), el('div', { class: 'monitor-label' }, el('span', { class: 'ldot red' }), el('span', { class: 'tagtxt' }, 'Live'), pgName)),
        el('div', { class: 'mon-meter-wrap', title: 'Master level · dot = phase (green good, red out of phase)' }, monMeter)),
      el('div', { class: 'trans-bar' },
        el('button', { class: 'btn cut-btn', onclick: () => take('cut') }, 'CUT', keyChip('cut')),
        durSel,
        el('button', { class: 'btn take-btn', onclick: () => take('auto') }, 'TAKE ➜', keyChip('take')),
        el('span', { class: 'trans-gap' }),
        el('button', { class: 'btn ftb-btn', id: 'ftbBtn', onclick: () => setBlack(!engine.isBlack) }, 'FADE TO BLACK', keyChip('ftb')),
        el('button', { class: 'btn small ghost', onclick: openShortcuts, title: 'Keyboard shortcuts' }, '⌨'))));
    renderTally();
  };

  /* ================= panel: shots ================= */
  function thumbFor(id) {
    let c = rt.thumbs.get(id);
    if (!c) { c = el('canvas', { width: 320, height: 180 }); rt.thumbs.set(id, c); engine.thumbs.set(id, c); }
    return c;
  }
  // opening / closing videos are run by START / END SERVICE, so they are hidden from the Shots panel unless you un-hide them
  const shotHidden = s => s.hidden === undefined ? (s.role === 'open' || s.role === 'close') : !!s.hidden;
  let shotDrag = null;
  RENDER.shots = body => {
    body.innerHTML = '';
    const wrap = el('div', { class: 'shots' });
    const hiddenN = show.shots.filter(shotHidden).length;
    show.shots.forEach(s => {
      const hid = shotHidden(s);
      if (hid && !rt.showHiddenShots) return;
      const card = el('div', { class: 'shot' + (hid ? ' is-hidden' : ''), style: `--shot-color:${s.color}`, dataset: { id: s.id }, draggable: 'true', title: 'Click = preview · double-click = on air · drag to reorder' },
        thumbFor(s.id),
        el('span', { class: 'badge' }),
        mediaOf(s).length ? el('span', { class: 'film' }, '🎞') : null,
        el('button', { class: 'edit', title: 'Edit shot', onclick: e => { e.stopPropagation(); editShot(s.id); } }, '✎'),
        el('button', { class: 'edit hide-btn', title: hid ? 'Show this shot again' : 'Hide this shot from the list', onclick: e => { e.stopPropagation(); s.hidden = !hid; changed(); refresh('shots'); } }, hid ? '👁 Show' : '🚫'),
        el('div', { class: 'meta' }, el('span', { class: 'nm' }, s.name), hid ? el('span', { class: 'muted', style: 'font-size:.75em' }, 'hidden') : keyChip('shot:' + s.id)));
      card.addEventListener('click', () => { setPreview(s.id); editShot(s.id, true); });
      card.addEventListener('dblclick', () => takeShot(s.id, 'auto'));
      card.addEventListener('dragstart', e => { shotDrag = s.id; e.dataTransfer.effectAllowed = 'move'; });
      card.addEventListener('dragover', e => { if (shotDrag && shotDrag !== s.id) { e.preventDefault(); card.classList.add('drop'); } });
      card.addEventListener('dragleave', () => card.classList.remove('drop'));
      card.addEventListener('drop', e => {
        e.preventDefault(); card.classList.remove('drop');
        const moved = getShot(shotDrag); shotDrag = null; if (!moved) return;
        show.shots = show.shots.filter(x => x !== moved);
        show.shots.splice(show.shots.indexOf(s), 0, moved);
        changed(); refresh('shots');
      });
      wrap.append(card);
    });
    wrap.append(el('div', { class: 'shot add', onclick: addShot }, '+ New shot'));
    put(body, wrap, hiddenN ? el('button', { class: 'btn small ghost', style: 'margin-top:8px', onclick: () => { rt.showHiddenShots = !rt.showHiddenShots; refresh('shots'); } }, rt.showHiddenShots ? 'Done — hide them again' : `Show ${hiddenN} hidden shot${hiddenN > 1 ? 's' : ''}…`) : null);
    for (const id of [...rt.thumbs.keys()]) if (!getShot(id)) { rt.thumbs.delete(id); engine.thumbs.delete(id); }
    renderTally();
  };
  function addShot() {
    const src = show.cameras[0] ? show.cameras[0].id : 'bars';
    const s = newShot(`Shot ${show.shots.length + 1}`, src, SHOT_COLORS[show.shots.length % SHOT_COLORS.length]);
    show.shots.push(s); changed();
    refresh('shots'); editShot(s.id);
  }
  function editShot(id, quiet) {
    rt.editingId = id; rt.padTarget = 'main';
    refresh('editor');
    if (!quiet && !rt.bodies.editor) { setView('setup'); return; }
    renderTally();
  }
  function renderTally() {
    document.querySelectorAll('.shot[data-id]').forEach(c => {
      const id = c.dataset.id;
      const pg = id === engine.programId || (engine.trans && engine.trans.to === id);
      const pv = id === rt.previewId && !pg;
      c.classList.toggle('program', pg);
      c.classList.toggle('preview', pv);
      c.classList.toggle('editing', id === rt.editingId);
      c.querySelector('.badge').textContent = pg ? 'LIVE' : pv ? 'NEXT' : '';
    });
    const pv = $('#pvName'), pg = $('#pgName');
    if (pv) pv.textContent = rt.armedSpk ? `Caption preview on the live shot — press TAKE to show` : ((getShot(rt.previewId) || {}).name || '');
    if (pg) pg.textContent = (getShot(engine.trans ? engine.trans.to : engine.programId) || {}).name || '';
    const f = $('#ftbBtn'); if (f) f.classList.toggle('on', engine.isBlack);
  }

  /* ================= panel: shot framing ================= */
  const padCanvas = el('canvas', { width: 320, height: 180 });
  const padBox = el('div', { class: 'frame-box' });
  const pad = el('div', { class: 'pad', title: 'Drag to move the frame · scroll to zoom · click to centre' }, padCanvas, padBox);
  function padLayer(s) { return rt.padTarget === 'pip' && s.pip.enabled ? s.pip : s.main; }
  function padGeom(s) {
    const L = padLayer(s);
    const r = pad.getBoundingClientRect();
    const sz = engine.sourceSize(L.source) || { w: 16, h: 9 };
    const sa = sz.w / sz.h, pa = r.width / r.height || 16 / 9;
    let sr;
    if (sa > pa) { const h = r.width / sa; sr = { x: 0, y: (r.height - h) / 2, w: r.width, h }; }
    else { const w = r.height * sa; sr = { x: (r.width - w) / 2, y: 0, w, h: r.height }; }
    const aspect = rt.padTarget === 'pip' ? 16 / 9 : engine.W / engine.H;
    return { r, sr, L, uv: engine.uvFor(L.source, L.frame, aspect) };
  }
  function updatePadBox() {
    const s = getShot(rt.editingId);
    if (!s || !pad.isConnected) return;
    const g = padGeom(s);
    Object.assign(padBox.style, { left: `${g.sr.x + g.uv[0] * g.sr.w}px`, top: `${g.sr.y + g.uv[1] * g.sr.h}px`, width: `${g.uv[2] * g.sr.w}px`, height: `${g.uv[3] * g.sr.h}px` });
  }
  function setFrame(s, patch) {
    const L = padLayer(s);
    Object.assign(L.frame, patch);
    L.frame.zoom = clamp(L.frame.zoom, 1, 6);
    const uv = engine.uvFor(L.source, L.frame, rt.padTarget === 'pip' ? 16 / 9 : engine.W / engine.H);
    L.frame.x = uv[0] + uv[2] / 2; L.frame.y = uv[1] + uv[3] / 2; // keep inside the picture
    updatePadBox(); changed();
    const z = $('#zoomVal'); if (z) z.textContent = `${L.frame.zoom.toFixed(2)}×`;
    const zi = $('#zoomInput'); if (zi && +zi.value !== L.frame.zoom) zi.value = L.frame.zoom;
  }
  let padDrag = null;
  pad.addEventListener('pointerdown', e => {
    const s = getShot(rt.editingId); if (!s) return;
    pad.setPointerCapture(e.pointerId);
    const L = padLayer(s);
    padDrag = { x: e.clientX, y: e.clientY, fx: L.frame.x, fy: L.frame.y, moved: false };
  });
  pad.addEventListener('pointermove', e => {
    if (!padDrag) return;
    const s = getShot(rt.editingId); if (!s) return;
    const g = padGeom(s);
    const dx = e.clientX - padDrag.x, dy = e.clientY - padDrag.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) padDrag.moved = true;
    if (padDrag.moved) setFrame(s, { x: padDrag.fx + dx / g.sr.w, y: padDrag.fy + dy / g.sr.h });
  });
  pad.addEventListener('pointerup', e => {
    const s = getShot(rt.editingId);
    if (s && padDrag && !padDrag.moved) {
      const g = padGeom(s);
      setFrame(s, { x: (e.clientX - g.r.left - g.sr.x) / g.sr.w, y: (e.clientY - g.r.top - g.sr.y) / g.sr.h });
    }
    padDrag = null;
  });
  pad.addEventListener('wheel', e => {
    e.preventDefault();
    const s = getShot(rt.editingId); if (!s) return;
    const L = padLayer(s);
    setFrame(s, { zoom: L.frame.zoom * (e.deltaY < 0 ? 1.06 : 1 / 1.06) });
  }, { passive: false });
  new ResizeObserver(() => updatePadBox()).observe(pad);

  RENDER.editor = body => {
    body.innerHTML = '';
    const s = getShot(rt.editingId) || getShot(rt.previewId);
    if (!s) { put(body, el('div', { class: 'empty' }, 'Click a shot to edit it.')); return; }
    rt.editingId = s.id;
    if (s.role === 'hold') {
      // the holding slide is built in its own designer; framing controls here could only break it
      const pvw = el('canvas', { width: 480, height: 270, style: 'width:100%;aspect-ratio:16/9;border-radius:8px;display:block;background:#000;margin-bottom:10px' });
      pvw.getContext('2d').drawImage(holdCanvas, 0, 0, 480, 270);
      put(body, pvw,
        el('div', { class: 'muted', style: 'margin-bottom:10px' }, 'This is the holding slide (clock / welcome). Its picture, text and clock are set in the slide designer.'),
        el('button', { class: 'btn primary big', onclick: openHoldDesigner }, '🎨 Design the slide…'),
        el('div', { class: 'section row' }, el('button', { class: 'btn small', onclick: () => takeShot(s.id, 'auto') }, 'Take this shot')));
      return;
    }
    const L = padLayer(s);
    engine.sourceViews.set(padCanvas, L.source);
    const idx = show.shots.indexOf(s);
    const nudge = (dx, dy) => () => setFrame(s, { x: L.frame.x + dx * 0.02 / L.frame.zoom, y: L.frame.y + dy * 0.02 / L.frame.zoom });
    const zoomIn = el('input', { type: 'range', min: 1, max: 6, step: 0.01, value: L.frame.zoom, id: 'zoomInput', class: 'grow' });
    zoomIn.addEventListener('input', () => setFrame(s, { zoom: +zoomIn.value }));

    put(body, 
      el('div', { class: 'row' },
        el('input', { type: 'text', class: 'grow', value: s.name, oninput: e => { s.name = e.target.value; changed(); const n = document.querySelector(`.shot[data-id="${s.id}"] .nm`); if (n) n.textContent = s.name; renderTally(); } }),
        el('button', { class: 'btn small', title: 'Move left', onclick: () => moveShot(s, -1) }, '◂'),
        el('button', { class: 'btn small', title: 'Move right', onclick: () => moveShot(s, 1) }, '▸')),
      el('div', { class: 'swatches', style: 'margin:8px 0' }, SHOT_COLORS.map(c => el('span', { class: 'swatch' + (c === s.color ? ' sel' : ''), style: `background:${c}`, onclick: () => { s.color = c; changed(); refresh('shots'); refresh('editor'); } }))),
      s.role === 'hold'
        ? el('div', { class: 'field' }, el('span', null, 'Background picture of the holding slide'),
            select([['', '— none (colours) —'], ...show.files.filter(f => f.kind === 'image').map(f => [f.id, '🖼 ' + f.name])], SV().hold.bgFile || '', v => { SV().hold.bgFile = v; changed(); drawHold(); }),
            el('button', { class: 'btn primary', style: 'margin-top:8px', onclick: openHoldDesigner }, '🎨 Design the slide (text, clock, picture)…'))
        : el('div', { class: 'field' }, el('span', null, 'Picture source'), select(sourceOptions(false), s.main.source, v => { s.main.source = v; s.main.frame = { zoom: 1, x: 0.5, y: 0.5 }; changed(); refresh('editor'); refresh('shots'); })),
      s.pip.enabled ? el('div', { class: 'tabs' },
        el('button', { class: 'tab' + (rt.padTarget === 'main' ? ' sel' : ''), onclick: () => { rt.padTarget = 'main'; refresh('editor'); } }, 'Frame: main picture'),
        el('button', { class: 'tab' + (rt.padTarget === 'pip' ? ' sel' : ''), onclick: () => { rt.padTarget = 'pip'; refresh('editor'); } }, 'Frame: small picture')) : null,
      pad,
      el('div', { class: 'row', style: 'margin-top:8px' }, el('span', null, 'Zoom'), zoomIn, el('span', { class: 'mono muted', id: 'zoomVal' }, `${L.frame.zoom.toFixed(2)}×`)),
      el('div', { class: 'row', style: 'margin-top:6px' },
        el('div', { class: 'nudge' },
          el('span'), el('button', { class: 'btn small', onclick: nudge(0, -1) }, '↑'), el('span'),
          el('button', { class: 'btn small', onclick: nudge(-1, 0) }, '←'), el('button', { class: 'btn small', title: 'Reset', onclick: () => setFrame(s, { zoom: 1, x: 0.5, y: 0.5 }) }, '⟲'), el('button', { class: 'btn small', onclick: nudge(1, 0) }, '→'),
          el('span'), el('button', { class: 'btn small', onclick: nudge(0, 1) }, '↓'), el('span')),
        el('div', { class: 'muted grow', style: 'font-size:.85em' }, 'Changes to a shot that is LIVE move smoothly on air, like a camera operator. Speed is in Settings.')),

      el('div', { class: 'section' }, el('h4', null, 'Picture-in-picture'),
        check(' Show a second, small picture', s.pip.enabled, v => { s.pip.enabled = v; if (v && !s.pip.source) s.pip.source = (show.cameras[1] || show.cameras[0] || { id: 'bars' }).id; if (!v) rt.padTarget = 'main'; changed(); refresh('editor'); }),
        s.pip.enabled ? el('div', { class: 'row wrap', style: 'margin-top:8px' },
          select(sourceOptions(false), s.pip.source, v => { s.pip.source = v; changed(); refresh('editor'); }),
          el('div', { class: 'corner-pick' }, [['tl', '↖'], ['tr', '↗'], ['bl', '↙'], ['br', '↘']].map(([c, t]) => el('button', { class: 'btn small' + (s.pip.corner === c ? ' sel' : ''), onclick: () => { s.pip.corner = c; changed(); refresh('editor'); } }, t))),
          el('label', { class: 'inline grow' }, 'Size', el('input', { type: 'range', min: 0.15, max: 0.5, step: 0.01, value: s.pip.size, class: 'grow', oninput: e => { s.pip.size = +e.target.value; changed(); } }))) : null),

      el('div', { class: 'section' }, el('h4', null, 'Pictures & web pages on this shot'),
        show.webs.length || show.pics.length ? el('div', { class: 'row wrap', style: 'gap:14px' }, [...show.pics.map(p2 => ({ id: p2.id, name: '🖼 ' + (p2.name || 'Picture') })), ...show.webs.map(w => ({ id: w.id, name: '🌐 ' + (w.name || 'Web page') }))].map(w => check(' ' + w.name, (s.webIds || []).includes(w.id), v => { s.webIds = (s.webIds || []).filter(i => i !== w.id); if (v) s.webIds.push(w.id); changed(); refreshWebs(); })))
          : el('div', { class: 'muted', style: 'font-size:.85em' }, 'Add a logo with “+ Picture” or live translation with “+ Web page” in Titles & Graphics.'),
        show.webs.length || show.pics.length ? el('div', { class: 'muted', style: 'font-size:.85em;margin-top:4px' }, 'Ticked pages appear automatically while this shot is live.') : null,
        el('div', { class: 'row', style: 'margin-top:6px' }, el('button', { class: 'btn small', onclick: () => editPic(newPic(), true) }, '+ Add picture'), el('button', { class: 'btn small', onclick: () => editWeb(newWeb(), true) }, '+ Add web page'))),

      el('div', { class: 'section' }, el('h4', null, 'Automatic label'),
        select([['', 'No label'], ...show.speakers.map(p => [p.id, `Speaker: ${p.name}${p.title ? ' — ' + p.title : ''}`]), ...show.labels.map(l => [l.id, `${l.title}${l.subtitle ? ' — ' + l.subtitle : ''}`])], s.labelId, v => { s.labelId = v; changed(); }),
        el('div', { class: 'muted', style: 'font-size:.85em;margin-top:4px' }, 'Shown when this shot goes live, hidden when you switch away.')),

      mediaOf(s).length && !s.role ? el('div', { class: 'section' }, el('h4', null, 'When the video ends'),
        select([['none', 'Hold the last frame'], ['black', 'Fade to black'], ['stop', 'Fade to black and end the stream'], ...show.shots.filter(x => x.id !== s.id).map(x => [`goto:${x.id}`, `Go to “${x.name}”`])],
          s.onEnd.action === 'goto' ? `goto:${s.onEnd.target}` : s.onEnd.action,
          v => { s.onEnd = v.startsWith('goto:') ? { action: 'goto', target: v.slice(5) } : { action: v, target: '' }; changed(); })) : null,

      el('div', { class: 'section row wrap' },
        el('button', { class: 'btn small', onclick: () => { const c = clone(s); c.id = uid('shot'); c.name = s.name + ' copy'; c.role = ''; show.shots.splice(idx + 1, 0, c); changed(); refresh('shots'); editShot(c.id); } }, 'Duplicate'),
        el('button', { class: 'btn small', onclick: () => takeShot(s.id, 'auto') }, 'Take this shot'),
        el('span', { class: 'grow' }),
        el('button', { class: 'btn small danger', onclick: () => deleteShot(s) }, 'Delete shot'))
    );
    requestAnimationFrame(updatePadBox);
  };
  function moveShot(s, d) {
    const i = show.shots.indexOf(s), j = clamp(i + d, 0, show.shots.length - 1);
    if (i === j) return;
    show.shots.splice(i, 1); show.shots.splice(j, 0, s); changed(); refresh('shots');
  }
  function deleteShot(s) {
    if (s.id === engine.programId) { toast('This shot is live — switch to another shot first.', 'error'); return; }
    show.shots = show.shots.filter(x => x !== s);
    if (s.role === 'hold') { toast('The holding screen can’t be deleted.', 'error'); return; }
    if (s.role === 'open') SV().start.videoId = '';
    if (s.role === 'close') SV().end.videoId = '';
    if (rt.previewId === s.id) setPreview(show.shots[0] && show.shots[0].id);
    rt.editingId = null; changed(); refresh('shots'); refresh('editor'); refresh('media');
  }

  /* ================= panel: colour ================= */
  const colorView = el('canvas', { width: 320, height: 180, style: 'width:100%;aspect-ratio:16/9;background:#000;border-radius:6px;display:block;margin-bottom:10px' });
  const COLOR_PARAMS = [
    ['exposure', 'Exposure', -3, 3, 0.05, v => `${v > 0 ? '+' : ''}${v.toFixed(2)}`],
    ['contrast', 'Contrast', 0.5, 1.8, 0.01, v => `${Math.round(v * 100)}%`],
    ['gamma', 'Mid-tones', 0.5, 2, 0.01, v => v.toFixed(2)],
    ['black', 'Black level', -0.2, 0.2, 0.005, v => `${v > 0 ? '+' : ''}${(v * 100).toFixed(1)}`],
    ['saturation', 'Saturation', 0, 2, 0.01, v => `${Math.round(v * 100)}%`],
    ['temp', 'Warmth', -1, 1, 0.01, v => `${v > 0 ? '+' : ''}${Math.round(v * 100)}`],
    ['tint', 'Tint', -1, 1, 0.01, v => `${v > 0 ? '+' : ''}${Math.round(v * 100)}`]
  ];
  RENDER.color = body => {
    body.innerHTML = '';
    const srcs = [...show.cameras.map(c => ({ id: c.id, name: c.name, obj: c })), ...show.files.filter(f => f.kind === 'video').map(f => ({ id: f.id, name: f.name, obj: f }))];
    if (!srcs.length) { put(body, el('div', { class: 'empty' }, 'Add a camera in the Inputs panel to adjust its picture.')); return; }
    if (!srcs.find(s => s.id === rt.colorSrc)) rt.colorSrc = srcs[0].id;
    const cur = srcs.find(s => s.id === rt.colorSrc);
    cur.obj.color = Object.assign(clone(NEUTRAL), cur.obj.color || {});
    const c = cur.obj.color;
    engine.sourceViews.set(colorView, cur.id);
    const apply = () => { engine.setColor(cur.id, c); changed(); };
    put(body, 
      el('div', { class: 'tabs' }, srcs.map(s => el('button', { class: 'tab' + (s.id === cur.id ? ' sel' : ''), onclick: () => { rt.colorSrc = s.id; refresh('color'); } }, s.name))),
      colorView,
      COLOR_PARAMS.map(([k, label, min, max, step, f]) => slider({ label, min, max, step, value: c[k], fmt: f, reset: NEUTRAL[k], onInput: v => { c[k] = v; apply(); } })),
      el('div', { class: 'row wrap', style: 'margin-top:10px' },
        (() => {
          const b = el('button', { class: 'btn small' }, 'Hold to compare');
          b.addEventListener('pointerdown', () => engine.bypass.add(cur.id));
          ['pointerup', 'pointerleave'].forEach(ev => b.addEventListener(ev, () => engine.bypass.delete(cur.id)));
          return b;
        })(),
        el('button', { class: 'btn small', onclick: () => { Object.assign(c, NEUTRAL); apply(); refresh('color'); } }, 'Reset'),
        show.cameras.length > 1 && camById(cur.id) ? el('button', { class: 'btn small', onclick: () => { show.cameras.forEach(cam => { cam.color = clone(c); engine.setColor(cam.id, cam.color); }); changed(); toast('Copied to all cameras.', 'ok'); } }, 'Copy to all cameras') : null,
        el('span', { class: 'grow' }),
        check(' Zebra stripes on Preview (shows over-bright areas)', settings.zebra, v => { settings.zebra = v; engine.zebra = v; saveSettings(); })),
      el('div', { class: 'muted', style: 'font-size:.82em;margin-top:8px' }, 'Zebra stripes on the Preview screen show parts that are too bright. Double-click a slider to reset it.')
    );
  };

  /* ================= web page overlays (live translation captions, scoreboards, any link) ================= */
  rt.webManual = new Set(); rt.webSuppress = new Set(); rt.webStatus = new Map(); rt.webCanvas = new Map();
  const WEB_POS = {
    bottom: ['Bottom third', [0, 0.667, 1, 0.333]],
    bottom4: ['Bottom quarter', [0, 0.75, 1, 0.25]],
    top: ['Top third', [0, 0, 1, 0.333]],
    full: ['Full screen', [0, 0, 1, 1]],
    right: ['Right third', [0.667, 0, 0.333, 1]],
    left: ['Left third', [0, 0, 0.333, 1]],
    custom: ['Custom…', null]
  };
  const newWeb = () => ({ id: uid('web'), name: 'Translation', url: '', pos: 'bottom', rect: WEB_POS.bottom[1].slice(), autoSize: true, width: 1920, height: 360, fps: 15, zoom: 1, transparent: true, key: { on: false, color: '#000000', tol: 0.15 }, opacity: 1, fadeMs: 400, css: '' });
  function webPageSize(w) {
    if (!w.autoSize) return [w.width, w.height];
    return [Math.round(1920 * w.rect[2]), Math.round(1080 * w.rect[3])];
  }
  function openWeb(w) {
    const [pw, ph] = webPageSize(w);
    let c = rt.webCanvas.get(w.id);
    if (!c) { c = el('canvas', { width: pw, height: ph }); rt.webCanvas.set(w.id, c); }
    c.width = pw; c.height = ph;
    engine.setSource(w.id, c, 'image');
    engine.setWeb(engineWeb(w), webWanted(w.id));
    S.webOpen(w.id, { url: w.url, width: pw, height: ph, fps: w.fps, zoom: w.zoom, transparent: w.transparent, css: w.css });
  }
  function closeWeb(id) { S.webClose(id); engine.removeWeb(id); engine.removeSource(id); rt.webCanvas.delete(id); }
  const engineWeb = w => ({ id: w.id, rect: w.rect, opacity: w.opacity, key: w.key, fadeMs: w.fadeMs });
  S.onWebFrame(f => {
    const c = rt.webCanvas.get(f.id);
    if (!c) return;
    if (c.width !== f.w || c.height !== f.h) { c.width = f.w; c.height = f.h; }
    const src = f.data, img = new ImageData(f.rw, f.rh), d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const a = src[i + 3];
      if (a === 255 || a === 0) { d[i] = src[i + 2]; d[i + 1] = src[i + 1]; d[i + 2] = src[i]; }
      else { const k = 255 / a; d[i] = Math.min(255, src[i + 2] * k); d[i + 1] = Math.min(255, src[i + 1] * k); d[i + 2] = Math.min(255, src[i] * k); }
      d[i + 3] = a;
    }
    c.getContext('2d').putImageData(img, f.x, f.y);
    const s2 = engine.sources.get(f.id); if (s2) s2.dirty = true;
  });
  S.onWebStatus(st => {
    rt.webStatus.set(st.id, st);
    document.querySelectorAll(`[data-web-status="${st.id}"]`).forEach(n => { n.textContent = st.text; n.className = st.ok ? 'muted' : 'status-bad'; });
  });
  function webWanted(id) {
    if (rt.webManual.has(id)) return true;
    const s2 = getShot(engine.trans ? engine.trans.to : engine.programId);
    return !!(s2 && (s2.webIds || []).includes(id) && !rt.webSuppress.has(id));
  }
  function refreshWebs() { for (const w of show.webs) engine.setWeb(engineWeb(w), webWanted(w.id)); for (const p2 of show.pics) applyPic(p2); refreshWebStates(); }
  function toggleWeb(id) {
    const cfg = show.webs.find(x => x.id === id) || show.pics.find(x => x.id === id);
    clearTimeout(rt.labelTimers.get(id)); rt.hideAt.delete(id);
    if (engine.webVisible(id)) { rt.webManual.delete(id); rt.webSuppress.add(id); }
    else {
      rt.webManual.add(id); rt.webSuppress.delete(id);
      if (cfg && cfg.autoHide > 0) {
        rt.hideAt.set(id, { at: Date.now() + cfg.autoHide * 1000, total: cfg.autoHide * 1000 });
        rt.labelTimers.set(id, setTimeout(() => { if (engine.webVisible(id)) (show.pics.some(x => x.id === id) ? togglePic : toggleWeb)(id); }, cfg.autoHide * 1000));
      }
    }
    refreshWebs();
  }
  function refreshWebStates() {
    document.querySelectorAll('.gtile[data-web], .gtile[data-pic]').forEach(t => {
      const on = engine.webVisible(t.dataset.web || t.dataset.pic);
      t.classList.toggle('on', on);
      t.querySelector('.spk-air').textContent = on ? 'ON AIR' : '';
    });
  }
  function editWeb(w, isNew) {
    const body = el('div');
    const view = el('canvas', { width: 480, height: 270, style: 'width:100%;aspect-ratio:16/9;border-radius:8px;display:block;background:repeating-conic-gradient(#2a2a2e 0% 25%, #1c1c1f 0% 50%) 50% / 24px 24px' });
    const reopen = debounce(() => { if (show.webs.includes(w)) openWeb(w); }, 700);
    const live = () => { engine.setWeb(engineWeb(w)); changed(); };
    let raf = 0;
    const paint = () => { if (!view.isConnected) return; const c = rt.webCanvas.get(w.id), g = view.getContext('2d'); g.clearRect(0, 0, 480, 270); g.fillStyle = 'rgba(37,99,235,.25)'; const r = w.rect; g.fillRect(r[0] * 480, r[1] * 270, r[2] * 480, r[3] * 270); if (c) g.drawImage(c, r[0] * 480, r[1] * 270, r[2] * 480, r[3] * 270); raf = requestAnimationFrame(paint); };
    const draw = () => {
      body.innerHTML = '';
      const st = rt.webStatus.get(w.id) || { ok: false, text: w.url ? '' : 'Enter the web address of the page' };
      const custom = w.pos === 'custom';
      const rs = (label, i) => slider({ label, min: 0, max: 1, step: 0.005, value: w.rect[i], reset: (WEB_POS.bottom[1])[i], fmt: v => `${Math.round(v * 100)}%`, onInput: v => { w.rect[i] = v; live(); if (w.autoSize) reopen(); } });
      put(body,
        el('div', { class: 'field' }, el('span', null, 'Name'), el('input', { type: 'text', value: w.name, oninput: e => { w.name = e.target.value; changed(); } })),
        el('div', { class: 'field' }, el('span', null, 'Web address (link)'), el('div', { class: 'row' },
          el('input', { type: 'text', class: 'grow', value: w.url, placeholder: 'https://… (the page that shows the live translation)', oninput: e => { w.url = e.target.value.trim(); changed(); reopen(); } }),
          el('button', { class: 'btn small', onclick: () => S.webReload(w.id) }, '↻ Reload'))),
        el('div', { style: 'font-size:.85em;margin:-4px 0 10px' }, el('span', { class: st.ok ? 'muted' : 'status-bad', dataset: { webStatus: w.id } }, st.text)),
        view,
        el('div', { class: 'grid2', style: 'margin-top:12px' },
          el('div', null,
            el('div', { class: 'field' }, el('span', null, 'Position on screen'), select(Object.entries(WEB_POS).map(([k, v]) => [k, v[0]]), w.pos, v => { w.pos = v; if (WEB_POS[v][1]) w.rect = WEB_POS[v][1].slice(); live(); if (w.autoSize) reopen(); draw(); })),
            custom ? el('div', null, rs('Left', 0), rs('Top', 1), rs('Width', 2), rs('Height', 3)) : null,
            slider({ label: 'Text size', min: 0.5, max: 3, step: 0.05, value: w.zoom, reset: 1, fmt: v => `${Math.round(v * 100)}%`, onInput: v => { w.zoom = v; changed(); reopen(); } }),
            slider({ label: 'Opacity', min: 0.1, max: 1, step: 0.01, value: w.opacity, reset: 1, fmt: v => `${Math.round(v * 100)}%`, onInput: v => { w.opacity = v; live(); } })),
          el('div', null,
            el('div', { style: 'margin-bottom:8px' }, check(' See-through page background', w.transparent, v => { w.transparent = v; changed(); reopen(); })),
            el('div', { class: 'row wrap' }, check(' Remove a colour', w.key.on, v => { w.key.on = v; live(); }),
              el('input', { type: 'color', value: w.key.color, title: 'Colour to remove (e.g. the page’s black or green background)', oninput: e => { w.key.color = e.target.value; live(); } })),
            slider({ label: 'Removal strength', min: 0.02, max: 0.6, step: 0.01, value: w.key.tol, reset: 0.15, fmt: v => `${Math.round(v * 100)}`, onInput: v => { w.key.tol = v; live(); } }),
            el('div', { class: 'field' }, el('span', null, 'Fade in / out'), select([[0, 'Instant'], [200, 'Fast'], [400, 'Normal'], [800, 'Smooth'], [1500, 'Slow']], w.fadeMs, v => { w.fadeMs = +v; live(); })),
            el('div', { class: 'field' }, el('span', null, 'Auto hide'), select([[0, 'Stay on until hidden'], [5, 'Hide after 5 s'], [10, 'Hide after 10 s'], [15, 'Hide after 15 s'], [30, 'Hide after 30 s'], [60, 'Hide after 1 min'], [120, 'Hide after 2 min'], [300, 'Hide after 5 min']], w.autoHide || 0, v => { w.autoHide = +v; changed(); })),
            el('div', { class: 'field' }, el('span', null, 'Updates per second'), select([[5, '5 (very light)'], [15, '15 (captions)'], [30, '30 (animations)']], w.fps, v => { w.fps = +v; changed(); reopen(); })))),
        el('details', { style: 'margin-top:8px' }, el('summary', { class: 'muted', style: 'cursor:pointer' }, 'Advanced'),
          el('div', { class: 'row wrap', style: 'margin:8px 0' }, check(' Page size follows position', w.autoSize, v => { w.autoSize = v; changed(); reopen(); draw(); }),
            !w.autoSize ? el('label', { class: 'inline' }, 'Width', el('input', { type: 'number', value: w.width, style: 'width:90px', onchange: e => { w.width = +e.target.value || 1920; changed(); reopen(); } })) : null,
            !w.autoSize ? el('label', { class: 'inline' }, 'Height', el('input', { type: 'number', value: w.height, style: 'width:90px', onchange: e => { w.height = +e.target.value || 1080; changed(); reopen(); } })) : null),
          el('div', { class: 'field' }, el('span', null, 'Custom CSS (to restyle the page)'), el('textarea', { rows: 3, style: 'font-family:Consolas,monospace', placeholder: 'e.g.  body { font-size: 48px; color: white; }', oninput: e => { w.css = e.target.value; changed(); reopen(); } }, w.css || ''))),
        el('div', { class: 'row', style: 'margin-top:14px' },
          isNew ? null : el('button', { class: 'btn danger', onclick: () => { closeWeb(w.id); show.webs = show.webs.filter(x => x !== w); show.shots.forEach(sh => { if (sh.webIds) sh.webIds = sh.webIds.filter(i => i !== w.id); }); delete settings.hotkeys['web:' + w.id]; saveSettings(); changed(); closeModal(); refresh('labels'); refresh('editor'); } }, 'Delete'),
          el('span', { class: 'grow' }),
          el('button', { class: 'btn', onclick: () => toggleWeb(w.id) }, 'Show / hide on air'),
          el('button', { class: 'btn primary', onclick: () => { closeModal(); refresh('labels'); refresh('editor'); } }, 'Done')));
      cancelAnimationFrame(raf); paint();
    };
    if (isNew) { show.webs.push(w); changed(); openWeb(w); }
    draw();
    openModal(isNew ? 'Add web page overlay' : `Web page — ${w.name}`, body);
    cancelAnimationFrame(raf); raf = requestAnimationFrame(paint);
  }

  /* ================= picture graphics: logo, seasonal decor, frames (PNG with transparency works best) ================= */
  const PIC_POS = { tl: 'Top left', tr: 'Top right', bl: 'Bottom left', br: 'Bottom right', tc: 'Top centre', bc: 'Bottom centre', center: 'Centre', full: 'Full screen (frame / border)' };
  const newPic = () => ({ id: uid('pic'), name: 'Logo', fileId: '', pos: 'tr', size: 0.12, margin: 0.03, opacity: 1, fadeMs: 500 });
  function picRect(p2) {
    const f = rt.files.get(p2.fileId), img = f && f.el;
    if (p2.pos === 'full') return [0, 0, 1, 1];
    const iw = (img && (img.naturalWidth || img.videoWidth)) || 1, ih = (img && (img.naturalHeight || img.videoHeight)) || 1;
    const w = p2.size, h = w * (engine.W / engine.H) * (ih / iw);
    const mx = p2.margin, my = p2.margin * engine.W / engine.H;
    const x = p2.pos.endsWith('l') ? mx : p2.pos.endsWith('r') ? 1 - w - mx : (1 - w) / 2;
    const y = p2.pos.startsWith('t') ? my : p2.pos.startsWith('b') ? 1 - h - my : (1 - h) / 2;
    return [x, y, w, h];
  }
  const applyPic = p2 => engine.setWeb({ id: p2.id, src: p2.fileId, rect: picRect(p2), opacity: p2.opacity, fadeMs: p2.fadeMs, key: {} }, !!p2.fileId && webWanted(p2.id));
  // pictures remember whether they were on air, so a logo stays up after restarting Live Studio
  function togglePic(id) { toggleWeb(id); const p2 = show.pics.find(x => x.id === id); if (p2) { p2.on = rt.webManual.has(id); changed(); } }
  function editPic(p2, isNew) {
    const body = el('div');
    const view = el('canvas', { width: 480, height: 270, style: 'width:100%;aspect-ratio:16/9;border-radius:8px;display:block;background:#000' });
    let raf = 0;
    const paint = () => {
      if (!view.isConnected) return;
      const g = view.getContext('2d');
      g.drawImage(engine.canvas, 0, 0, 480, 270);
      const f = rt.files.get(p2.fileId), r = picRect(p2);
      if (f && f.el && !engine.webVisible(p2.id)) { g.globalAlpha = p2.opacity * 0.85; g.drawImage(f.el, r[0] * 480, r[1] * 270, r[2] * 480, r[3] * 270); g.globalAlpha = 1; }
      g.strokeStyle = '#38bdf8'; g.setLineDash([6, 4]); g.lineWidth = 2; g.strokeRect(r[0] * 480, r[1] * 270, r[2] * 480, r[3] * 270); g.setLineDash([]);
      raf = requestAnimationFrame(paint);
    };
    const upd = () => { applyPic(p2); changed(); };
    const draw = () => {
      body.innerHTML = '';
      const imgs = show.files.filter(f => f.kind === 'image');
      put(body,
        el('div', { class: 'field' }, el('span', null, 'Name'), el('input', { type: 'text', value: p2.name, oninput: e => { p2.name = e.target.value; changed(); } })),
        el('div', { class: 'field' }, el('span', null, 'Picture'), el('div', { class: 'row' },
          select([['', imgs.length ? '— choose a picture —' : '— no pictures yet —'], ...imgs.map(f => [f.id, f.name])], p2.fileId, v => { p2.fileId = v; upd(); }, { class: 'grow' }),
          el('button', { class: 'btn small primary', onclick: async () => { const a2 = await addFiles(); const i = a2.find(f => f.kind === 'image'); if (i) { p2.fileId = i.id; if (p2.name === 'Logo' || !p2.name) p2.name = i.name; upd(); draw(); } } }, 'Import picture…'))),
        el('div', { class: 'muted', style: 'font-size:.82em;margin:-4px 0 10px' }, 'Use a PNG with a transparent background for logos and decorations. The dashed box shows where it goes on the live picture.'),
        view,
        el('div', { class: 'grid2', style: 'margin-top:12px' },
          el('div', null,
            el('div', { class: 'field' }, el('span', null, 'Position'), select(Object.entries(PIC_POS), p2.pos, v => { p2.pos = v; upd(); draw(); })),
            p2.pos !== 'full' ? slider({ label: 'Size', min: 0.04, max: 0.6, step: 0.005, value: p2.size, reset: 0.12, fmt: v => `${Math.round(v * 100)}%`, onInput: v => { p2.size = v; upd(); } }) : null,
            p2.pos !== 'full' ? slider({ label: 'From edge', min: 0, max: 0.12, step: 0.002, value: p2.margin, reset: 0.03, fmt: v => `${Math.round(v * 100)}%`, onInput: v => { p2.margin = v; upd(); } }) : null),
          el('div', null,
            slider({ label: 'Opacity', min: 0.1, max: 1, step: 0.01, value: p2.opacity, reset: 1, fmt: v => `${Math.round(v * 100)}%`, onInput: v => { p2.opacity = v; upd(); } }),
            el('div', { class: 'field' }, el('span', null, 'Fade in / out'), select([[0, 'Instant'], [300, 'Fast'], [500, 'Normal'], [1000, 'Smooth'], [2000, 'Slow']], p2.fadeMs, v => { p2.fadeMs = +v; upd(); })),
            el('div', { class: 'field' }, el('span', null, 'Auto hide'), select([[0, 'Stay on until hidden'], [5, 'Hide after 5 s'], [10, 'Hide after 10 s'], [15, 'Hide after 15 s'], [30, 'Hide after 30 s'], [60, 'Hide after 1 min'], [120, 'Hide after 2 min'], [300, 'Hide after 5 min']], p2.autoHide || 0, v => { p2.autoHide = +v; changed(); })))),
        el('div', { class: 'row', style: 'margin-top:14px' },
          isNew ? null : el('button', { class: 'btn danger', onclick: () => { engine.removeWeb(p2.id); show.pics = show.pics.filter(x => x !== p2); show.shots.forEach(sh => { if (sh.webIds) sh.webIds = sh.webIds.filter(i => i !== p2.id); }); delete settings.hotkeys['pic:' + p2.id]; saveSettings(); changed(); closeModal(); refresh('labels'); refresh('editor'); } }, 'Delete'),
          el('span', { class: 'grow' }),
          el('button', { class: 'btn', onclick: () => togglePic(p2.id) }, 'Show / hide on air'),
          el('button', { class: 'btn primary', onclick: () => { closeModal(); refresh('labels'); refresh('editor'); } }, 'Done')));
      cancelAnimationFrame(raf); raf = requestAnimationFrame(paint);
    };
    if (isNew) { show.pics.push(p2); changed(); }
    draw();
    openModal(isNew ? 'Add picture (logo / decoration)' : `Picture — ${p2.name}`, body);
  }

  /* ================= label designer: build how a label looks ================= */
  function restyleSpeaker() {
    if (rt.speakerId && engine.labelVisible(SPK)) { const p = show.speakers.find(x => x.id === rt.speakerId); if (p) { rt.speakerObj = speakerLabel(p); engine.setLabel(rt.speakerObj); } }
    changed();
  }
  function openDesigner(holder, sample, onChange) {
    const pv = el('canvas', { width: 960, height: 540, class: 'design-preview' });
    const off = el('canvas', { width: 960, height: 540 });
    const pctx = pv.getContext('2d'), octx = off.getContext('2d');
    let anim = 1;
    const D = () => labelDesign(holder);
    const paint = () => {
      const g = pctx.createLinearGradient(0, 0, 960, 540);
      g.addColorStop(0, '#3b4a63'); g.addColorStop(0.5, '#7b6a58'); g.addColorStop(1, '#1f2937');
      pctx.globalAlpha = 1; pctx.fillStyle = g; pctx.fillRect(0, 0, 960, 540);
      pctx.fillStyle = 'rgba(255,255,255,.10)'; pctx.beginPath(); pctx.arc(480, 250, 110, 0, 7); pctx.fill(); pctx.fillRect(330, 370, 300, 170);
      drawLabel(octx, 960, 540, { title: sample.title || 'Name', subtitle: sample.subtitle, style: holder.style, color: holder.color, design: holder.design });
      const d = D(), e = anim < 0.5 ? 2 * anim * anim : 1 - Math.pow(-2 * anim + 2, 2) / 2;
      let dx = 0, dy = 0;
      if (d.anim === 'slide') { const al = d.position[1]; if (al === 'l') dx = (1 - e) * -0.02 * 960; else if (al === 'r') dx = (1 - e) * 0.02 * 960; else dy = (1 - e) * 0.03 * 540; }
      pctx.globalAlpha = e; pctx.drawImage(off, dx, dy); pctx.globalAlpha = 1;
    };
    const play = () => {
      const ms = D().fadeMs, t0 = performance.now();
      if (!ms) { anim = 1; paint(); return; }
      const step = () => { if (!pv.isConnected) return; anim = Math.min(1, (performance.now() - t0) / ms); paint(); if (anim < 1) requestAnimationFrame(step); };
      anim = 0; paint(); setTimeout(() => requestAnimationFrame(step), 250);
    };
    const set = (k, v) => { holder.design = Object.assign({}, holder.design, { [k]: v }); onChange(); paint(); };
    const body = el('div');
    const draw = () => {
      const d = D();
      body.innerHTML = '';
      const color = (label, value, fn) => el('label', { class: 'inline' }, el('input', { type: 'color', value, oninput: e => fn(e.target.value) }), label);
      put(body,
        pv,
        el('div', { class: 'row wrap', style: 'margin:10px 0 14px' },
          el('span', { class: 'muted' }, 'Start from'),
          select([['lower', 'Lower third — dark'], ['lower-light', 'Lower third — light'], ['title', 'Big centre title'], ['corner', 'Corner tag']], holder.style, v => { holder.style = v; holder.design = {}; onChange(); draw(); paint(); }),
          el('span', { class: 'grow' }),
          el('button', { class: 'btn small', onclick: play }, '▶ Test animation')),
        el('div', { class: 'grid2' },
          el('div', null,
            el('h3', null, 'Text'),
            el('div', { class: 'field' }, el('span', null, 'Font'), select(['Segoe UI', 'Arial', 'Calibri', 'Verdana', 'Trebuchet MS', 'Bahnschrift', 'Georgia', 'Times New Roman', 'Impact', 'Consolas'].map(f => [f, f]), d.font, v => set('font', v))),
            slider({ label: 'Size', min: 0.5, max: 2.5, step: 0.05, value: d.size, reset: LABEL_PRESETS[holder.style].size, fmt: v => `${Math.round(v * 100)}%`, onInput: v => set('size', v) }),
            el('div', { class: 'row wrap', style: 'gap:16px;margin:8px 0' },
              check(' Bold', d.bold, v => set('bold', v)), check(' ALL CAPS', d.upper, v => set('upper', v)), check(' Shadow', d.shadow, v => set('shadow', v))),
            el('div', { class: 'row wrap', style: 'gap:16px' },
              color('Main text', d.textColor, v => set('textColor', v)), color('Second line', d.subColor, v => set('subColor', v))),
            el('h3', null, 'Box'),
            el('div', { class: 'row wrap', style: 'gap:16px;margin-bottom:8px' },
              color('Box colour', d.bgColor, v => set('bgColor', v)), color('Accent colour', holder.color || '#2563eb', v => { holder.color = v; onChange(); paint(); })),
            slider({ label: 'Box opacity', min: 0, max: 1, step: 0.02, value: d.bgOpacity, reset: LABEL_PRESETS[holder.style].bgOpacity, fmt: v => v < 0.02 ? 'no box' : `${Math.round(v * 100)}%`, onInput: v => set('bgOpacity', v) }),
            slider({ label: 'Round corners', min: 0, max: 40, step: 1, value: d.radius, reset: 0, fmt: v => `${v}`, onInput: v => set('radius', v) }),
            el('div', { class: 'field' }, el('span', null, 'Accent bar'), select([['left', 'On the side'], ['under', 'Line underneath'], ['none', 'None']], d.bar, v => set('bar', v)))),
          el('div', null,
            el('h3', null, 'Position on screen'),
            el('div', { class: 'pos-grid' }, ['tl', 'tc', 'tr', 'ml', 'mc', 'mr', 'bl', 'bc', 'br'].map(p => el('button', { class: 'btn' + (d.position === p ? ' sel' : ''), title: p, onclick: () => { set('position', p); draw(); } }, d.position === p ? '●' : ''))),
            slider({ label: 'From edge', min: 0.02, max: 0.25, step: 0.005, value: d.margin, reset: LABEL_PRESETS[holder.style].margin, fmt: v => `${Math.round(v * 100)}%`, onInput: v => set('margin', v) }),
            el('h3', null, 'Animation'),
            el('div', { class: 'field' }, el('span', null, 'How it appears'), select([['slide', 'Slide in + fade'], ['fade', 'Fade only']], d.anim, v => { set('anim', v); play(); })),
            el('div', { class: 'field' }, el('span', null, 'Fade speed (in and out)'), select([[0, 'Instant — no fade'], [150, 'Fast — 0.15 s'], [300, 'Normal — 0.3 s'], [600, 'Smooth — 0.6 s'], [1000, 'Slow — 1 s'], [2000, 'Very slow — 2 s']], d.fadeMs, v => { set('fadeMs', +v); play(); })))),
        el('div', { class: 'row', style: 'margin-top:14px' },
          el('button', { class: 'btn small', onclick: () => {
            const look = { style: holder.style, color: holder.color, design: clone(holder.design || {}) };
            show.labels.forEach(L => { Object.assign(L, clone(look)); engine.setLabel(L); });
            Object.assign(show.speakerStyle, clone(look)); restyleSpeaker();
            toast('This look is now used for all labels and speaker names.', 'ok');
          } }, 'Use this look for all labels and speakers'),
          el('span', { class: 'grow' }),
          el('button', { class: 'btn primary', onclick: () => { closeModal(); refresh('labels'); refresh('speakers'); } }, 'Done')));
    };
    draw(); paint();
    openModal('Design the label look', body);
  }

  /* ================= panel: labels ================= */
  // Titles & Graphics: every item (title, picture, web page) is a tile with a preview; drag tiles to reorder them
  function gfxItems() {
    const items = [
      ...show.labels.map(L => ({ id: L.id, kind: 'label', o: L, name: L.title || '(empty)', toggle: () => toggleLabel(L.id), edit: () => editLabel(L), on: () => engine.labelVisible(L.id), key: 'lbl:' + L.id })),
      ...show.pics.map(p2 => ({ id: p2.id, kind: 'pic', o: p2, name: p2.name || 'Picture', toggle: () => togglePic(p2.id), edit: () => editPic(p2), on: () => engine.webVisible(p2.id), key: 'pic:' + p2.id })),
      ...show.webs.map(w => ({ id: w.id, kind: 'web', o: w, name: w.name || 'Web page', toggle: () => toggleWeb(w.id), edit: () => editWeb(w), on: () => engine.webVisible(w.id), key: 'web:' + w.id }))
    ];
    const ord = show.gfxOrder || [];
    const rank = id => { const i = ord.indexOf(id); return i < 0 ? 1e6 : i; };
    return items.map((it, i) => [rank(it.id), i, it]).sort((x, y) => x[0] - y[0] || x[1] - y[1]).map(x => x[2]);
  }
  function drawGfxThumb(c, it) {
    const g = c.getContext('2d'), W = c.width, H = c.height;
    const gr = g.createLinearGradient(0, 0, W, H); gr.addColorStop(0, '#39465c'); gr.addColorStop(1, '#1f2632');
    g.fillStyle = gr; g.fillRect(0, 0, W, H);
    if (it.kind === 'label') { const t = rt.gfxTmp || (rt.gfxTmp = el('canvas', { width: 640, height: 360 })); drawLabel(t.getContext('2d'), 640, 360, it.o); g.drawImage(t, 0, 0, W, H); }
    else if (it.kind === 'pic') { const f = rt.files.get(it.o.fileId), r = picRect(it.o); if (f && f.ok && f.el) g.drawImage(f.el, r[0] * W, r[1] * H, r[2] * W, r[3] * H); }
    else { const wc = rt.webCanvas.get(it.id), r = it.o.rect; if (wc && wc.width) g.drawImage(wc, r[0] * W, r[1] * H, r[2] * W, r[3] * H); }
  }
  let gfxDrag = null;
  RENDER.labels = body => {
    body.innerHTML = '';
    const row = el('div', { class: 'tile-row' });
    const items = gfxItems();
    row.append(el('div', { class: 'gtile-adds' },
      el('div', { class: 'gtile add', onclick: () => {
        const last = show.labels[show.labels.length - 1] || show.speakerStyle;
        const L = { id: uid('lbl'), title: 'New title', subtitle: '', style: last.style || 'lower', color: last.color || settings.ui.accent, design: clone(last.design || {}), autoHide: 0 };
        show.labels.push(L); engine.setLabel(L, false); changed(); refresh('labels'); editLabel(L);
      } }, '+ Title'),
      el('div', { class: 'gtile add pic-add', onclick: () => editPic(newPic(), true) }, '+ Picture'),
      el('div', { class: 'gtile add web-add', onclick: () => editWeb(newWeb(), true) }, '+ Web page')));
    for (const it of items) {
      const on = it.on();
      const thumb = el('canvas', { width: 320, height: 180, class: 'g-thumb' });
      drawGfxThumb(thumb, it);
      const ds = { gid: it.id }; ds[it.kind === 'label' ? 'label' : it.kind] = it.id;
      const tile = el('div', { class: `gtile big ${it.kind}` + (on ? ' on' : ''), dataset: ds, draggable: 'true', title: 'Click to show / hide · drag to reorder', onclick: it.toggle },
        thumb,
        el('div', { class: 'g-cap' }, el('span', { class: 'g-ico' }, it.kind === 'label' ? 'T' : it.kind === 'pic' ? '🖼' : '🌐'), el('span', { class: 'g-title' }, it.name), keyChip(it.key)),
        el('span', { class: 'spk-air' }, on ? 'ON AIR' : ''),
        el('button', { class: 'edit', title: 'Edit', onclick: e => { e.stopPropagation(); it.edit(); } }, '✎'));
      tile._gfx = it;
      tile.addEventListener('dragstart', e => { gfxDrag = it.id; e.dataTransfer.effectAllowed = 'move'; });
      tile.addEventListener('dragover', e => { if (gfxDrag && gfxDrag !== it.id) { e.preventDefault(); tile.classList.add('drop'); } });
      tile.addEventListener('dragleave', () => tile.classList.remove('drop'));
      tile.addEventListener('drop', e => {
        e.preventDefault(); tile.classList.remove('drop');
        const ids = items.map(x => x.id).filter(x => x !== gfxDrag);
        ids.splice(ids.indexOf(it.id), 0, gfxDrag);
        show.gfxOrder = ids; gfxDrag = null; changed(); refresh('labels');
      });
      row.append(tile);
    }
    put(body, row);
  };
  setInterval(() => { document.querySelectorAll('.gtile.big.web').forEach(t => { if (t._gfx) drawGfxThumb(t.querySelector('canvas'), t._gfx); }); }, 2000);
  function editLabel(L) {
    const upd = () => { engine.setLabel(L); changed(); };
    openModal('Edit title / graphic', el('div', null,
      el('div', { class: 'field' }, el('span', null, 'Main text'), el('input', { type: 'text', value: L.title, oninput: e => { L.title = e.target.value; upd(); } })),
      el('div', { class: 'field' }, el('span', null, 'Second line (optional)'), el('input', { type: 'text', value: L.subtitle, oninput: e => { L.subtitle = e.target.value; upd(); } })),
      el('div', { class: 'row wrap', style: 'gap:10px' },
        el('button', { class: 'btn', onclick: () => openDesigner(L, { title: L.title, subtitle: L.subtitle }, upd) }, '🎨 Design look…'),
        el('label', { class: 'inline' }, 'Auto hide', select([[0, 'Stay on until hidden'], [5, 'Hide after 5 s'], [10, 'Hide after 10 s'], [15, 'Hide after 15 s'], [30, 'Hide after 30 s'], [60, 'Hide after 1 min'], [120, 'Hide after 2 min'], [300, 'Hide after 5 min']], L.autoHide, v => { L.autoHide = +v; changed(); }))),
      el('div', { class: 'row', style: 'margin-top:16px' },
        el('button', { class: 'btn danger', onclick: () => { engine.removeLabel(L.id); show.labels = show.labels.filter(x => x !== L); delete settings.hotkeys['lbl:' + L.id]; saveSettings(); changed(); closeModal(); refresh('labels'); } }, 'Delete'),
        el('span', { class: 'grow' }),
        el('button', { class: 'btn primary', onclick: () => { closeModal(); refresh('labels'); } }, 'Done'))));
  }
  function refreshLabelStates() {
    document.querySelectorAll('.gtile[data-label]').forEach(card => {
      const on = engine.labelVisible(card.dataset.label);
      card.classList.toggle('on', on);
      card.querySelector('.spk-air').textContent = on ? 'ON AIR' : '';
    });
  }

  /* ================= panel: before service & ending ================= */
  function radio(name, options, value, onchange) {
    return el('div', { class: 'radios' }, options.map(([v, label]) => {
      const i = el('input', { type: 'radio', name, value: v, checked: String(v) === String(value) });
      i.addEventListener('change', () => { if (i.checked) onchange(v); });
      return el('label', { class: 'check' }, i, label);
    }));
  }
  async function convertFile(f) {
    if (!S.convertMedia) { toast('Converting needs the installed app.', 'error'); return; }
    rt.files.set(f.id, { ok: false, text: 'Converting to MP4… 0%' }); refresh('inputs'); refresh('media');
    const r = await S.convertMedia(f.path, pct => {
      rt.files.set(f.id, { ok: false, text: `Converting to MP4… ${pct}%` });
      document.querySelectorAll(`[data-file-status="${f.id}"]`).forEach(n => { n.textContent = `Converting to MP4… ${pct}%`; });
    });
    if (r && r.path) { f.path = r.path; changed(); toast(`Converted “${f.name}”.`, 'ok'); await loadFile(f); }
    else { rt.files.set(f.id, { ok: false, text: `Could not convert: ${(r && r.error) || 'unknown error'}` }); refresh('inputs'); refresh('media'); }
  }
  function fileStatus(id) {
    const f = rt.files.get(id), file = fileById(id);
    if (!f || !file) return null;
    return el('div', { style: 'font-size:.85em;margin-top:4px' },
      el('span', { class: f.ok ? 'muted' : 'status-bad', dataset: { fileStatus: id } }, f.text),
      f.unsupported ? el('button', { class: 'btn small', style: 'margin-left:8px', onclick: () => convertFile(file) }, 'Convert to MP4') : null);
  }
  const STATE_TEXT = {
    hold: ['WAITING', 'Holding screen'],
    opening: ['OPENING VIDEO', 'then fades to the camera'],
    running: ['IN SERVICE', ''],
    closing: ['CLOSING VIDEO', ''],
    ended: ['ENDED', '']
  };
  function serviceSummary() {
    const st = SV().start, en = SV().end;
    const vid = id => (fileById(id) || {}).name;
    const cam = (getShot(st.cameraShot) || {}).name || 'camera';
    const a = [st.goLive ? 'go live' : null, st.record ? 'start recording' : null, st.videoId ? `play “${vid(st.videoId)}”` : null, `fade to ${cam}`].filter(Boolean);
    const b = [en.videoId ? `play “${vid(en.videoId)}”` : null, en.then === 'hold' ? 'back to holding screen' : 'fade to black', en.stopRec ? 'stop recording' : null, en.endStream ? `end stream after ${en.endAfter} s` : null].filter(Boolean);
    return [a.join(' → '), b.join(' → ')];
  }
  RENDER.media = body => {
    body.innerHTML = '';
    const [sumA, sumB] = serviceSummary();
    put(body,
      el('div', { class: 'svc-state', id: 'svcState' }),
      ytEventLine(),
      el('div', { class: 'svc-btns' },
        el('button', { class: 'btn svc-start', onclick: startService }, el('div', { class: 'svc-big' }, '▶ START SERVICE'), el('div', { class: 'svc-sum' }, sumA), keyChip('startService')),
        el('button', { class: 'btn svc-end', onclick: endService }, el('div', { class: 'svc-big' }, '■ END SERVICE'), el('div', { class: 'svc-sum' }, sumB), keyChip('endService'))),
      el('div', { class: 'row', style: 'margin-top:8px;gap:8px' },
        el('button', { class: 'btn small', onclick: showHold }, '🕘 Holding screen', keyChip('hold')),
        el('button', { class: 'btn small', onclick: openHoldDesigner }, '🎨 Design slide'),
        el('span', { class: 'grow' }),
        el('button', { class: 'btn small primary', onclick: openServiceEdit }, '⚙ Edit')));
    refreshServiceState();
  };
  function refreshServiceState() {
    const n = $('#svcState'); if (!n) return;
    const [tag, text] = STATE_TEXT[rt.service] || STATE_TEXT.hold;
    let extra = '';
    if (rt.endAt) extra = ` Stream ends in ${Math.max(0, Math.ceil((rt.endAt - Date.now()) / 1000))} s.`;
    n.innerHTML = '';
    n.append(el('span', { class: 'svc-tag ' + (rt.service || 'hold') }, tag), el('span', null, text + extra));
    if (rt.endAt) n.append(el('button', { class: 'btn small', onclick: clearEndTimer }, 'Keep streaming'));
    const o = roleShot('open'), f = o && rt.files.get(o.main.source);
    if (rt.service === 'opening' && f && f.el) n.append(el('span', { class: 'mono muted' }, ` −${fmtShort(f.el.duration - f.el.currentTime)}`));
  }
  setInterval(() => { if (rt.service === 'opening' || rt.service === 'closing') refreshServiceState(); }, 500);

  function openServiceEdit() {
    const H = SV().hold, st = SV().start, en = SV().end;
    const vids = () => show.files.filter(f => f.kind === 'video');
    const imgs = () => show.files.filter(f => f.kind === 'image');
    const body = el('div');
    const holdPrev = el('canvas', { width: 480, height: 270, class: 'hold-prev' });
    const paintPrev = () => { drawHold(); holdPrev.getContext('2d').drawImage(holdCanvas, 0, 0, 480, 270); };
    const done = () => { syncRoleShots(); changed(); refresh('media'); refresh('shots'); paintPrev(); };
    const videoPick = (cfg, key) => el('div', { class: 'row' },
      select([['', '— no video —'], ...vids().map(f => [f.id, f.name])], cfg[key], v => { cfg[key] = v; done(); }, { class: 'grow' }),
      el('button', { class: 'btn small', onclick: async () => { const a = await addFiles(); const v = a.find(f => f.kind === 'video'); if (v) { cfg[key] = v.id; done(); draw(); } } }, 'Import…'));
    const draw = () => {
      body.innerHTML = '';
      const camShots = show.shots.filter(x => !x.role).map(x => [x.id, x.name]);
      put(body,
        el('h3', null, '🕘 Holding slide (shown before the service)'),
        el('div', { class: 'grid2' }, el('div', null, holdPrev),
          el('div', null, el('div', { class: 'muted', style: 'margin-bottom:10px' }, 'Background picture, every line of text, the clock, colours and positions.'),
            el('button', { class: 'btn primary big', onclick: openHoldDesigner }, '🎨 Design the slide…'))),

        el('h3', null, '▶ When I press START SERVICE'),
        el('div', { class: 'row wrap', style: 'gap:18px;margin-bottom:10px' },
          check(' Go live on YouTube (if not live yet)', st.goLive, v => { st.goLive = v; done(); }),
          check(' Start recording', st.record, v => { st.record = v; done(); })),
        el('div', { class: 'field' }, el('span', null, 'Play this video first'), videoPick(st, 'videoId'), st.videoId ? fileStatus(st.videoId) : null),
        el('div', { class: 'grid2' },
          el('div', { class: 'field' }, el('span', null, st.videoId ? 'Then fade into' : 'Fade into'), select(camShots.length ? camShots : [['', '— add a camera —']], st.cameraShot, v => { st.cameraShot = v; done(); })),
          el('div', { class: 'field' }, el('span', null, 'Fade length'), select([[500, '0.5 second'], [1000, '1 second'], [2000, '2 seconds'], [3000, '3 seconds'], [5000, '5 seconds']], st.fadeMs, v => { st.fadeMs = +v; done(); }))),
        check(' Start the YouTube event automatically once YouTube is receiving the stream', st.ytLive, v => { st.ytLive = v; done(); }),

        el('h3', null, '■ When I press END SERVICE'),
        el('div', { class: 'field' }, el('span', null, 'Play this video first'), videoPick(en, 'videoId'), en.videoId ? fileStatus(en.videoId) : null),
        el('div', { class: 'grid2' },
          el('div', { class: 'field' }, el('span', null, 'Then show'), select([['hold', 'The holding screen'], ['black', 'Black']], en.then, v => { en.then = v; done(); })),
          el('div', { class: 'field' }, el('span', null, 'Fade length'), select([[500, '0.5 second'], [1500, '1.5 seconds'], [3000, '3 seconds']], en.fadeMs, v => { en.fadeMs = +v; done(); }))),
        el('div', { class: 'row wrap', style: 'gap:18px' },
          check(' Stop recording', en.stopRec, v => { en.stopRec = v; done(); }),
          check(' End the stream', en.endStream, v => { en.endStream = v; done(); draw(); }),
          en.endStream ? el('label', { class: 'inline' }, 'after', select([[5, '5 s'], [15, '15 s'], [30, '30 s'], [60, '1 min'], [120, '2 min'], [300, '5 min']], en.endAfter, v => { en.endAfter = +v; done(); })) : null,
          check(' End the YouTube event too', en.ytComplete, v => { en.ytComplete = v; done(); })),
        el('div', { class: 'row', style: 'margin-top:16px' }, el('span', { class: 'grow' }), el('button', { class: 'btn primary', onclick: () => closeModal() }, 'Done')));
      paintPrev();
    };
    draw();
    openModal('Edit service — what Start and End do', body);
  }

  /* ================= YouTube: account, upcoming events, stream health ================= */
  rt.yt = { signedIn: false, configured: false, channel: null, events: [], event: null, health: null, viewers: null, busy: false };
  const Y = (method, endpoint, query, body) => S.yt.api(method, endpoint, query, body).then(r => { if (r.error) throw new Error(r.error); return r.data; });
  async function ytInit() {
    const st = await S.yt.status();
    Object.assign(rt.yt, { signedIn: st.signedIn, configured: st.configured, channel: st.channel });
    if (rt.yt.signedIn) {
      await ytLoadEvents().catch(e => toast('YouTube: ' + e.message, 'error'));
      if (show.ytEventId) { const ev = rt.yt.events.find(x => x.id === show.ytEventId); if (ev) await ytSelect(ev, true).catch(() => {}); }
    }
    refresh('media'); renderHeader();
  }
  const mapEvent = b => ({
    id: b.id, title: b.snippet.title, start: b.snippet.scheduledStartTime || b.snippet.actualStartTime, thumb: ((b.snippet.thumbnails || {}).medium || (b.snippet.thumbnails || {}).default || {}).url,
    streamId: b.contentDetails.boundStreamId, autoStart: b.contentDetails.enableAutoStart, autoStop: b.contentDetails.enableAutoStop,
    monitor: b.contentDetails.monitorStream && b.contentDetails.monitorStream.enableMonitorStream, life: b.status.lifeCycleStatus, privacy: b.status.privacyStatus
  });
  async function ytLoadEvents() {
    const part = 'snippet,contentDetails,status';
    const [up, act] = await Promise.all([
      Y('GET', 'liveBroadcasts', { part, broadcastStatus: 'upcoming', broadcastType: 'all', maxResults: 25 }),
      Y('GET', 'liveBroadcasts', { part, broadcastStatus: 'active', broadcastType: 'all', maxResults: 5 })
    ]);
    rt.yt.events = [...(act.items || []), ...(up.items || [])].map(mapEvent).sort((a, b) => new Date(a.start || 0) - new Date(b.start || 0));
    return rt.yt.events;
  }
  async function ytSelect(ev, quiet) {
    rt.yt.busy = true;
    try {
      let streamId = ev.streamId;
      let stream = null;
      if (streamId) { const r = await Y('GET', 'liveStreams', { part: 'cdn,status', id: streamId }); stream = r.items && r.items[0]; }
      if (!stream) {
        // the event has no stream key yet: reuse the one already in Live Studio, or make one, and attach it
        const mine = await Y('GET', 'liveStreams', { part: 'cdn,status', mine: 'true', maxResults: 50 });
        stream = (mine.items || []).find(x => x.cdn.ingestionInfo.streamName === settings.youtube.key) || (mine.items || [])[0];
        if (!stream) stream = await Y('POST', 'liveStreams', { part: 'snippet,cdn,contentDetails,status' }, { snippet: { title: 'Live Studio' }, cdn: { ingestionType: 'rtmp', resolution: 'variable', frameRate: 'variable' }, contentDetails: { isReusable: true } });
        await Y('POST', 'liveBroadcasts/bind', { id: ev.id, part: 'id,contentDetails', streamId: stream.id });
        ev.streamId = stream.id;
      }
      settings.youtube.key = stream.cdn.ingestionInfo.streamName;
      if (settings.youtube.server === 'custom') settings.youtube.server = 'rtmps://a.rtmps.youtube.com:443/live2';
      saveSettings();
      rt.yt.event = ev; show.ytEventId = ev.id; changed();
      ytApplyStream(stream);
      if (!quiet) toast(`YouTube event “${ev.title}” selected — stream key filled in.`, 'ok');
      ytStartPolling();
    } finally { rt.yt.busy = false; refresh('media'); }
  }
  function ytApplyStream(stream) {
    const st = stream.status || {}, h = st.healthStatus || {};
    rt.yt.health = { stream: st.streamStatus, status: h.status || 'noData', issues: (h.configurationIssues || []).filter(i => i.severity !== 'info').map(i => i.description || i.reason) };
  }
  let ytTimer = null;
  function ytStartPolling() {
    clearInterval(ytTimer);
    ytTimer = setInterval(ytPoll, rt.live ? 10000 : 30000);
    ytPoll();
  }
  async function ytPoll() {
    const ev = rt.yt.event;
    if (!rt.yt.signedIn || !ev || !ev.streamId) return;
    try {
      const [st, b] = await Promise.all([
        Y('GET', 'liveStreams', { part: 'status', id: ev.streamId }),
        Y('GET', 'liveBroadcasts', { part: 'status,contentDetails,snippet', id: ev.id })
      ]);
      if (st.items && st.items[0]) ytApplyStream(st.items[0]);
      if (b.items && b.items[0]) Object.assign(ev, mapEvent(b.items[0]));
      if (ev.life === 'live') {
        const v = await Y('GET', 'videos', { part: 'liveStreamingDetails', id: ev.id });
        const d = v.items && v.items[0] && v.items[0].liveStreamingDetails;
        rt.yt.viewers = d && d.concurrentViewers !== undefined ? +d.concurrentViewers : null;
      }
      rt.yt.error = null;
    } catch (e) { rt.yt.error = e.message; }
    refreshYtLine(); tickHeader();
  }
  function ytAfterGoLive() { if (rt.yt.event) ytStartPolling(); }
  // YouTube only shows the event once it is "live"; do that for events that don't start themselves
  async function ytGoLiveWhenReady() {
    const ev = rt.yt.event;
    if (!ev || !rt.yt.signedIn || ev.autoStart || ev.life === 'live') return;
    if (rt.yt.starting) return;
    rt.yt.starting = true;
    toast('Waiting for YouTube to receive the stream, then starting the event…');
    try {
      for (let i = 0; i < 40; i++) {
        await ytPoll();
        if (!rt.live) return;
        if (rt.yt.health && rt.yt.health.stream === 'active') break;
        await new Promise(r => setTimeout(r, 5000));
      }
      if (ev.life !== 'testing' && ev.monitor) { await Y('POST', 'liveBroadcasts/transition', { broadcastStatus: 'testing', id: ev.id, part: 'status' }).catch(() => {}); await new Promise(r => setTimeout(r, 6000)); }
      await Y('POST', 'liveBroadcasts/transition', { broadcastStatus: 'live', id: ev.id, part: 'status' });
      toast('YouTube event is live ✓', 'ok');
      ytPoll();
    } catch (e) { toast('YouTube could not start the event: ' + e.message + ' — you can start it in YouTube Studio.', 'error'); }
    finally { rt.yt.starting = false; }
  }
  async function ytComplete() {
    const ev = rt.yt.event;
    if (!ev || !rt.yt.signedIn || ev.life !== 'live' || ev.autoStop) return;
    try { await Y('POST', 'liveBroadcasts/transition', { broadcastStatus: 'complete', id: ev.id, part: 'status' }); toast('YouTube event ended.', 'ok'); } catch (e) { toast('YouTube: ' + e.message, 'error'); }
  }
  const fmtWhen = iso => { if (!iso) return ''; const d = new Date(iso); return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }) + ' · ' + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); };
  const HEALTH = { good: ['good', 'YouTube: receiving — good'], ok: ['ok', 'YouTube: receiving — OK'], bad: ['bad', 'YouTube: receiving — poor'], noData: ['wait', 'YouTube: not receiving yet'] };
  function ytHealthText() {
    const h = rt.yt.health;
    if (!h) return ['', ''];
    if (h.stream !== 'active') return [rt.live ? 'wait' : '', rt.live ? 'YouTube: waiting for your stream…' : 'YouTube: ready'];
    return HEALTH[h.status] || HEALTH.noData;
  }
  function ytEventLine() { const n = el('div', { class: 'yt-line', id: 'ytLine' }); fillYtLine(n); return n; }
  function refreshYtLine() { const n = $('#ytLine'); if (n) fillYtLine(n); }
  function fillYtLine(n) {
    n.innerHTML = '';
    n.append(el('span', { class: 'yt-logo' }, '▶ YouTube'));
    if (!rt.yt.signedIn) { n.append(el('span', { class: 'muted grow' }, 'Not connected — stream key only'), el('button', { class: 'btn small', onclick: openYouTube }, 'Connect…')); return; }
    const ev = rt.yt.event;
    if (!ev) { n.append(el('span', { class: 'muted grow' }, `${rt.yt.events.length} upcoming event${rt.yt.events.length === 1 ? '' : 's'}`), el('button', { class: 'btn small primary', onclick: openYouTube }, 'Choose event…')); return; }
    const [cls, txt] = ytHealthText();
    n.append(el('span', { class: 'grow', style: 'min-width:0' }, el('b', null, ev.title), el('span', { class: 'muted' }, ' · ' + fmtWhen(ev.start) + (ev.life === 'live' ? ' · LIVE' : ''))),
      cls ? el('span', { class: 'yt-dot ' + cls, title: txt }) : null, el('span', { class: 'muted' }, txt.replace('YouTube: ', '')),
      rt.yt.viewers !== null && ev.life === 'live' ? el('span', null, `👁 ${rt.yt.viewers}`) : null,
      el('button', { class: 'btn small', onclick: openYouTube }, 'Change'));
    if (rt.yt.health && rt.yt.health.issues.length && rt.live) n.append(el('div', { class: 'status-bad', style: 'width:100%;font-size:.85em' }, '⚠ ' + rt.yt.health.issues.slice(0, 2).join(' · ')));
  }
  async function openYouTube() {
    const y = settings.youtube;
    const body = el('div');
    const draw = async () => {
      body.innerHTML = '';
      const st = await S.yt.status();
      Object.assign(rt.yt, { signedIn: st.signedIn, configured: st.configured, channel: st.channel });
      if (st.browser) { put(body, el('div', { class: 'empty' }, 'YouTube connection works in the installed app.')); return; }
      if (!st.signedIn) {
        put(body,
          el('div', { class: 'muted', style: 'margin-bottom:12px;line-height:1.55' },
            'Connecting lets Live Studio show your upcoming YouTube events, fill in the stream key for you, start and end the event, and check that YouTube is receiving your stream well.'),
          el('h3', null, 'One-time setup (about 10 minutes)'),
          el('ol', { class: 'yt-steps' },
            el('li', null, 'Go to ', el('b', null, 'console.cloud.google.com'), ', sign in with the Google account that owns your YouTube channel, and create a project named “Live Studio”.'),
            el('li', null, 'Open ', el('b', null, 'APIs & Services → Library'), ', search for ', el('b', null, 'YouTube Data API v3'), ' and click ', el('b', null, 'Enable'), '.'),
            el('li', null, 'Open ', el('b', null, 'OAuth consent screen'), ': choose ', el('b', null, 'External'), ', fill in the app name and your email, then under ', el('b', null, 'Audience'), ' click ', el('b', null, 'Publish app'), ' (so the sign-in doesn’t expire every 7 days).'),
            el('li', null, 'Open ', el('b', null, 'Credentials → Create credentials → OAuth client ID'), ', choose ', el('b', null, 'Desktop app'), ', and create it.'),
            el('li', null, 'Copy the ', el('b', null, 'Client ID'), ' and ', el('b', null, 'Client secret'), ' into the boxes below, then click ', el('b', null, 'Sign in with Google'), '. Google will say the app isn’t verified — click ', el('b', null, 'Advanced → Go to Live Studio'), '. That is expected for your own private app.')),
          el('div', { class: 'field' }, el('span', null, 'Client ID'), el('input', { type: 'text', value: y.clientId || '', placeholder: '…apps.googleusercontent.com', oninput: e => { y.clientId = e.target.value.trim(); saveSettingsNow(); } })),
          el('div', { class: 'field' }, el('span', null, 'Client secret'), el('input', { type: 'password', value: y.clientSecret || '', oninput: e => { y.clientSecret = e.target.value.trim(); saveSettingsNow(); } })),
          el('div', { class: 'row' }, el('span', { class: 'grow' }),
            el('button', { class: 'btn primary', onclick: async e => {
              e.target.disabled = true; e.target.textContent = 'Finish signing in in your browser…';
              await S.saveSettings(settings);
              const r = await S.yt.signIn();
              if (r.error) toast('YouTube sign-in: ' + r.error, 'error'); else { toast(`Connected to ${r.channel ? r.channel.title : 'YouTube'} ✓`, 'ok'); await ytInit(); }
              draw();
            } }, 'Sign in with Google')));
        return;
      }
      const list = el('div', { class: 'yt-list' }, el('div', { class: 'muted' }, 'Loading events…'));
      const ev = rt.yt.event;
      const [cls, txt] = ytHealthText();
      put(body,
        el('div', { class: 'row', style: 'margin-bottom:12px' },
          st.channel && st.channel.thumb ? el('img', { src: st.channel.thumb, style: 'width:36px;height:36px;border-radius:50%' }) : null,
          el('div', { class: 'grow' }, el('b', null, st.channel ? st.channel.title : 'YouTube account'), el('div', { class: 'muted', style: 'font-size:.85em' }, 'Connected')),
          el('button', { class: 'btn small', onclick: async () => { await ytLoadEvents().catch(e => toast(e.message, 'error')); draw(); } }, '↻ Refresh'),
          el('button', { class: 'btn small danger', onclick: async () => { await S.yt.signOut(); rt.yt.signedIn = false; rt.yt.event = null; show.ytEventId = ''; changed(); clearInterval(ytTimer); refresh('media'); draw(); } }, 'Disconnect')),
        el('h3', null, 'Checklist'),
        el('div', { class: 'yt-checks' },
          el('div', null, '✅ Connected to YouTube'),
          el('div', null, ev ? `✅ Event: ${ev.title}` : '⬜ Choose the event for this service below'),
          el('div', null, settings.youtube.key ? '✅ Stream key filled in' : '⬜ Stream key'),
          el('div', null, ev ? (cls === 'good' || cls === 'ok' ? '✅ ' : cls === 'bad' ? '⚠️ ' : '⬜ ') + txt.replace('YouTube: ', 'YouTube is ') : '⬜ YouTube receiving the stream'),
          ev ? el('div', { class: 'muted' }, ev.autoStart ? 'This event starts by itself when YouTube receives your stream.' : 'Live Studio will start this event on YouTube after you press START SERVICE.') : null),
        el('h3', null, 'Upcoming events'),
        list,
        el('div', { class: 'muted', style: 'font-size:.85em;margin-top:8px' }, 'Schedule events in YouTube Studio → Create → Go live → Manage → Schedule stream. They show up here.'));
      const events = rt.yt.events.length ? rt.yt.events : await ytLoadEvents().catch(e => { toast(e.message, 'error'); return []; });
      list.innerHTML = '';
      if (!events.length) list.append(el('div', { class: 'empty' }, 'No upcoming events. Schedule one in YouTube Studio, then click Refresh.'));
      for (const e2 of events) list.append(el('div', { class: 'yt-item' + (ev && ev.id === e2.id ? ' sel' : ''), onclick: async () => { list.style.opacity = .5; await ytSelect(e2).catch(er => toast('YouTube: ' + er.message, 'error')); draw(); } },
        e2.thumb ? el('img', { src: e2.thumb }) : null,
        el('div', { class: 'grow' }, el('b', null, e2.title), el('div', { class: 'muted', style: 'font-size:.85em' }, `${fmtWhen(e2.start)} · ${e2.privacy}${e2.life === 'live' ? ' · LIVE NOW' : ''}`)),
        ev && ev.id === e2.id ? el('span', { class: 'svc-tag running' }, 'SELECTED') : el('button', { class: 'btn small' }, 'Use this')));
    };
    openModal('YouTube', body);
    draw();
  }
  const saveSettingsNow = debounce(() => S.saveSettings(settings), 300);

  /* ================= panel: speakers ================= */
  RENDER.speakers = body => {
    body.innerHTML = '';
    const st = show.speakerStyle;
    const row = el('div', { class: 'tile-row' });
    show.speakers.forEach(p => {
      row.append(el('div', { class: 'spk' + (speakerOnAir(p.id) ? ' on' : '') + (rt.armedSpk === p.id ? ' armed' : ''), dataset: { spk: p.id }, title: 'Click to preview, then TAKE (Ctrl+G) · double-click to show / hide right away', onclick: () => armSpeaker(rt.armedSpk === p.id ? null : p.id), ondblclick: () => { armSpeaker(null); toggleSpeaker(p.id); } },
        el('div', { class: 'spk-name' }, p.name || '(no name)'),
        el('div', { class: 'spk-title' }, p.title || ''),
        el('div', { class: 'spk-foot' }, el('span', { class: 'spk-air' }, speakerOnAir(p.id) ? 'ON AIR' : ''), keyChip('spk:' + p.id)),
        el('button', { class: 'edit', title: 'Edit', onclick: e => { e.stopPropagation(); editSpeaker(p); } }, '✎')));
    });
    row.append(el('div', { class: 'spk add', onclick: () => { const p = { id: uid('spk'), name: '', title: '', hotkey: '' }; editSpeaker(p, true); } }, '+ Add person'));
    put(body,
      el('div', { class: 'spk-tools' },
        el('button', { class: 'btn small', onclick: () => { const p = show.speakers[0] || { name: 'John Smith', title: 'Senior Pastor' }; openDesigner(st, { title: p.name, subtitle: p.title }, restyleSpeaker); } }, '🎨 Look'),
        select([[0, 'Stay on'], [5, 'Hide after 5 s'], [8, 'Hide after 8 s'], [10, 'Hide after 10 s'], [15, 'Hide after 15 s']], st.autoHide, v => { st.autoHide = +v; changed(); }),
        el('button', { class: 'btn small danger', id: 'spkHide', onclick: hideSpeaker }, el('span', null, 'Hide'), keyChip('hideAll'))),
      row);
  };
  // click a person = cue their caption on the Preview screen; TAKE (Ctrl+G) then puts it on air
  function armSpeaker(id) {
    const p = id && show.speakers.find(x => x.id === id);
    rt.armedSpk = p ? id : null;
    engine.setPreviewLabel(p ? speakerLabel(p) : null);
    document.querySelectorAll('.spk[data-spk]').forEach(t => t.classList.toggle('armed', t.dataset.spk === rt.armedSpk));
    const tb = document.querySelector('.take-btn'); if (tb) tb.classList.toggle('armed', !!rt.armedSpk);
    renderTally();
  }
  function spkHint(t) {
    t.classList.add('hint'); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('hint'), 1200);
  }
  function refreshSpeakerStates() {
    document.querySelectorAll('.spk[data-spk]').forEach(c => {
      const on = speakerOnAir(c.dataset.spk) || (rt.speakerId === c.dataset.spk);
      c.classList.toggle('on', on);
      c.querySelector('.spk-air').textContent = on ? 'ON AIR' : '';
    });
  }
  function editSpeaker(p, isNew) {
    const d = { name: p.name, title: p.title };
    openModal(isNew ? 'Add person' : 'Edit person', el('div', null,
      el('div', { class: 'field' }, el('span', null, 'Name'), el('input', { type: 'text', value: d.name, oninput: e => { d.name = e.target.value; } })),
      el('div', { class: 'field' }, el('span', null, 'Title / role'), el('input', { type: 'text', value: d.title, oninput: e => { d.title = e.target.value; } })),
      el('div', { class: 'row' },
        el('button', { class: 'btn danger', onclick: () => { if (rt.speakerId === p.id) hideSpeaker(); show.speakers = show.speakers.filter(x => x !== p); delete settings.hotkeys['spk:' + p.id]; saveSettings(); changed(); closeModal(); refresh('speakers'); } }, 'Delete'),
        el('button', { class: 'btn small', onclick: () => { const i = show.speakers.indexOf(p); if (i > 0) { show.speakers.splice(i, 1); show.speakers.splice(i - 1, 0, p); changed(); refresh('speakers'); } } }, '◂ Move'),
        el('button', { class: 'btn small', onclick: () => { const i = show.speakers.indexOf(p); if (i < show.speakers.length - 1) { show.speakers.splice(i, 1); show.speakers.splice(i + 1, 0, p); changed(); refresh('speakers'); } } }, 'Move ▸'),
        el('span', { class: 'grow' }),
        el('button', { class: 'btn primary', onclick: () => { if (isNew) { if (!d.name.trim()) return; show.speakers.push(p); } p.name = d.name; p.title = d.title; if (rt.speakerId === p.id && engine.labelVisible(SPK)) { rt.speakerObj = speakerLabel(p); engine.setLabel(rt.speakerObj); } changed(); closeModal(); refresh('speakers'); refresh('editor'); } }, 'Save'))));
  }

  /* ================= panel: audio — compact: master meters on top, one slim row per input ================= */
  const dbText = v => v <= -60 ? '-∞' : `${v > 0 ? '+' : ''}${v.toFixed(1)}`;
  // a fader with the level meter drawn inside its track
  function chFader(id, cfg, min, onGain) {
    const fill = el('i', { class: 'ch-level' });
    const range = el('input', { type: 'range', min, max: 12, step: 0.5, value: cfg.gain, title: 'Volume — double-click for 0 dB' });
    const db = el('span', { class: 'ch-db mono' }, dbText(cfg.gain));
    const set = v => { cfg.gain = v; db.textContent = dbText(v); onGain(); changed(); };
    range.addEventListener('input', () => set(+range.value));
    range.addEventListener('dblclick', () => { range.value = 0; set(0); });
    const wrap = el('div', { class: 'ch-fader' + (cfg.mute ? ' muted' : '') }, el('div', { class: 'ch-track' }, fill), range);
    if (id) rt.meters.set(id, { i: fill, m: wrap });
    return [wrap, db];
  }
  function chRow({ id, name, sub, cfg, extra }) {
    const [fader, db] = chFader(id, cfg, -60, () => mixer.update(id, cfg));
    const mute = el('button', { class: 'ch-mute' + (cfg.mute ? ' on' : ''), title: 'Mute', onclick: () => { cfg.mute = !cfg.mute; mixer.update(id, cfg); changed(); mute.classList.toggle('on', cfg.mute); fader.classList.toggle('muted', cfg.mute); mute.textContent = cfg.mute ? '🔇' : '🔊'; } }, cfg.mute ? '🔇' : '🔊');
    return el('div', { class: 'ch' }, mute,
      el('div', { class: 'ch-name', title: sub || '' }, name, sub ? el('small', null, sub) : null),
      fader, db, extra || el('span'));
  }
  const masterCanvas = el('canvas', { class: 'master-meters', width: 150, height: 300 });
  const gonio = el('canvas', { class: 'gonio', width: 160, height: 160 });
  const corrCanvas = el('canvas', { class: 'corr', width: 300, height: 26 });
  const lufsBox = el('div', { class: 'lufs mono' });
  RENDER.audio = body => {
    body.innerHTML = '';
    const m = show.audio.master;
    const tog = (label, key, title, fn) => { const b = el('button', { class: 'tbtn' + (m[key] ? ' on' : ''), title, onclick: () => { m[key] = !m[key]; fn(); changed(); b.classList.toggle('on', !!m[key]); } }, label); return b; };
    const names = show.audio.inputs.map(a => a.name).join(', ');
    put(body, el('div', { class: 'aud2' },
      el('div', { class: 'master-top' },
        masterCanvas,
        el('div', { class: 'master-side' },
          el('div', { class: 'mlabel' }, 'Stereo / phase'), corrCanvas,
          el('div', { class: 'corr-scale' }, el('span', null, '−1 out of phase'), el('span', null, '0'), el('span', null, '+1 mono')),
          gonio, lufsBox)),
      el('div', { class: 'aud-tools' },
        tog('🎧', 'monitor', 'Listen on this computer (headphones / speakers)', () => mixer.setMaster(m)),
        tog('MONO', 'mono', 'Listen in mono to check phase — only your headphones, not the stream', () => mixer.setMono(!!m.mono)),
        tog('LIMIT', 'limiter', 'YouTube-safe limiter: keeps peaks at or below −1 dB so the stream never clips', () => mixer.setMaster(m)),
        tog('AUTO −14', 'auto', 'Auto level: slowly turns the overall volume up or down to sit at YouTube’s −14 LUFS', () => {}),
        el('span', { class: 'grow' }),
        el('button', { class: 'tbtn', title: 'Sound card, volumes, mute, sync test', onclick: openMixer }, names ? '🎚 Mixer' : '🔌 Connect sound card'))));
    mixer.setMono(!!m.mono);
  };
  /* volumes and sound-card connections live in this pop-up so the main screen stays clean */
  function openMixer() {
    const body = el('div');
    rt.meters.clear();
    const m = show.audio.master;
    const [mFader, mDb] = chFader(null, m, -60, () => mixer.setMaster(m));
    const rows = el('div', { class: 'ch-list' });
    for (const a of show.audio.inputs) {
      const dev = rt.devices.audio.find(d => d.id === a.deviceId);
      rows.append(chRow({ id: a.id, name: a.name, cfg: a,
        sub: `${dev ? dev.label.replace(/\s*\(.*?\)\s*$/, '') + (rt.audFail.has(a.id) ? ' — reconnecting…' : '') : (a.deviceLabel ? a.deviceLabel.replace(/\s*\(.*?\)\s*$/, '') + ' — not found, waiting for it…' : 'device missing — click ⚙')} · ${a.channel === 'stereo' ? 'stereo' : a.channel === 'mix' ? 'mono' : 'in ' + a.channel}${a.delay ? ` · ${a.delay} ms` : ''}`,
        extra: el('button', { class: 'ch-set', title: 'Choose sound card / input, delay', onclick: () => inputSettings(a) }, '⚙') }));
    }
    rows.append(chRow({ id: 'media', name: 'Videos', sub: 'opening / closing videos', cfg: show.audio.media }));
    put(body,
      el('h3', null, 'Sound cards & inputs'),
      show.audio.inputs.length ? null : el('div', { class: 'status-bad', style: 'margin-bottom:8px' }, 'No sound card connected yet. Click “+ Connect sound card”.'),
      rows,
      el('div', { class: 'row wrap', style: 'gap:8px;margin:10px 0 4px' },
        el('button', { class: 'btn primary', onclick: () => inputSettings(null) }, '+ Connect sound card / input'),
        el('button', { class: 'btn', onclick: async () => { await refreshDevices(); toast(`Found ${rt.devices.audio.length} audio devices.`); openMixer(); } }, '↻ Rescan devices'),
        el('button', { class: 'btn', onclick: openSyncTest }, '⏱ Sync test')),
      el('div', { class: 'muted', style: 'font-size:.85em' }, 'Click ⚙ on an input to pick which sound card and which channels it uses (capture card, SSL, etc.).'),
      el('h3', null, 'Master volume'),
      el('div', { class: 'ch master-ch' }, el('span', { class: 'ch-mute ghost' }, ''), el('div', { class: 'ch-name' }, 'MASTER'), mFader, mDb, el('span')),
      el('div', { class: 'muted', style: 'font-size:.85em;margin-top:8px' }, 'Normally leave these at 0 and mix on your sound desk. LIMIT keeps peaks under −1 dB; AUTO −14 holds the overall loudness at YouTube’s level.'),
      el('div', { class: 'row', style: 'margin-top:14px' }, el('span', { class: 'grow' }), el('button', { class: 'btn primary', onclick: () => closeModal() }, 'Done')));
    openModal('Audio mixer & sound card', body);
  }
  function drawMaster(A) {
    if (!masterCanvas.isConnected) return;
    const fit = (c) => { const r = c.getBoundingClientRect(); const w = Math.max(10, Math.round(r.width * devicePixelRatio)), h = Math.max(10, Math.round(r.height * devicePixelRatio)); if (c.width !== w || c.height !== h) { c.width = w; c.height = h; } return c.getContext('2d'); };
    let g = fit(masterCanvas); const W = masterCanvas.width, H = masterCanvas.height, k = devicePixelRatio;
    g.clearRect(0, 0, W, H);
    const top = 20 * k, bot = 20 * k, mh = H - top - bot;
    const y = db => top + mh * (1 - Math.max(0, Math.min(1, (db + 60) / 60)));
    const scaleW = 24 * k, gap = 5 * k, bw = (W - scaleW - gap * 3) / 2;
    g.font = `${10 * k}px Inter, Segoe UI, sans-serif`; g.textAlign = 'right'; g.textBaseline = 'middle';
    for (const d of [0, -6, -12, -18, -24, -36, -48, -60]) { g.fillStyle = '#8d8d96'; g.fillText(String(d), scaleW - 4 * k, y(d)); g.fillStyle = '#2a2a2f'; g.fillRect(scaleW, y(d), W - scaleW, 1); }
    const bar = (i, peak, rms, hold, clip, label) => {
      const x = scaleW + gap + i * (bw + gap);
      g.fillStyle = '#0a0a0c'; g.fillRect(x, top, bw, mh);
      const grad = g.createLinearGradient(0, top + mh, 0, top);
      grad.addColorStop(0, '#15803d'); grad.addColorStop(0.7, '#22c55e'); grad.addColorStop(0.8, '#eab308'); grad.addColorStop(0.9, '#f97316'); grad.addColorStop(0.98, '#ef4444');
      g.fillStyle = grad; g.fillRect(x, y(peak), bw, top + mh - y(peak));
      g.fillStyle = 'rgba(255,255,255,.28)'; g.fillRect(x, y(rms), bw, top + mh - y(rms));
      g.fillStyle = hold > -3 ? '#ef4444' : '#f4f4f5'; g.fillRect(x, y(hold) - 1.5 * k, bw, 3 * k);
      g.fillStyle = clip ? '#ef4444' : '#2a1416'; g.fillRect(x, 2 * k, bw, 13 * k);
      g.fillStyle = clip ? '#fff' : '#6b3a3d'; g.textAlign = 'center'; g.font = `700 ${9 * k}px Inter, Segoe UI, sans-serif`; g.fillText('MAX', x + bw / 2, 9 * k);
      g.fillStyle = '#ececef'; g.font = `600 ${11 * k}px Consolas, monospace`; g.fillText(hold <= -60 ? '-∞' : hold.toFixed(1), x + bw / 2, H - 9 * k);
    };
    bar(0, A.peakL, A.rmsL, A.holdL, A.clipL, 'L');
    bar(1, A.peakR, A.rmsR, A.holdR, A.clipR, 'R');
    // YouTube's peak ceiling (−1 dB)
    g.strokeStyle = '#ef4444'; g.lineWidth = 1.5 * k; g.setLineDash([4 * k, 3 * k]); g.beginPath(); g.moveTo(scaleW, y(-1)); g.lineTo(W, y(-1)); g.stroke(); g.setLineDash([]);
    // phase correlation
    g = fit(corrCanvas); const cw = corrCanvas.width, ch = corrCanvas.height;
    g.clearRect(0, 0, cw, ch);
    g.fillStyle = '#0a0a0c'; g.fillRect(0, 0, cw, ch);
    const grd = g.createLinearGradient(0, 0, cw, 0); grd.addColorStop(0, '#7f1d1d'); grd.addColorStop(0.45, '#3f2a10'); grd.addColorStop(0.55, '#123018'); grd.addColorStop(1, '#14532d');
    g.fillStyle = grd; g.fillRect(0, ch * 0.3, cw, ch * 0.4);
    g.fillStyle = '#52525b'; g.fillRect(cw / 2, 0, 1, ch);
    g.fillStyle = A.silent ? '#52525b' : A.corr < -0.2 ? '#ef4444' : A.corr < 0.2 ? '#f59e0b' : '#22c55e';
    g.fillRect((A.corr + 1) / 2 * cw - 4 * k, 0, 8 * k, ch);
    // stereo picture: a vertical line = mono, wider = more stereo, sideways = out of phase
    g = fit(gonio); const gw = gonio.width, gh = gonio.height;
    g.fillStyle = 'rgba(10,10,12,.5)'; g.fillRect(0, 0, gw, gh);
    g.strokeStyle = '#2a2a2f'; g.lineWidth = 1; g.beginPath(); g.moveTo(gw / 2, 0); g.lineTo(gw / 2, gh); g.moveTo(0, gh / 2); g.lineTo(gw, gh / 2); g.moveTo(gw / 2 - gh / 2, 0); g.lineTo(gw / 2 + gh / 2, gh); g.moveTo(gw / 2 + gh / 2, 0); g.lineTo(gw / 2 - gh / 2, gh); g.stroke();
    g.fillStyle = A.corr < 0 ? 'rgba(239,68,68,.75)' : 'rgba(74,222,128,.75)';
    const sc = Math.min(gw, gh) * 0.62;
    for (let i = 0; i < A.L.length; i += 2) { const l = A.L[i], r = A.R[i]; g.fillRect(gw / 2 + (r - l) * 0.7071 * sc, gh / 2 - (l + r) * 0.7071 * sc, 1.5 * k, 1.5 * k); }
    // loudness against YouTube's −14 LUFS
    const lu = v => v <= -60 ? '—' : v.toFixed(1);
    const d = A.lufsS + 14;
    const cls = A.lufsS <= -60 ? '' : d > 2 ? 'bad' : d < -4 ? 'low' : 'ok';
    const hint = A.lufsS <= -60 ? 'no sound' : d > 2 ? `${d.toFixed(0)} dB louder than YouTube’s level — it will be turned down` : d < -4 ? `${(-d).toFixed(0)} dB quieter than YouTube’s level` : 'matches YouTube ✓';
    lufsBox.innerHTML = `<div><span class="mlabel">Loudness</span><span class="hint">target −14</span></div><div class="big ${cls}">${lu(A.lufsS)} <small>LUFS</small></div><div class="hint" style="margin:0">${hint}${rt.autoDb ? ` · auto ${rt.autoDb > 0 ? '+' : ''}${rt.autoDb.toFixed(1)} dB` : ''}</div>`;
  }
  // AUTO −14: slow automatic level toward YouTube's loudness (only while there is sound)
  setInterval(() => {
    const m = show.audio.master;
    if (!m.auto || !rt.MA) { if (rt.autoDb) { rt.autoDb = 0; mixer.setAuto(0); } return; }
    const l = rt.MA.lufsS;
    if (l < -45) return;
    rt.autoDb = clamp((rt.autoDb || 0) + clamp((-14 - l) * 0.06, -0.4, 0.4), -12, 12);
    mixer.setAuto(rt.autoDb);
  }, 500);

  /* ================= audio / video sync test ================= */
  async function openSyncTest() {
    const inputs = show.audio.inputs;
    if (!inputs.length || !show.cameras.length) { toast('Add a camera and an audio input first.', 'error'); return; }
    const st = { input: inputs[0].id, cam: inputs[0].syncCam || show.cameras[0].id, running: false, audio: [], video: [], result: null };
    const body = el('div');
    const view = el('canvas', { width: 320, height: 180, style: 'width:100%;aspect-ratio:16/9;background:#000;border-radius:8px;display:block' });
    const live = el('div', { class: 'sync-live' });
    const draw = () => {
      body.innerHTML = '';
      engine.sourceViews.set(view, st.cam);
      const inp = inputs.find(i => i.id === st.input);
      const r = st.result;
      put(body,
        el('div', { class: 'muted', style: 'margin-bottom:10px;line-height:1.5' },
          'This measures how far the sound and picture from your capture card are apart, and fixes it. ',
          el('b', null, 'Clap your hands sharply in front of the camera, about once a second'),
          ' (or play an “AV sync test” flash-and-beep video on a phone held up to the camera). Keep other sounds quiet.'),
        el('div', { class: 'grid2' },
          el('div', { class: 'field' }, el('span', null, 'Camera'), select(show.cameras.map(c => [c.id, c.name]), st.cam, v => { st.cam = v; draw(); })),
          el('div', { class: 'field' }, el('span', null, 'Audio input'), select(inputs.map(i => [i.id, i.name]), st.input, v => { st.input = v; draw(); }))),
        view, live,
        el('div', { class: 'row', style: 'margin-top:10px' },
          el('button', { class: 'btn primary big', disabled: st.running, onclick: run }, st.running ? 'Listening… keep clapping' : (r ? '↻ Test again' : '▶ Start test (12 seconds)')),
          el('span', { class: 'grow' }),
          el('span', { class: 'muted' }, `Current delay on “${inp.name}”: ${inp.delay || 0} ms`)),
        r ? el('div', { class: 'sync-result ' + (r.ok ? 'ok' : 'bad') }, ...resultView(r, inp)) : null);
    };
    const resultView = (r, inp) => {
      if (!r.ok) return [el('b', null, 'Not enough claps detected.'), el('div', null, r.msg)];
      const ms = Math.round(r.offset);
      const lines = [el('div', { class: 'big' }, Math.abs(ms) < 15 ? 'In sync ✓' : ms > 0 ? `Sound arrives ${ms} ms before the picture` : `Sound arrives ${-ms} ms after the picture`),
        el('div', { class: 'muted' }, `Measured ${r.pairs} claps · spread ±${Math.round(r.spread)} ms${r.spread > 40 ? ' (uneven — try again with sharper claps)' : ''}`)];
      if (ms >= 0) {
        const want = clamp(ms, 0, 2000);
        lines.push(el('div', { class: 'row', style: 'margin-top:10px' },
          el('button', { class: 'btn primary', onclick: () => { inp.delay = want; mixer.update(inp.id, inp); inp.syncCam = st.cam; changed(); refresh('audio'); toast(`Audio delay set to ${want} ms.`, 'ok'); draw(); } }, `Fix it — set audio delay to ${want} ms`),
          el('span', { class: 'muted' }, 'Then run the test again to confirm.')));
      } else {
        lines.push(el('div', { style: 'margin-top:8px' }, 'The sound is later than the picture, so delaying the sound won’t help. Check the audio delay setting on your sound desk or camera, and set this input’s delay to 0.'),
          el('button', { class: 'btn small', style: 'margin-top:6px', onclick: () => { inp.delay = 0; mixer.update(inp.id, inp); changed(); refresh('audio'); draw(); } }, 'Set delay to 0'));
      }
      return lines;
    };
    async function run() {
      const inp = inputs.find(i => i.id === st.input);
      const strip = mixer.strips.get(inp.id);
      const cam = rt.cams.get(st.cam);
      if (!strip || !cam) { toast('That camera or audio input is not connected.', 'error'); return; }
      mixer.resume();
      st.running = true; st.audio = []; st.video = []; st.result = null; draw();
      try { if (!rt.syncWorklet) { await mixer.ctx.audioWorklet.addModule('sync-worklet.js'); rt.syncWorklet = true; } }
      catch (e) { st.running = false; toast('Sync test could not start: ' + e.message, 'error'); draw(); return; }
      const node = new AudioWorkletNode(mixer.ctx, 'onset-detector');
      strip.raw.connect(node);
      const ctx = mixer.ctx;
      const toPerf = t => { const ts = ctx.getOutputTimestamp(); return ts.performanceTime + (t - ts.contextTime) * 1000 - ((ctx.outputLatency || 0) + (ctx.baseLatency || 0)) * 1000; };
      node.port.onmessage = e => { if (e.data.type === 'onset') { st.audio.push(toPerf(e.data.t)); updLive(); } };
      // picture: watch brightness and movement in a tiny copy of each new frame
      const v = cam.v, c = document.createElement('canvas'); c.width = 64; c.height = 36;
      const g = c.getContext('2d', { willReadFrequently: true });
      let prev = null, base = 0, lastEv = 0, active = true;
      const onFrame = (now, meta) => {
        if (!active) return;
        g.drawImage(v, 0, 0, 64, 36);
        const d = g.getImageData(0, 0, 64, 36).data;
        let lum = 0, diff = 0;
        const cur = new Uint8Array(64 * 36);
        for (let i = 0, j = 0; i < d.length; i += 4, j++) { const y = (d[i] * 54 + d[i + 1] * 183 + d[i + 2] * 19) >> 8; cur[j] = y; lum += y; if (prev) diff += Math.abs(y - prev[j]); }
        const sig = prev ? diff / cur.length : 0;
        const t = (meta && meta.captureTime) || now;
        if (prev && sig > Math.max(6, base * 4) && t - lastEv > 300) { lastEv = t; st.video.push(t); updLive(); }
        base += (sig - base) * 0.08;
        prev = cur;
        v.requestVideoFrameCallback(onFrame);
      };
      v.requestVideoFrameCallback(onFrame);
      const t0 = performance.now();
      const tick = setInterval(updLive, 200);
      function updLive() {
        const left = Math.max(0, 12 - (performance.now() - t0) / 1000);
        live.innerHTML = `<span>🔊 sounds heard: <b>${st.audio.length}</b></span><span>🎥 movements/flashes seen: <b>${st.video.length}</b></span><span>${st.running ? Math.ceil(left) + ' s left' : ''}</span>`;
      }
      await new Promise(r => setTimeout(r, 12000));
      active = false; clearInterval(tick);
      try { strip.raw.disconnect(node); } catch (e) { /* */ }
      node.port.onmessage = null;
      st.running = false;
      // pair every sound with the nearest movement
      const diffs = [];
      for (const a of st.audio) {
        let best = null;
        for (const w of st.video) { const dd = w - a; if (Math.abs(dd) < 600 && (best === null || Math.abs(dd) < Math.abs(best))) best = dd; }
        if (best !== null) diffs.push(best);
      }
      if (diffs.length < 3) st.result = { ok: false, msg: `Heard ${st.audio.length} sounds and saw ${st.video.length} movements, but only ${diffs.length} matched. Clap closer to the camera and microphone, with your hands clearly in view.` };
      else {
        diffs.sort((x, y) => x - y);
        const med = diffs[Math.floor(diffs.length / 2)];
        const near = diffs.filter(x => Math.abs(x - med) < 120);
        const mean = near.reduce((a, b) => a + b, 0) / near.length;
        const spread = Math.sqrt(near.reduce((a, b) => a + (b - mean) ** 2, 0) / near.length);
        st.result = { ok: near.length >= 3, offset: mean, spread, pairs: near.length, msg: 'The measurements didn’t agree. Try again with sharper claps.' };
      }
      updLive(); draw();
    }
    draw(); updLiveInit();
    function updLiveInit() { live.innerHTML = '<span class="muted">Press Start, then clap.</span>'; }
    openModal('Audio / video sync test', body);
  }

  function inputSettings(a) {
    const isNew = !a;
    const cfg = a ? clone(a) : { id: uid('in'), name: `Mic ${show.audio.inputs.length + 1}`, deviceId: (rt.devices.audio.find(d => /blackmagic|decklink/i.test(d.label)) || rt.devices.audio.find(d => /ssl/i.test(d.label)) || rt.devices.audio[0] || {}).id || '', channel: 'stereo', gain: 0, mute: false, delay: 0, lowcut: false, voice: false, pan: 0 };
    const devSel = select(rt.devices.audio.map(d => [d.id, d.label]), cfg.deviceId, v => { cfg.deviceId = v; });
    const chSel = select([['1', 'Input 1 (mono)'], ['2', 'Input 2 (mono)'], ['3', 'Input 3 (mono)'], ['4', 'Input 4 (mono)'], ['stereo', 'Inputs 1+2 as stereo'], ['mix', 'Inputs 1+2 mixed to mono']], cfg.channel, v => { cfg.channel = v; });
    const body = el('div', null,
      el('div', { class: 'field' }, el('span', null, 'Name'), el('input', { type: 'text', value: cfg.name, oninput: e => { cfg.name = e.target.value; } })),
      el('div', { class: 'grid2' },
        el('div', { class: 'field' }, el('span', null, 'Audio device'), devSel),
        el('div', { class: 'field' }, el('span', null, 'Which input'), chSel)),
      el('div', { class: 'muted', style: 'font-size:.85em;margin:-4px 0 12px' }, 'Capture card sound (from your sound desk into the camera/SDI): choose the Blackmagic audio device, inputs 1+2 as stereo. SSL interface: mic on input 1 or 2.'),
      el('div', { class: 'grid2' },
        el('div', { class: 'field' }, el('span', null, 'Audio delay (lip sync)'), el('div', { class: 'row' }, el('input', { type: 'number', min: 0, max: 2000, step: 5, value: cfg.delay, oninput: e => { cfg.delay = +e.target.value || 0; } }), 'ms', el('button', { class: 'btn small', onclick: () => { closeModal(); openSyncTest(); } }, '⏱ Measure…'))),
        el('div', { class: 'field' }, el('span', null, 'Pan'), el('input', { type: 'range', min: -1, max: 1, step: 0.05, value: cfg.pan, oninput: e => { cfg.pan = +e.target.value; } }))),
      el('div', { class: 'row wrap', style: 'gap:18px;margin-bottom:14px' },
        check(' Low-cut (removes rumble)', cfg.lowcut, v => { cfg.lowcut = v; }),
        check(' Voice leveler (gentle compression)', cfg.voice, v => { cfg.voice = v; })),
      el('div', { class: 'row' },
        isNew ? null : el('button', { class: 'btn danger', onclick: () => { mixer.removeInput(cfg.id); show.audio.inputs = show.audio.inputs.filter(x => x.id !== cfg.id); changed(); closeModal(); refresh('audio'); } }, 'Remove input'),
        el('span', { class: 'grow' }),
        el('button', { class: 'btn primary', onclick: async () => {
          rememberDevice(cfg, 'audio');
          if (isNew) show.audio.inputs.push(cfg); else Object.assign(a, cfg);
          const target = isNew ? cfg : a;
          changed(); closeModal();
          await openAudioInput(target, true);
          refresh('audio');
        } }, isNew ? 'Add input' : 'Save')));
    openModal(isNew ? 'Add audio input' : `Audio input — ${cfg.name}`, body);
  }
  async function openAudioInput(a, rebuild, attempt = 0) {
    clearTimeout(rt.audRetry.get(a.id));
    try {
      if (rebuild || !mixer.strips.has(a.id)) await mixer.addInput(a);
      else mixer.update(a.id, a);
      rt.audFail.delete(a.id);
      if (attempt) { toast(`${a.name}: sound card connected.`); refresh('audio'); }
    } catch (e) {
      // the card may not be ready yet right after start-up (or its id changed): look again and keep trying
      rt.audFail.set(a.id, e.message || e.name);
      if (attempt === 0) toast(`${a.name}: sound card not ready yet, retrying…`);
      if (attempt === 5) toast(`${a.name}: could not open the sound card (${e.message || e.name}). Still trying — check it is plugged in.`, 'error');
      rt.audRetry.set(a.id, setTimeout(async () => {
        if (!show.audio.inputs.includes(a)) return;
        await refreshDevices(); resolveDevices();
        if (attempt >= 2 && !a.deviceLabel && !rt.devices.audio.find(d => d.id === a.deviceId)) {
          // saved before names were remembered: fall back to the capture card (or the SSL)
          const g = rt.devices.audio.find(d => /blackmagic|decklink/i.test(d.label) && d.id !== 'default' && d.id !== 'communications') || rt.devices.audio.find(d => /ssl/i.test(d.label));
          if (g) { a.deviceId = g.id; rememberDevice(a, 'audio'); changed(); }
        }
        openAudioInput(a, true, attempt + 1);
      }, attempt < 5 ? 2000 : 6000));
      refresh('audio');
    }
  }
  function tickMeters() {
    const lv = mixer.levels();
    const MA = mixer.masterAnalysis(); rt.MA = MA;
    drawMaster(MA); drawMonMeter(MA);
    for (const [id, m] of rt.meters) {
      const db = lv[id];
      if (db === undefined) continue;
      m.i.style.clipPath = `inset(0 ${100 - clamp((db + 60) / 72, 0, 1) * 100}% 0 0)`; // same scale as the fader (−60 … +12 dB); colours stay fixed to the scale
    }
    // media progress on program monitor
    const s = getShot(engine.programId);
    const mid = s ? mediaOf(s)[0] : null;
    const f = mid && rt.files.get(mid);
    if (f && f.el && f.el.duration && !f.el.loop) {
      progInfo.classList.remove('hidden'); progBar.classList.remove('hidden');
      progInfo.textContent = `−${fmtShort(f.el.duration - f.el.currentTime)}`;
      progBar.firstChild.style.width = `${(f.el.currentTime / f.el.duration) * 100}%`;
    } else { progInfo.classList.add('hidden'); progBar.classList.add('hidden'); }
    requestAnimationFrame(tickMeters);
  }

  /* ================= panel: inputs ================= */
  function viewFor(id) {
    let c = rt.views.get(id);
    if (!c) { c = el('canvas', { width: 320, height: 180 }); rt.views.set(id, c); }
    engine.sourceViews.set(c, id);
    return c;
  }
  function refreshInputStatus() {
    document.querySelectorAll('[data-cam-status]').forEach(n => {
      const st = rt.camStatus.get(n.dataset.camStatus) || { ok: false, text: '' };
      n.textContent = st.text; n.className = st.ok ? 'status-ok' : 'status-bad';
    });
  }
  RENDER.inputs = body => {
    body.innerHTML = '';
    put(body, el('div', { class: 'section', style: 'border:0;margin:0;padding:0' }, el('h4', null, 'Cameras & capture cards')));
    if (!show.cameras.length) put(body, el('div', { class: 'empty' }, 'No cameras yet. Connect your Blackmagic card, then click “Add camera”.'));
    for (const cam of show.cameras) {
      const devOpts = [['', '— choose device —'], ...rt.devices.video.map(d => [d.id, d.label])];
      put(body, el('div', { class: 'input-card' }, viewFor(cam.id),
        el('div', null,
          el('div', { class: 'row' }, el('input', { type: 'text', class: 'grow', value: cam.name, oninput: e => { cam.name = e.target.value; changed(); } }),
            el('button', { class: 'btn small danger', title: 'Remove camera', onclick: () => { closeCamera(cam.id); show.cameras = show.cameras.filter(c => c !== cam); changed(); refreshAll(); } }, '✕')),
          el('div', { class: 'row', style: 'margin-top:6px' },
            select(devOpts, cam.deviceId, v => { cam.deviceId = v; delete cam.fps; rememberDevice(cam, 'video'); changed(); openCamera(cam); }, { class: 'grow' }),
            select([['720', '720p'], ['1080', '1080p'], ['2160', '4K']], cam.res || '1080', v => { cam.res = v; changed(); openCamera(cam); }),
            select([['', 'Auto fps'], ['23.98', '23.98'], ['24', '24'], ['25', '25'], ['29.97', '29.97'], ['30', '30'], ['50', '50'], ['59.94', '59.94'], ['60', '60']], cam.fps || '', v => { cam.fps = v; changed(); openCamera(cam); }, { title: 'Must match the signal your camera sends' })),
          el('div', { style: 'font-size:.85em;margin-top:5px' }, el('span', { dataset: { camStatus: cam.id } })))));
    }
    put(body, el('div', { class: 'row', style: 'margin-bottom:14px' },
      el('button', { class: 'btn', onclick: addCamera }, '+ Add camera'),
      el('button', { class: 'btn ghost small', onclick: async () => { await refreshDevices(); refresh('inputs'); toast(`Found ${rt.devices.video.length} video and ${rt.devices.audio.length} audio devices.`); } }, '↻ Rescan devices')));

    put(body, el('div', { class: 'section' }, el('h4', null, 'Video & image files')));
    if (!show.files.length) put(body, el('div', { class: 'empty' }, 'Add intro/ending videos, background loops or logos.'));
    for (const f of show.files) {
      const st = rt.files.get(f.id) || { ok: false, text: '' };
      put(body, el('div', { class: 'input-card' }, viewFor(f.id),
        el('div', null,
          el('div', { class: 'row' }, el('input', { type: 'text', class: 'grow', value: f.name, oninput: e => { f.name = e.target.value; changed(); } }),
            el('button', { class: 'btn small danger', title: 'Remove file', onclick: () => removeFile(f) }, '✕')),
          fileStatus(f.id),
          f.kind === 'video' ? el('div', { style: 'margin-top:5px' }, check(' Loop', f.loop, v => { f.loop = v; const m = rt.files.get(f.id); if (m && m.el) m.el.loop = v; changed(); })) : null,
          !st.ok ? el('button', { class: 'btn small', style: 'margin-top:5px', onclick: () => loadFile(f) }, 'Try again') : null)));
    }
    put(body, el('button', { class: 'btn', onclick: addFiles }, '+ Add video / image'));
    refreshInputStatus();
  };
  function addCamera() {
    const used = new Set(show.cameras.map(c => c.deviceId));
    const dev = rt.devices.video.find(d => !used.has(d.id));
    const cam = { id: uid('cam'), name: `Camera ${show.cameras.length + 1}`, deviceId: dev ? dev.id : '', deviceLabel: dev ? dev.label : '', res: '1080', color: clone(NEUTRAL) };
    show.cameras.push(cam); changed();
    openCamera(cam).then(() => refreshAll());
    refreshAll();
  }
  function removeFile(f) {
    const inUse = show.shots.filter(s => s.main.source === f.id || (s.pip.enabled && s.pip.source === f.id));
    if (inUse.some(s => s.id === engine.programId)) { toast('This file is on air — switch away first.', 'error'); return; }
    unloadFile(f.id);
    show.files = show.files.filter(x => x !== f);
    if (SV().start.videoId === f.id) SV().start.videoId = '';
    if (SV().end.videoId === f.id) SV().end.videoId = '';
    if (SV().hold.bgFile === f.id) SV().hold.bgFile = '';
    show.pics.forEach(p2 => { if (p2.fileId === f.id) { p2.fileId = ''; engine.removeWeb(p2.id); } });
    syncRoleShots();
    changed(); refreshAll();
  }

  /* ================= settings ================= */
  function openModal(title, body) { $('#modalTitle').textContent = title; const b = $('#modalBody'); b.innerHTML = ''; b.append(body); $('#modal').classList.remove('hidden'); }
  let closeModal = () => { $('#modal').classList.add('hidden'); };
  $('#modalClose').addEventListener('click', () => closeModal());
  $('#modal').addEventListener('pointerdown', e => { if (e.target.id === 'modal') closeModal(); });

  async function openSettings(focus) {
    const s = settings, o = s.output, y = s.youtube;
    const live = !!(rt.live || rt.rec);
    const keyInput = el('input', { type: 'password', value: y.key, placeholder: 'Paste your stream key', class: 'grow', autocomplete: 'off', oninput: e => { y.key = e.target.value.trim(); saveSettings(); } });
    const customRow = el('div', { class: 'field' + (y.server === 'custom' ? '' : ' hidden') }, el('span', null, 'Server address (RTMP/RTMPS)'), el('input', { type: 'text', value: y.custom, placeholder: 'rtmps://…', oninput: e => { y.custom = e.target.value; saveSettings(); } }));
    const version = await S.version();
    const updStatus = el('span', { class: 'muted' });
    const changeOut = (k, v) => {
      if (live) { toast('Stop streaming/recording before changing video output settings.', 'error'); return; }
      o[k] = v; saveSettings();
      if (k === 'width' || k === 'height' || k === 'fps') {
        engine.setSize(o.width, o.height); engine.setFps(o.fps);
        engine.setSource('bars', makeBars(o.width, o.height), 'image');
        previewCanvas.height = Math.round(previewCanvas.width * o.height / o.width);
      }
    };
    /* picture + sound bitrate with ready-made and your own presets, separately for live and recording */
    const QUAL = {
      live: { v: 'bitrate', a: 'audioBitrate', vr: [1000, 51000], ar: [64, 384], builtin: [['YouTube 1080p 60 fps', 12000, 192], ['YouTube 1080p 30 fps', 8000, 160], ['YouTube 720p', 5000, 128], ['Slow internet', 3000, 128]] },
      rec: { v: 'recordBitrate', a: 'recordAudioBitrate', vr: [4000, 100000], ar: [96, 512], builtin: [['Standard', 20000, 256], ['High (for editing)', 40000, 320], ['Small files', 10000, 192]] }
    };
    function qualityBlock(kind) {
      const Q = QUAL[kind], wrap = el('div');
      s.presets = s.presets || { live: [], rec: [] };
      const draw = () => {
        const mine = s.presets[kind] || (s.presets[kind] = []);
        const all = [...Q.builtin.map(b => ({ name: b[0], v: b[1], a: b[2] })), ...mine.map(m => ({ ...m, mine: true }))];
        const cur = all.findIndex(x => x.v === o[Q.v] && x.a === o[Q.a]);
        const set = (v, a) => { o[Q.v] = clamp(Math.round(v) || Q.vr[0], Q.vr[0], Q.vr[1]); o[Q.a] = clamp(Math.round(a) || Q.ar[0], Q.ar[0], Q.ar[1]); saveSettings(); draw(); };
        const nameIn = el('input', { type: 'text', placeholder: 'Name for a new preset', style: 'flex:1;min-width:120px' });
        wrap.innerHTML = '';
        put(wrap,
          el('div', { class: 'grid2' },
            el('div', { class: 'field' }, el('span', null, 'Preset'), select([...all.map((x, i) => [i, `${x.mine ? '★ ' : ''}${x.name} — ${x.v.toLocaleString()} / ${x.a} kbps`]), ...(cur < 0 ? [[-1, 'Custom (not saved)']] : [])], cur, v => { const x = all[+v]; if (x) set(x.v, x.a); })),
            el('div', { class: 'row', style: 'gap:10px;align-items:flex-end' },
              el('div', { class: 'field grow' }, el('span', null, 'Picture (kbps)'), el('input', { type: 'number', min: Q.vr[0], max: Q.vr[1], step: 100, value: o[Q.v], disabled: live || null, onchange: e => set(+e.target.value, o[Q.a]) })),
              el('div', { class: 'field grow' }, el('span', null, 'Sound (kbps)'), el('input', { type: 'number', min: Q.ar[0], max: Q.ar[1], step: 1, value: o[Q.a], disabled: live || null, onchange: e => set(o[Q.v], +e.target.value) })))),
          el('div', { class: 'row wrap', style: 'gap:8px;margin:-4px 0 10px' }, nameIn,
            el('button', { class: 'btn small', onclick: () => { const n = nameIn.value.trim(); if (!n) { toast('Type a name for the preset first.', 'error'); return; } const i = mine.findIndex(m => m.name === n); const pr = { name: n, v: o[Q.v], a: o[Q.a] }; if (i >= 0) mine[i] = pr; else mine.push(pr); saveSettings(); draw(); toast(`Preset “${n}” saved.`); } }, '★ Save these numbers as a preset'),
            cur >= 0 && all[cur].mine ? el('button', { class: 'btn small danger', onclick: () => { s.presets[kind] = mine.filter(m => m.name !== all[cur].name); saveSettings(); draw(); } }, 'Delete this preset') : null));
        if (live) wrap.querySelectorAll('select').forEach(x => { x.disabled = true; });
      };
      draw();
      return wrap;
    }
    const body = el('div', null,
      el('h3', { id: 'set-youtube' }, 'YouTube'),
      el('div', { class: 'row', style: 'margin-bottom:10px' }, el('span', { class: 'muted grow' }, rt.yt.signedIn ? `Connected${rt.yt.channel ? ' to ' + rt.yt.channel.title : ''}. Choosing an event fills in the stream key.` : 'Connect your YouTube account to pick upcoming events and check stream health — or just paste a stream key below.'),
        el('button', { class: 'btn primary', onclick: () => { closeModal(); openYouTube(); } }, rt.yt.signedIn ? 'YouTube events…' : 'Connect YouTube…')),
      el('div', { class: 'field' }, el('span', null, 'Server'), select([['rtmps://a.rtmps.youtube.com:443/live2', 'YouTube — primary (secure RTMPS, recommended)'], ['rtmp://a.rtmp.youtube.com/live2', 'YouTube — primary (RTMP)'], ['custom', 'Custom server (Facebook, Vimeo, other)…']], y.server, v => { y.server = v; customRow.classList.toggle('hidden', v !== 'custom'); saveSettings(); })),
      customRow,
      el('div', { class: 'field' }, el('span', null, 'Stream key'), el('div', { class: 'row' }, keyInput, el('button', { class: 'btn small', onclick: e => { keyInput.type = keyInput.type === 'password' ? 'text' : 'password'; e.target.textContent = keyInput.type === 'password' ? 'Show' : 'Hide'; } }, 'Show'))),
      el('div', { class: 'muted', style: 'font-size:.85em' }, 'Find it in YouTube Studio → Create → Go live → Stream → “Stream key”. Keep it private — it is stored encrypted on this computer.'),

      el('h3', null, 'Video output'),
      live ? el('div', { class: 'status-bad', style: 'margin-bottom:8px' }, 'Locked while live or recording.') : null,
      el('div', { class: 'grid2' },
        el('div', { class: 'field' }, el('span', null, 'Resolution'), select([['1920x1080', '1080p (1920×1080)'], ['1280x720', '720p (1280×720)']], `${o.width}x${o.height}`, v => { const [w, h] = v.split('x').map(Number); changeOut('width', w); changeOut('height', h); })),
        el('div', { class: 'field' }, el('span', null, 'Frame rate'), select([[25, '25 fps'], [30, '30 fps (29.97 cameras)'], [50, '50 fps'], [60, '60 fps (59.94 cameras)']], o.fps, v => changeOut('fps', +v))),
        el('div', { class: 'field' }, el('span', null, 'Encoder'), select([['x264', 'Software (works on every PC)'], ['nvenc', 'NVIDIA graphics card (NVENC)'], ['qsv', 'Intel graphics (Quick Sync)'], ['amf', 'AMD graphics card (AMF)']], o.encoder, v => changeOut('encoder', v)))),
      el('div', { class: 'muted', style: 'font-size:.85em' }, 'Tip: use a hardware encoder if your PC has one — it leaves the processor free.'),
      rt.encFallback && rt.encFallback.for === o.encoder ? el('div', { class: 'status-bad', style: 'font-size:.9em;margin-top:6px' }, rt.encFallback.level >= 2 ? `This encoder would not start, so the software encoder is being used until the program is restarted. Updating the graphics card driver usually fixes it. Reported: ${rt.encFallback.detail || 'no details'}` : 'This encoder refused the tuned settings; plain settings are being used.') : null,
      el('h3', null, 'Live stream quality'),
      qualityBlock('live'),
      el('div', { class: 'muted', style: 'font-size:.85em' }, 'YouTube suggests 4,500–9,000 kbps for 1080p at 30 fps and about 12,000 for 1080p at 60 fps. Your upload speed should be about 1.5× the picture bitrate.'),

      el('h3', null, 'Recording'),
      el('div', { class: 'field' }, el('span', null, 'Save recordings to'), el('div', { class: 'row' }, el('input', { type: 'text', class: 'grow', value: s.recordDir, readonly: true, id: 'recDir' }),
        el('button', { class: 'btn small', onclick: async () => { const p = await S.pickFolder(); if (p) { s.recordDir = p; $('#recDir').value = p; saveSettings(); } } }, 'Change…'),
        el('button', { class: 'btn small', onclick: () => S.openFolder(s.recordDir) }, 'Open'))),
      el('div', { class: 'grid2' },
        el('div', { class: 'field' }, check(' Start recording automatically when I go live', s.autoRecord, v => { s.autoRecord = v; saveSettings(); }))),
      el('h4', { style: 'margin:6px 0' }, 'Recording quality'),
      qualityBlock('rec'),

      el('h3', null, 'Switching'),
      el('div', { class: 'grid2' },
        el('div', null, slider({ label: 'Frame move speed', min: 0.02, max: 0.5, step: 0.01, value: s.moveSpeed, reset: 0.12, fmt: v => v < 0.08 ? 'slow' : v < 0.2 ? 'medium' : 'fast', onInput: v => { s.moveSpeed = v; engine.moveSpeed = v; saveSettings(); } })),
        el('div', null, check(' Fade to black also fades the audio', s.ftbAudio, v => { s.ftbAudio = v; saveSettings(); }))),

      el('h3', null, 'Interface'),
      el('div', { class: 'grid2' },
        el('div', null, slider({ label: 'Text size', min: 0.85, max: 1.5, step: 0.05, value: s.ui.scale, reset: 1, fmt: v => `${Math.round(v * 100)}%`, onInput: v => { s.ui.scale = v; applyUI(); saveSettings(); } })),
        el('div', null, slider({ label: 'Shot button size', min: 0.7, max: 1.8, step: 0.05, value: s.ui.card, reset: 1, fmt: v => `${Math.round(v * 100)}%`, onInput: v => { s.ui.card = v; applyUI(); saveSettings(); } }))),
      el('div', { class: 'row' }, el('span', null, 'Accent colour'), el('input', { type: 'color', value: s.ui.accent, oninput: e => { s.ui.accent = e.target.value; applyUI(); saveSettings(); } }),
        el('span', { class: 'grow' }), el('button', { class: 'btn small', onclick: () => { closeModal(); setEditing(true); } }, 'Arrange panels…')),

      el('h3', null, 'Show file'),
      el('div', { class: 'muted', style: 'font-size:.85em;margin-bottom:8px' }, 'A show keeps your cameras, shots, labels, intro/ending and audio setup. It saves automatically; save copies for different events.'),
      el('div', { class: 'row wrap' },
        el('button', { class: 'btn', onclick: () => S.exportShow(show) }, 'Save show as…'),
        el('button', { class: 'btn', onclick: async () => { const o2 = await S.importShow(); if (o2) { await loadShowObject(o2); closeModal(); toast('Show opened.', 'ok'); } } }, 'Open show…'),
        el('button', { class: 'btn danger', onclick: async () => { if (rt.live) return toast('End the stream first.', 'error'); await loadShowObject(defaultShow()); closeModal(); } }, 'New empty show')),

      el('h3', { id: 'set-keys' }, 'Keyboard shortcuts'),
      el('div', { class: 'row' }, el('span', { class: 'muted grow' }, 'Choose your own key for every action, shot, label and speaker. F11 = full screen.'),
        el('button', { class: 'btn', onclick: openShortcuts }, '⌨ Edit keyboard shortcuts…')),

      el('h3', null, 'About'),
      el('div', { class: 'row' }, el('span', null, `Live Studio ${version}`), el('span', { class: 'grow' }), updStatus,
        el('button', { class: 'btn small', onclick: async () => { const r = await S.checkUpdates(); updStatus.textContent = r.status === 'dev' ? 'Updates work in the installed app.' : r.status === 'error' ? `Update check failed: ${r.message}` : 'Checking…'; } }, 'Check for updates'))
    );
    openModal('Settings', body);
    if (focus) { const t = $(`#set-${focus}`); if (t) t.scrollIntoView(); setTimeout(() => keyInput.focus(), 50); }
  }

  async function loadShowObject(obj) {
    for (const id of [...rt.cams.keys()]) closeCamera(id);
    for (const id of [...rt.files.keys()]) unloadFile(id);
    for (const a of show.audio.inputs) mixer.removeInput(a.id);
    for (const L of show.labels) engine.removeLabel(L.id);
    for (const w of show.webs) closeWeb(w.id);
    for (const p2 of show.pics) engine.removeWeb(p2.id);
    rt.webManual.clear(); rt.webSuppress.clear();
    show = merge(defaultShow(), obj);
    show.firstRunDone = true;
    changed();
    showNameInput.value = show.showName;
    await bootShow();
  }

  /* ================= updates ================= */
  S.onUpdate(u => {
    const bar = $('#updateBar');
    if (u.status === 'ready') {
      bar.innerHTML = '';
      bar.append(el('span', null, `Update ${u.version} is ready.`), el('button', { class: 'btn small primary', onclick: () => { if (rt.live || rt.rec) return toast('Finish streaming/recording first, then restart to update.', 'error'); S.installUpdate(); } }, 'Restart & update'), el('span', { class: 'muted' }, 'It will also install automatically next time you close the app.'));
      bar.classList.remove('hidden');
    } else if (u.status === 'downloading' && u.percent !== undefined) {
      bar.innerHTML = ''; bar.append(el('span', null, `Downloading update… ${u.percent}%`)); bar.classList.remove('hidden');
    }
  });

  /* ================= keyboard shortcuts — every action can have a key you choose ================= */
  const RESERVED = new Set(['F11', 'F12', 'Tab', 'Escape']);
  function actions() {
    const list = [];
    const A = (id, group, label, def, run) => list.push({ id, group, label, def: def || '', run });
    A('take', 'Switching', 'Take — fade Preview to air', 'Ctrl+KeyG', () => take('auto'));
    A('cut', 'Switching', 'Cut — instant switch', 'Ctrl+KeyC', () => take('cut'));
    A('ftb', 'Switching', 'Fade to black / back', 'KeyB', () => setBlack(!engine.isBlack));
    A('nextShot', 'Switching', 'Next shot into Preview', 'ArrowRight', () => stepPreview(1));
    A('prevShot', 'Switching', 'Previous shot into Preview', 'ArrowLeft', () => stepPreview(-1));
    A('startService', 'Service', 'START SERVICE', 'Ctrl+KeyS', startService);
    A('endService', 'Service', 'END SERVICE', 'Ctrl+KeyE', endService);
    A('hold', 'Service', 'Show the holding screen (clock)', '', showHold); // no default key, so it can't be hit by accident mid-service
    show.pics.forEach(p2 => A('pic:' + p2.id, 'Pictures — logo / decorations (show / hide)', p2.name || 'Picture', '', () => togglePic(p2.id)));
    show.webs.forEach(w => A('web:' + w.id, 'Web page overlays (show / hide)', w.name || 'Web page', '', () => toggleWeb(w.id)));
    A('hideAll', 'Labels & speakers', 'Hide all labels and name captions', 'KeyH', hideAllGraphics);
    show.speakers.forEach((p, i) => A('spk:' + p.id, 'Speakers (show / hide name caption)', `${p.name}${p.title ? ' — ' + p.title : ''}`, i < 9 ? `Alt+Digit${i + 1}` : '', () => toggleSpeaker(p.id)));
    show.labels.forEach((L, i) => A('lbl:' + L.id, 'Labels (show / hide)', L.title || 'Label', i < 8 ? `F${i + 1}` : '', () => toggleLabel(L.id)));
    const visShots = show.shots.filter(x => !shotHidden(x)); // number keys follow the order you see
    visShots.forEach((sh, i) => A('shot:' + sh.id, 'Shots — put in Preview', sh.name, i < 9 ? `Digit${i + 1}` : '', () => { setPreview(sh.id); editShot(sh.id, true); }));
    visShots.forEach((sh, i) => A('air:' + sh.id, 'Shots — straight to air', sh.name, i < 9 ? `Shift+Digit${i + 1}` : '', () => takeShot(sh.id, 'auto')));
    A('goLive', 'Streaming', 'Go live', '', () => { if (!rt.live) goLive(); });
    A('endLive', 'Streaming', 'End stream (press twice)', '', () => { if (rt.live) $('#btnLive').click(); });
    A('rec', 'Streaming', 'Start / stop recording (stop: press twice)', '', () => $('#btnRec').click());
    return list;
  }
  function keymap() {
    const list = actions(), ov = settings.hotkeys || {};
    const byCombo = new Map(), byId = new Map();
    for (const a of list) if (ov[a.id] === undefined && a.def) byCombo.set(a.def, a);
    for (const a of list) if (ov[a.id]) byCombo.set(ov[a.id], a); // your own keys win over defaults
    for (const [c, a] of byCombo) byId.set(a.id, c);
    return { list, byCombo, byId };
  }
  function comboFromEvent(e) {
    if (['ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight'].includes(e.code) || !e.code) return '';
    const m = [];
    if (e.ctrlKey) m.push('Ctrl');
    if (e.altKey) m.push('Alt');
    if (e.shiftKey) m.push('Shift');
    if (e.metaKey) m.push('Win');
    return [...m, e.code].join('+');
  }
  const KEYNAMES = { Space: 'Space', Enter: 'Enter', NumpadEnter: 'Num Enter', ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓', Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Backspace: 'Backspace', Delete: 'Del', Insert: 'Ins', Home: 'Home', End: 'End', PageUp: 'PgUp', PageDown: 'PgDn', NumpadAdd: 'Num +', NumpadSubtract: 'Num -', NumpadMultiply: 'Num *', NumpadDivide: 'Num /', NumpadDecimal: 'Num .' };
  function keyName(combo) {
    if (!combo) return '';
    return combo.split('+').map(p => KEYNAMES[p] || p.replace(/^Key/, '').replace(/^Digit/, '').replace(/^Numpad(\d)$/, 'Num $1')).join(' + ');
  }
  function keyChip(id) {
    const c = keymap().byId.get(id);
    return c ? el('kbd', { class: 'keychip', title: 'Keyboard shortcut' }, keyName(c)) : null;
  }
  function stepPreview(d) {
    const list = show.shots.filter(x => !shotHidden(x));
    if (!list.length) return;
    const i = list.findIndex(x => x.id === rt.previewId);
    const n = list[(i + d + list.length) % list.length];
    setPreview(n.id); editShot(n.id, true);
  }
  function assignKey(id, combo) {
    const km = keymap();
    const other = km.byCombo.get(combo);
    if (other && other.id !== id) { settings.hotkeys[other.id] = ''; toast(`${keyName(combo)} was moved from “${other.label}”.`); }
    settings.hotkeys[id] = combo;
    saveSettings();
  }

  function openShortcuts() {
    const body = el('div');
    const draw = () => {
      body.innerHTML = '';
      const km = keymap(), ov = settings.hotkeys;
      put(body,
        el('div', { class: 'muted', style: 'margin-bottom:12px' }, 'Click “Change”, then press the key you want (you can hold Ctrl, Alt or Shift too). Works with USB keypads and Stream Deck buttons set to send a key.'),
        el('div', { class: 'row', style: 'margin-bottom:6px' }, el('span', { class: 'grow' }), el('button', { class: 'btn small danger', onclick: () => { settings.hotkeys = {}; saveSettings(); draw(); refreshAll(); } }, 'Reset all to defaults')));
      let group = '';
      for (const a of km.list) {
        if (a.group !== group) { group = a.group; body.append(el('h3', null, group)); }
        const combo = km.byId.get(a.id);
        const capturing = rt.capture === a.id;
        const custom = ov[a.id] !== undefined && ov[a.id] !== a.def;
        body.append(el('div', { class: 'key-row' + (capturing ? ' capturing' : '') },
          el('span', { class: 'grow' }, a.label),
          capturing ? el('kbd', { class: 'keychip big wait' }, 'Press a key… (Esc to cancel)') : (combo ? el('kbd', { class: 'keychip big' }, keyName(combo)) : el('span', { class: 'muted' }, 'none')),
          el('button', { class: 'btn small', onclick: () => { rt.capture = a.id; draw(); } }, 'Change'),
          el('button', { class: 'btn small', title: 'No key', disabled: !combo, onclick: () => { settings.hotkeys[a.id] = ''; saveSettings(); draw(); refreshAll(); } }, '✕'),
          el('button', { class: 'btn small', title: 'Back to default', disabled: !custom, onclick: () => { delete settings.hotkeys[a.id]; saveSettings(); draw(); refreshAll(); } }, '↺')));
      }
    };
    rt.redrawShortcuts = draw;
    draw();
    openModal('Keyboard shortcuts', body);
  }
  // capture a new key while the shortcut editor is waiting
  document.addEventListener('keydown', e => {
    if (!rt.capture) return;
    e.preventDefault(); e.stopImmediatePropagation();
    const id = rt.capture;
    if (e.code === 'Escape') { rt.capture = null; rt.redrawShortcuts && rt.redrawShortcuts(); return; }
    const combo = comboFromEvent(e);
    if (!combo) return; // waiting for the actual key after a modifier
    if (RESERVED.has(e.code)) { toast(`${keyName(e.code)} is used by the app itself — pick another key.`, 'error'); return; }
    rt.capture = null;
    assignKey(id, combo);
    rt.redrawShortcuts && rt.redrawShortcuts();
    refreshAll();
  }, true);
  const _closeModal = closeModal;
  closeModal = () => { rt.capture = null; _closeModal(); };

  document.addEventListener('keydown', e => {
    if (rt.capture) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' && t.type !== 'range' && t.type !== 'checkbox' && t.type !== 'radio' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) { if (e.key === 'Escape') t.blur(); return; }
    if (!$('#modal').classList.contains('hidden')) { if (e.key === 'Escape') closeModal(); return; }
    if (e.repeat) { if (comboFromEvent(e) && keymap().byCombo.has(comboFromEvent(e))) e.preventDefault(); return; }
    const combo = comboFromEvent(e);
    const a = combo && keymap().byCombo.get(combo);
    if (a) { e.preventDefault(); a.run(); return; }
    if (e.key === 'Escape' && rt.editing) setEditing(false);
  });
  // buttons shouldn't keep keyboard focus (so Space/Enter always mean Take/Cut)
  document.addEventListener('mouseup', e => { const b = e.target.closest && e.target.closest('button'); if (b) setTimeout(() => b.blur(), 0); });

  /* ================= audio wake-up (browsers need a click before sound) ================= */
  const wake = $('#audioWake');
  const checkWake = () => wake.classList.toggle('hidden', !mixer.suspended);
  document.addEventListener('pointerdown', () => { mixer.resume(); setTimeout(checkWake, 100); }, true);
  mixer.ctx.addEventListener('statechange', checkWake);

  /* ================= start-up ================= */
  async function firstRun() {
    // automatically set up Blackmagic inputs and an SSL interface the first time
    const bm = rt.devices.video.filter(d => /blackmagic|decklink|intensity|ultrastudio/i.test(d.label));
    const cams = (bm.length ? bm : rt.devices.video.slice(0, 1));
    cams.forEach((d, i) => show.cameras.push({ id: uid('cam'), name: `Camera ${i + 1}`, deviceId: d.id, deviceLabel: d.label, res: '1080', color: clone(NEUTRAL) }));
    const camShots = [];
    show.cameras.forEach((c, i) => {
      camShots.push(newShot(`${c.name} — wide`, c.id, SHOT_COLORS[(i * 2 + 1) % SHOT_COLORS.length]));
      const close = newShot(`${c.name} — close`, c.id, SHOT_COLORS[(i * 2 + 2) % SHOT_COLORS.length]);
      close.main.frame = { zoom: 2, x: 0.5, y: 0.4 };
      camShots.push(close);
    });
    show.shots = [...camShots, ...show.shots];
    // audio normally comes from the capture card (sound mixed in with the camera signal); an SSL interface is the fallback
    const card = rt.devices.audio.find(d => /blackmagic|decklink|intensity|ultrastudio/i.test(d.label));
    const ssl = rt.devices.audio.find(d => /ssl/i.test(d.label));
    const dev = card || ssl || rt.devices.audio.find(d => d.id === 'default') || rt.devices.audio[0];
    if (dev) show.audio.inputs.push({ id: uid('in'), name: card ? 'Capture card' : ssl ? 'SSL' : 'Audio in', deviceId: dev.id, channel: 'stereo', gain: 0, mute: false, delay: 0, lowcut: false, voice: false, pan: 0, syncCam: show.cameras[0] ? show.cameras[0].id : '' });
    show.cameras.forEach(c => rememberDevice(c, 'video')); show.audio.inputs.forEach(a => rememberDevice(a, 'audio'));
    show.firstRunDone = true;
    changed();
  }
  async function bootShow() {
    if (!show.firstRunDone) await firstRun();
    show.labels.forEach(l => engine.setLabel(l, false));
    // older shows: carry the before-service / ending video over to Start / End Service
    if (show.intro && show.intro.fileId && !SV().start.videoId) SV().start.videoId = show.intro.fileId;
    if (show.ending && show.ending.fileId && !SV().end.videoId) SV().end.videoId = show.ending.fileId;
    delete show.intro; delete show.ending; delete show.autoIntro;
    { const h = SV().hold; if (h.zoom === 1.12 && h.focusX === 0.3) { h.zoom = 1.06; h.focusX = 0.4; } } // 1.3.3 framing → new default
    syncRoleShots();
    drawHold();
    engine.cut('shot_hold');
    rt.service = 'hold';
    audioGate(50, 'shot_hold');
    const prev = getShot(SV().start.cameraShot) || show.shots.find(x => !x.role) || show.shots[0];
    setPreview(prev ? prev.id : null);
    rt.editingId = prev ? prev.id : null;
    renderGrid();
    resolveDevices();
    await Promise.all([
      ...show.cameras.map(c => openCamera(c)),
      ...show.files.map(f => loadFile(f)),
      ...show.webs.map(w => openWeb(w)),
      (async () => { for (const p2 of show.pics) if (p2.on) rt.webManual.add(p2.id); })()
    ]);
    // sound cards after the cameras: a capture card can refuse audio while its video is still starting
    await refreshDevices(); resolveDevices();
    await Promise.all(show.audio.inputs.map(a => openAudioInput(a, true)));
    refreshAll();
    setTimeout(resetFrameStats, 8000); // starting up (opening cards, loading videos) is not counted as dropped frames
  }

  applyUI();
  await refreshDevices();
  engine.start();
  requestAnimationFrame(tickMeters);
  await bootShow();
  renderHeader();
  checkWake();
  if (S.pcStats) { const poll = () => S.pcStats().then(p2 => { rt.pc = p2; }).catch(() => {}); poll(); setInterval(poll, 3000); }
  setTimeout(resetFrameStats, 4000); // don't count the start-up hiccups
  ytInit().catch(e => console.warn('youtube', e));
  window.__live = { engine, mixer, get show() { return show; }, settings, rt, take, takeShot, setPreview, startService, endService, showHold, toggleLabel, setBlack };
})();
