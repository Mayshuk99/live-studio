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
    monitors: { title: 'Video', hint: 'left = next · right = on air' },
    audio: { title: 'Audio', hint: 'what the stream hears' },
    shots: { title: 'Shots', hint: 'click = next · double-click = on air' },
    media: { title: 'Before Service & Ending' },
    speakers: { title: 'Speaker Names', hint: 'click a name to show it' },
    labels: { title: 'Labels' },
    inputs: { title: 'Cameras & Files' },
    editor: { title: 'Shot Framing', hint: 'zoom and move the picture' },
    color: { title: 'Color & Exposure' }
  };
  // Two screens: "Run Show" has only what you touch during a service; "Setup" has the things you prepare beforehand.
  const LAYOUTS = {
    live: [['monitors', 8, 4], ['audio', 4, 4], ['shots', 8, 3], ['media', 4, 6], ['speakers', 4, 3], ['labels', 4, 3]],
    setup: [['monitors', 8, 4], ['audio', 4, 4], ['inputs', 4, 6], ['editor', 4, 6], ['color', 4, 6]]
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
      audio: { inputs: [], media: { gain: 0, mute: false }, master: { gain: 0, limiter: true, monitor: false, monitorGain: -6 } },
      transition: { ms: 600 },
      intro: { fileId: '', after: '', loop: false, fadeMs: 2000 },
      ending: { fileId: '', after: 'black' },
      autoIntro: false,
      speakers: [
        { id: uid('spk'), name: 'Pastor Name', title: 'Senior Pastor', hotkey: '' },
        { id: uid('spk'), name: 'Worship Leader', title: 'Worship Team', hotkey: '' }
      ],
      speakerStyle: { style: 'lower', color: '#2563eb', autoHide: 8 }
    };
  }
  const defaultSettings = () => ({
    youtube: { server: 'rtmps://a.rtmps.youtube.com:443/live2', custom: '', key: '' },
    output: { width: 1920, height: 1080, fps: 30, bitrate: 8000, encoder: 'x264', audioBitrate: 160, recordBitrate: 20000 },
    recordDir: '', autoRecord: false, ftbAudio: true, zebra: true, moveSpeed: 0.12,
    ui: { scale: 1, accent: '#3b82f6', card: 1, layouts: defaultLayouts(), layoutV: 2 },
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
  if (settings.ui.layoutV !== 2 || !settings.ui.layouts) { settings.ui.layouts = defaultLayouts(); settings.ui.layoutV = 2; delete curLayout(); }
  for (const v of ['live', 'setup']) {
    if (!Array.isArray(settings.ui.layouts[v]) || !settings.ui.layouts[v].length) settings.ui.layouts[v] = layoutFrom(v);
    for (const id of Object.keys(PANEL_DEFS)) if (!settings.ui.layouts[v].find(x => x.id === id)) settings.ui.layouts[v].push({ id, w: 4, h: 4, hidden: true });
  }
  let view = 'live';
  const curLayout = () => settings.ui.layouts[view];

  const saveShow = debounce(() => S.saveShow(show), 400);
  const saveSettings = debounce(() => S.saveSettings(settings), 400);
  const changed = () => saveShow();

  const rt = {
    previewId: null, editingId: null, colorSrc: null, padTarget: 'main',
    cams: new Map(), camStatus: new Map(), files: new Map(),
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
  async function refreshDevices() {
    try {
      let list = await navigator.mediaDevices.enumerateDevices();
      if (!list.some(d => d.label) && !S.isApp) {
        try { const p = await navigator.mediaDevices.getUserMedia({ video: true, audio: true }); p.getTracks().forEach(t => t.stop()); } catch (e) { /* no permission */ }
        list = await navigator.mediaDevices.enumerateDevices();
      }
      rt.devices.video = list.filter(d => d.kind === 'videoinput').map(d => ({ id: d.deviceId, label: d.label || 'Camera' }));
      rt.devices.audio = list.filter(d => d.kind === 'audioinput').map(d => ({ id: d.deviceId, label: d.label || 'Audio input' }));
    } catch (e) { console.warn(e); }
  }
  navigator.mediaDevices && navigator.mediaDevices.addEventListener('devicechange', async () => {
    await refreshDevices();
    for (const c of show.cameras) if (!rt.cams.has(c.id) && rt.devices.video.find(d => d.id === c.deviceId)) openCamera(c);
    refresh('inputs');
  });
  function closeCamera(id) {
    const c = rt.cams.get(id);
    if (c) { c.stream.getTracks().forEach(t => t.stop()); c.v.remove(); rt.cams.delete(id); }
    engine.removeSource(id);
  }
  async function openCamera(cam) {
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
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { deviceId: { exact: cam.deviceId }, width: { ideal: res[0] }, height: { ideal: res[1] }, frameRate: { ideal: settings.output.fps } }, audio: false
      });
      const v = el('video', { playsinline: true });
      v.muted = true; v.srcObject = stream;
      $('#sourceBin').append(v);
      await v.play().catch(() => {});
      rt.cams.set(cam.id, { stream, v });
      engine.setSource(cam.id, v, 'video');
      engine.setColor(cam.id, cam.color);
      const tr = stream.getVideoTracks()[0];
      const update = () => { const st = tr.getSettings(); rt.camStatus.set(cam.id, { ok: true, text: `${v.videoWidth || st.width}×${v.videoHeight || st.height} · ${Math.round(st.frameRate || 0)} fps` }); refreshInputStatus(); };
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
      const types = { mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };
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
  }
  async function addFiles() {
    const picked = await S.pickMedia();
    const added = [];
    for (const p of picked || []) {
      const kind = /\.(png|jpe?g|webp|gif)$/i.test(p.name) ? 'image' : 'video';
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
        f.el.loop = (to.role === 'intro' && show.intro.loop) ? true : !!(fileById(id) || {}).loop;
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
    if (engine.inTransition) return;
    const to = rt.previewId, from = engine.programId;
    if (!to || to === from) return;
    const ms = kind === 'cut' ? 0 : (msOverride !== undefined ? msOverride : show.transition.ms);
    startProgram(to, from, ms);
    if (ms) engine.fade(to, ms); else engine.cut(to);
    rt.previewId = from || to; engine.previewId = rt.previewId;
    renderTally();
  }
  function takeShot(id, kind, ms) { if (!getShot(id) || id === engine.programId) return; setPreview(id); take(kind, ms); }
  function setBlack(on) {
    engine.setBlack(on, show.transition.ms || 500);
    if (settings.ftbAudio) mixer.fadeMaster(!on, show.transition.ms || 500);
    renderTally();
  }
  function onMediaEnded(fileId) {
    const shot = getShot(engine.programId);
    if (!shot || shot.main.source !== fileId) return;
    const a = shot.onEnd || {};
    if (a.action === 'goto' && getShot(a.target)) takeShot(a.target, 'auto', a.fadeMs);
    else if (a.action === 'black') setBlack(true);
    else if (a.action === 'stop') { setBlack(true); setTimeout(() => { if (rt.live) stopLive(); }, (show.transition.ms || 500) + 1500); }
  }

  /* the before-service video ("intro") and the ending are ordinary shots with a role,
     kept in sync with the Before Service & Ending panel */
  const firstCameraShot = () => show.shots.find(x => !x.role && show.cameras.some(c => c.id === x.main.source)) || show.shots.find(x => !x.role);
  function syncRoleShots() {
    for (const role of ['intro', 'ending']) {
      const cfg = show[role];
      let s = show.shots.find(x => x.role === role);
      if (!cfg.fileId) continue;
      if (!s) { s = newShot(role === 'intro' ? 'Before Service' : 'Ending', cfg.fileId, '#d97706'); s.role = role; show.shots.push(s); }
      s.main.source = cfg.fileId;
      if (role === 'intro' && !cfg.after) { const c = firstCameraShot(); if (c) cfg.after = c.id; }
      const after = cfg.after || '';
      s.onEnd = ['black', 'stop', 'none'].includes(after) ? { action: after, target: '' } : (after ? { action: 'goto', target: after } : { action: 'none', target: '' });
      if (role === 'intro') s.onEnd.fadeMs = cfg.fadeMs || 2000;
    }
  }
  const roleShot = role => show.shots.find(x => x.role === role);
  function playRole(role) {
    syncRoleShots();
    const s = roleShot(role);
    if (!s || !show[role].fileId) { toast(`Choose ${role === 'intro' ? 'a before-service' : 'an ending'} video first (Before Service & Ending panel).`, 'error'); return; }
    if (engine.isBlack) setBlack(false);
    takeShot(s.id, role === 'intro' ? 'cut' : 'auto');
    refresh('shots');
  }
  /* fade from the before-service video (looping or not) into the camera */
  function startService() {
    syncRoleShots();
    const intro = roleShot('intro');
    const target = getShot(show.intro.after) || firstCameraShot();
    if (!target) { toast('Add a camera shot first.', 'error'); return; }
    if (engine.isBlack) setBlack(false);
    takeShot(target.id, 'auto', intro && engine.programId === intro.id ? (show.intro.fadeMs || 2000) : undefined);
  }

  /* ================= labels ================= */
  function setLabelVisible(id, on) {
    if (id && id.startsWith('spk_')) { if (on) showSpeaker(id); else if (rt.speakerId === id) hideSpeaker(); return; }
    const L = show.labels.find(l => l.id === id);
    if (!L) return;
    engine.setLabel(L, on);
    clearTimeout(rt.labelTimers.get(id));
    if (on && L.autoHide > 0) rt.labelTimers.set(id, setTimeout(() => setLabelVisible(id, false), L.autoHide * 1000));
    refreshLabelStates();
  }
  const toggleLabel = id => setLabelVisible(id, !engine.labelVisible(id));
  show.labels.forEach(l => engine.setLabel(l, false));

  /* ================= speakers: one-click name captions for the person talking ================= */
  const SPK = '__speaker';
  const speakerLabel = p => ({ id: SPK, title: p.name, subtitle: p.title, style: show.speakerStyle.style, color: show.speakerStyle.color, design: show.speakerStyle.design });
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
      if (sec > 0) rt.speakerTimer = setTimeout(hideSpeaker, sec * 1000);
    };
    if (rt.speakerObj && engine.labelVisible(SPK) && rt.speakerId !== id) {
      // another person's caption is up: slide it out, then bring the new one in
      engine.setLabel(rt.speakerObj, false);
      rt.speakerId = id; refreshSpeakerStates();
      rt.speakerSwap = setTimeout(go, labelDesign(rt.speakerObj).fadeMs + 80);
    } else go();
  }
  function hideSpeaker() {
    clearTimeout(rt.speakerTimer); clearTimeout(rt.speakerSwap);
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
      const opts = this.kind === 'stream'
        ? { kind: 'stream', url: streamURL(), fps: o.fps, bitrate: o.bitrate, encoder: o.encoder, audioBitrate: o.audioBitrate, inputCodec: codecOf(mime) }
        : { kind: 'record', dir: settings.recordDir, name: show.showName, fps: o.fps, encoder: o.encoder, bitrate: o.recordBitrate, inputCodec: codecOf(mime) };
      const r = await S.outStart(opts);
      if (!r || r.error) throw new Error(r ? r.error : 'Encoder did not start');
      this.id = r.id;
      this.track = engine.videoTrack().clone();
      const ms = new MediaStream([this.track, ...mixer.stream().getAudioTracks()]);
      const vbps = this.kind === 'stream' ? clamp(o.bitrate * 3000, 10e6, 40e6) : clamp(o.recordBitrate * 1000, 6e6, 60e6);
      this.rec = new MediaRecorder(ms, { mimeType: mime, videoBitsPerSecond: vbps, audioBitsPerSecond: 256000 });
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
      rt.liveStart = Date.now(); rt.liveStats = null; rt.reconnects = 0;
      S.setLive(true);
      document.body.classList.add('is-live');
      if (settings.autoRecord && !rt.rec) startRec();
      if (show.autoIntro && show.intro.fileId) playRole('intro');
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
  async function reconnect() {
    const o = rt.live; if (!o) return;
    rt.reconnecting = true; renderHeader();
    await o.stopRecorder();
    const wait = Math.min(15000, 2000 * (1 + (rt.reconnects || 0)));
    rt.reconnects = (rt.reconnects || 0) + 1;
    setTimeout(async () => {
      if (rt.live !== o) return;
      try { const n = new Output('stream'); await n.start(); rt.live = n; rt.reconnecting = false; toast('Stream reconnected.', 'ok'); }
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
    if (ev.type === 'stats') { if (ev.kind === 'stream') rt.liveStats = ev; else rt.recStats = ev; return; }
    if (ev.type === 'exit') {
      if (ev.file) toast(`Recording saved: ${ev.file}`, 'ok', S.showFile ? { label: 'Show', fn: () => S.showFile(ev.file) } : null);
      if (ev.expected) return;
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
  $('#btnSettings').addEventListener('click', () => openSettings());
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
    parts.push(`engine ${engine.stats.fps} fps`);
    hl.innerHTML = parts.join(' · ');
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
  RENDER.monitors = body => {
    body.innerHTML = '';
    const pvName = el('span', { class: 'name', id: 'pvName' });
    const pgName = el('span', { class: 'name', id: 'pgName' });
    const durSel = select([[0, 'Cut (instant)'], [300, 'Fade 0.3 s'], [600, 'Fade 0.6 s'], [1000, 'Fade 1 s'], [2000, 'Fade 2 s']], show.transition.ms, v => { show.transition.ms = +v; changed(); });
    put(body, el('div', { class: 'monitors' },
      el('div', { class: 'monitor preview' }, el('div', { class: 'monitor-label' }, el('span', { class: 'tag' }, 'NEXT'), pvName), el('div', { class: 'screen' }, previewCanvas)),
      el('div', { class: 'switcher' },
        el('button', { class: 'btn big take-btn', onclick: () => take('auto') }, 'TAKE ▶', keyChip('take')),
        el('button', { class: 'btn big cut-btn', onclick: () => take('cut') }, 'CUT', keyChip('cut')),
        durSel,
        el('button', { class: 'btn ftb-btn', id: 'ftbBtn', onclick: () => setBlack(!engine.isBlack) }, 'FADE TO BLACK', keyChip('ftb')),
        el('button', { class: 'btn small ghost', onclick: openShortcuts }, '⌨ Shortcuts…')),
      el('div', { class: 'monitor program' }, el('div', { class: 'monitor-label' }, el('span', { class: 'tag' }, 'ON AIR'), pgName), el('div', { class: 'screen' }, engine.canvas, progInfo, progBar))
    ));
    renderTally();
  };

  /* ================= panel: shots ================= */
  function thumbFor(id) {
    let c = rt.thumbs.get(id);
    if (!c) { c = el('canvas', { width: 320, height: 180 }); rt.thumbs.set(id, c); engine.thumbs.set(id, c); }
    return c;
  }
  RENDER.shots = body => {
    body.innerHTML = '';
    const wrap = el('div', { class: 'shots' });
    show.shots.forEach((s, i) => {
      const card = el('div', { class: 'shot', style: `--shot-color:${s.color}`, dataset: { id: s.id } },
        thumbFor(s.id),
        el('span', { class: 'badge' }),
        mediaOf(s).length ? el('span', { class: 'film' }, '🎞') : null,
        el('button', { class: 'edit', title: 'Edit shot', onclick: e => { e.stopPropagation(); editShot(s.id); } }, '✎'),
        el('div', { class: 'meta' }, el('span', { class: 'nm' }, s.name), keyChip('shot:' + s.id)));
      card.addEventListener('click', () => { setPreview(s.id); editShot(s.id, true); });
      card.addEventListener('dblclick', () => takeShot(s.id, 'auto'));
      wrap.append(card);
    });
    wrap.append(el('div', { class: 'shot add', onclick: addShot }, '+ New shot'));
    put(body, wrap);
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
    if (pv) pv.textContent = (getShot(rt.previewId) || {}).name || '';
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
      el('div', { class: 'field' }, el('span', null, 'Picture source'), select(sourceOptions(false), s.main.source, v => { s.main.source = v; s.main.frame = { zoom: 1, x: 0.5, y: 0.5 }; changed(); refresh('editor'); refresh('shots'); })),
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

      el('div', { class: 'section' }, el('h4', null, 'Automatic label'),
        select([['', 'No label'], ...show.speakers.map(p => [p.id, `Speaker: ${p.name}${p.title ? ' — ' + p.title : ''}`]), ...show.labels.map(l => [l.id, `${l.title}${l.subtitle ? ' — ' + l.subtitle : ''}`])], s.labelId, v => { s.labelId = v; changed(); }),
        el('div', { class: 'muted', style: 'font-size:.85em;margin-top:4px' }, 'Shown when this shot goes live, hidden when you switch away.')),

      mediaOf(s).length ? el('div', { class: 'section' }, el('h4', null, 'When the video ends'),
        select([['none', 'Hold the last frame'], ['black', 'Fade to black'], ['stop', 'Fade to black and end the stream'], ...show.shots.filter(x => x.id !== s.id).map(x => [`goto:${x.id}`, `Go to “${x.name}”`])],
          s.onEnd.action === 'goto' ? `goto:${s.onEnd.target}` : s.onEnd.action,
          v => { s.onEnd = v.startsWith('goto:') ? { action: 'goto', target: v.slice(5) } : { action: v, target: '' }; if (s.role) show[s.role].after = s.onEnd.action === 'goto' ? s.onEnd.target : s.onEnd.action; changed(); refresh('media'); })) : null,

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
    if (s.role) show[s.role].fileId = '';
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
        check(' Zebra on preview', settings.zebra, v => { settings.zebra = v; engine.zebra = v; saveSettings(); })),
      el('div', { class: 'muted', style: 'font-size:.82em;margin-top:8px' }, 'Zebra stripes on the Preview screen show parts that are too bright. Double-click a slider to reset it.')
    );
  };

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
  RENDER.labels = body => {
    body.innerHTML = '';
    show.labels.forEach((L, i) => {
      const upd = () => { engine.setLabel(L); changed(); };
      const on = engine.labelVisible(L.id);
      put(body, el('div', { class: 'label-card' + (on ? ' on' : ''), dataset: { label: L.id } },
        el('div', { class: 'row' },
          el('input', { type: 'text', class: 'grow', value: L.title, placeholder: 'Main text (name, title)', oninput: e => { L.title = e.target.value; upd(); } }),
          el('button', { class: 'btn air-btn' + (on ? ' on' : ''), onclick: () => toggleLabel(L.id) }, on ? 'ON AIR' : 'SHOW')),
        el('div', { class: 'row' },
          el('input', { type: 'text', class: 'grow', value: L.subtitle, placeholder: 'Second line (optional)', oninput: e => { L.subtitle = e.target.value; upd(); } })),
        el('div', { class: 'row wrap' },
          el('button', { class: 'btn small', onclick: () => openDesigner(L, { title: L.title, subtitle: L.subtitle }, upd) }, '🎨 Design look…'),
          select([[0, 'Stay on'], [5, 'Hide after 5 s'], [8, 'Hide after 8 s'], [15, 'Hide after 15 s']], L.autoHide, v => { L.autoHide = +v; changed(); }),
          el('span', { class: 'grow' }),
          keyChip('lbl:' + L.id),
          el('button', { class: 'btn small danger', title: 'Delete label', onclick: () => { engine.removeLabel(L.id); show.labels.splice(i, 1); changed(); refresh('labels'); } }, '✕'))));
    });
    put(body, el('button', { class: 'btn', onclick: () => { const last = show.labels[show.labels.length - 1] || show.speakerStyle; const L = { id: uid('lbl'), title: 'Name', subtitle: 'Title', style: last.style || 'lower', color: last.color || settings.ui.accent, design: clone(last.design || {}), autoHide: 0 }; show.labels.push(L); engine.setLabel(L, false); changed(); refresh('labels'); } }, '+ Add label'));
  };
  function refreshLabelStates() {
    document.querySelectorAll('.label-card[data-label]').forEach(card => {
      const on = engine.labelVisible(card.dataset.label);
      card.classList.toggle('on', on);
      const b = card.querySelector('.air-btn'); b.classList.toggle('on', on); b.textContent = on ? 'ON AIR' : 'SHOW';
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
  RENDER.media = body => {
    body.innerHTML = '';
    const vids = show.files.filter(f => f.kind === 'video');
    const fileSel = role => {
      const sel = select([['', vids.length ? '— choose a video —' : '— no videos yet —'], ...vids.map(f => [f.id, f.name])], show[role].fileId, v => { show[role].fileId = v; syncRoleShots(); changed(); refresh('shots'); refresh('media'); }, { class: 'grow' });
      return el('div', { class: 'row' }, sel, el('button', { class: 'btn small primary', onclick: async () => { const a = await addFiles(); const v = a.find(f => f.kind === 'video'); if (v) { show[role].fileId = v.id; syncRoleShots(); changed(); refreshAll(); } } }, 'Import video…'));
    };
    const shots = show.shots.filter(x => !x.role);
    const camShots = shots.map(x => [x.id, x.name]);
    const I = show.intro;
    const introOn = roleShot('intro') && (engine.programId === roleShot('intro').id);
    put(body,
      el('div', { class: 'media-slot' + (introOn ? ' on' : '') },
        el('h4', null, '⏳ Before service'),
        fileSel('intro'), fileStatus(I.fileId),
        el('div', { class: 'field', style: 'margin-top:10px' }, el('span', null, 'Playback'),
          radio('introLoop', [[false, 'Play once, then fade to the camera'], [true, 'Loop until I start the service']], !!I.loop, v => { I.loop = v === true || v === 'true'; const r = rt.files.get(I.fileId); if (introOn && r && r.el) r.el.loop = I.loop; changed(); })),
        el('div', { class: 'grid2' },
          el('div', { class: 'field' }, el('span', null, 'Fade into'), select(camShots.length ? camShots : [['', '— add a camera shot —']], I.after, v => { I.after = v; syncRoleShots(); changed(); })),
          el('div', { class: 'field' }, el('span', null, 'Fade length'), select([[1000, '1 second'], [2000, '2 seconds'], [3000, '3 seconds'], [5000, '5 seconds']], I.fadeMs || 2000, v => { I.fadeMs = +v; syncRoleShots(); changed(); }))),
        el('div', { class: 'row', style: 'gap:8px' },
          el('button', { class: 'btn big play-btn grow', onclick: () => playRole('intro') }, '▶ PLAY', keyChip('intro')),
          el('button', { class: 'btn big take-btn grow', title: 'Fade from the video into the camera now', onclick: startService }, 'START SERVICE ▶', keyChip('startService'))),
        el('div', { class: 'muted mono', id: 'introStatus', style: 'margin-top:6px;min-height:1.2em' }),
        el('div', { style: 'margin-top:4px' }, check(' Start this video automatically when I press GO LIVE', show.autoIntro, v => { show.autoIntro = v; changed(); }))),
      el('div', { class: 'media-slot' },
        el('h4', null, '🏁 Closing video'),
        fileSel('ending'), fileStatus(show.ending.fileId),
        el('div', { class: 'row', style: 'margin-top:8px' }, el('span', { class: 'muted' }, 'Then'),
          select([['black', 'Fade to black'], ['stop', 'Fade to black and end the stream'], ['none', 'Hold the last frame'], ...shots.map(x => [x.id, `Go to “${x.name}”`])], show.ending.after || 'black', v => { show.ending.after = v; syncRoleShots(); changed(); }, { class: 'grow' })),
        el('button', { class: 'btn big play-btn', onclick: () => playRole('ending') }, '▶ PLAY ENDING', keyChip('ending')))
    );
  };
  function tickIntroStatus() {
    const n = $('#introStatus'); if (!n) return;
    const s = roleShot('intro'), f = rt.files.get(show.intro.fileId);
    const on = s && engine.programId === s.id;
    if (!on || !f || !f.el) { n.textContent = f && f.ok ? `Ready · ${fmtShort(f.el.duration || 0)} long` : ''; return; }
    n.textContent = show.intro.loop ? '● ON AIR — looping. Press START SERVICE when you are ready.' : `● ON AIR — fades to camera in ${fmtShort(f.el.duration - f.el.currentTime)}`;
  }

  /* ================= panel: speakers ================= */
  RENDER.speakers = body => {
    body.innerHTML = '';
    const st = show.speakerStyle;
    const restyle = restyleSpeaker;
    const grid = el('div', { class: 'spk-grid' });
    show.speakers.forEach(p => {
      grid.append(el('div', { class: 'spk' + (speakerOnAir(p.id) ? ' on' : ''), dataset: { spk: p.id }, onclick: () => toggleSpeaker(p.id) },
        el('div', { class: 'spk-name' }, p.name || '(no name)'),
        el('div', { class: 'spk-title' }, p.title || ''),
        el('div', { class: 'spk-foot' }, el('span', { class: 'spk-air' }, speakerOnAir(p.id) ? 'ON AIR' : ''), keyChip('spk:' + p.id),
          el('button', { class: 'edit', title: 'Edit', onclick: e => { e.stopPropagation(); editSpeaker(p); } }, '✎'))));
    });
    const nm = el('input', { type: 'text', placeholder: 'Name', class: 'grow' });
    const tt = el('input', { type: 'text', placeholder: 'Title (e.g. Guest Speaker)', class: 'grow' });
    const add = () => {
      if (!nm.value.trim()) { nm.focus(); return; }
      show.speakers.push({ id: uid('spk'), name: nm.value.trim(), title: tt.value.trim(), hotkey: '' });
      changed(); refresh('speakers'); refresh('editor');
    };
    tt.addEventListener('keydown', e => { if (e.key === 'Enter') add(); });
    nm.addEventListener('keydown', e => { if (e.key === 'Enter') tt.focus(); });
    put(body,
      show.speakers.length ? grid : el('div', { class: 'empty' }, 'Add the people who speak — pastor, worship leader, guests.'),
      el('div', { class: 'row', style: 'margin-top:10px' }, nm, tt, el('button', { class: 'btn', onclick: add }, '+ Add')),
      el('div', { class: 'row wrap', style: 'margin-top:10px' },
        el('button', { class: 'btn small', onclick: () => { const p = show.speakers[0] || { name: 'John Smith', title: 'Senior Pastor' }; openDesigner(st, { title: p.name, subtitle: p.title }, restyle); } }, '🎨 Design look…'),
        select([[0, 'Stay on until hidden'], [5, 'Hide after 5 s'], [8, 'Hide after 8 s'], [10, 'Hide after 10 s'], [15, 'Hide after 15 s']], st.autoHide, v => { st.autoHide = +v; changed(); }),
        el('span', { class: 'grow' }),
        el('button', { class: 'btn small danger', onclick: hideSpeaker }, 'Hide caption', keyChip('hideAll'))),
      el('div', { class: 'muted', style: 'font-size:.82em;margin-top:8px' }, 'Click a name to put it on screen; click again to take it off. Picking another name swaps the caption. Set a key for each person in Settings → Keyboard shortcuts.')
    );
  };
  function refreshSpeakerStates() {
    document.querySelectorAll('.spk[data-spk]').forEach(c => {
      const on = speakerOnAir(c.dataset.spk) || (rt.speakerId === c.dataset.spk);
      c.classList.toggle('on', on);
      c.querySelector('.spk-air').textContent = on ? 'ON AIR' : '';
    });
  }
  function editSpeaker(p) {
    const d = { name: p.name, title: p.title };
    openModal('Edit speaker', el('div', null,
      el('div', { class: 'field' }, el('span', null, 'Name'), el('input', { type: 'text', value: d.name, oninput: e => { d.name = e.target.value; } })),
      el('div', { class: 'field' }, el('span', null, 'Title / role'), el('input', { type: 'text', value: d.title, oninput: e => { d.title = e.target.value; } })),
      el('div', { class: 'row' },
        el('button', { class: 'btn danger', onclick: () => { if (rt.speakerId === p.id) hideSpeaker(); show.speakers = show.speakers.filter(x => x !== p); delete settings.hotkeys['spk:' + p.id]; saveSettings(); changed(); closeModal(); refresh('speakers'); } }, 'Delete'),
        el('button', { class: 'btn small', onclick: () => { const i = show.speakers.indexOf(p); if (i > 0) { show.speakers.splice(i, 1); show.speakers.splice(i - 1, 0, p); changed(); refresh('speakers'); } } }, '◂ Move'),
        el('button', { class: 'btn small', onclick: () => { const i = show.speakers.indexOf(p); if (i < show.speakers.length - 1) { show.speakers.splice(i, 1); show.speakers.splice(i + 1, 0, p); changed(); refresh('speakers'); } } }, 'Move ▸'),
        el('span', { class: 'grow' }),
        el('button', { class: 'btn primary', onclick: () => { p.name = d.name; p.title = d.title; if (rt.speakerId === p.id && engine.labelVisible(SPK)) { rt.speakerObj = speakerLabel(p); engine.setLabel(rt.speakerObj); } changed(); closeModal(); refresh('speakers'); refresh('editor'); } }, 'Save'))));
  }

  /* ================= panel: audio ================= */
  function meter(id) { const i = el('i'); const m = el('div', { class: 'meter' }, i); rt.meters.set(id, { i, m }); return m; }
  function strip({ id, name, cfg, onName, extra, master }) {
    const db = el('span', { class: 'db mono' }, cfg.gain <= -60 ? '-∞' : `${cfg.gain > 0 ? '+' : ''}${cfg.gain.toFixed(1)} dB`);
    const fader = el('input', { type: 'range', class: 'fader', min: -60, max: 12, step: 0.5, value: cfg.gain, title: 'Double-click for 0 dB' });
    const setGain = v => { cfg.gain = v; db.textContent = v <= -60 ? '-∞' : `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`; master ? mixer.setMaster(cfg) : mixer.update(id, cfg); changed(); };
    fader.addEventListener('input', () => setGain(+fader.value));
    fader.addEventListener('dblclick', () => { fader.value = 0; setGain(0); });
    const meters = master ? [meter('__L'), meter('__R')] : [meter(id)];
    const muteBtn = master ? null : el('button', { class: 'btn small mute-btn' + (cfg.mute ? ' on' : ''), onclick: () => { cfg.mute = !cfg.mute; mixer.update(id, cfg); changed(); muteBtn.classList.toggle('on', cfg.mute); meters[0].classList.toggle('muted', cfg.mute); } }, 'MUTE');
    if (cfg.mute) meters[0].classList.add('muted');
    return el('div', { class: 'strip' + (master ? ' master' : '') },
      onName ? el('input', { type: 'text', class: 'nm', value: name, oninput: e => onName(e.target.value) }) : el('div', { class: 'nm' }, name),
      el('div', { class: 'fader-wrap' }, ...meters, fader), db,
      el('div', { class: 'btns' }, muteBtn, extra));
  }
  RENDER.audio = body => {
    body.innerHTML = '';
    rt.meters.clear();
    const mx = el('div', { class: 'mixer' });
    for (const a of show.audio.inputs) {
      const s = strip({ id: a.id, name: a.name, cfg: a, onName: v => { a.name = v; changed(); }, extra: el('button', { class: 'btn small', title: 'Input settings', onclick: () => inputSettings(a) }, '⚙') });
      const dev = rt.devices.audio.find(d => d.id === a.deviceId);
      s.append(el('div', { class: 'tagline' }, `${dev ? dev.label.replace(/\s*\(.*?\)\s*$/, '') : 'Device missing'} · ${a.channel === 'stereo' ? 'Stereo 1+2' : a.channel === 'mix' ? 'Mix 1+2' : 'In ' + a.channel}`));
      mx.append(s);
    }
    mx.append(strip({ id: 'media', name: 'Video files', cfg: show.audio.media }));
    const m = show.audio.master;
    const hp = el('button', { class: 'btn small' + (m.monitor ? ' primary' : ''), title: 'Listen to the program on this computer\'s speakers/headphones', onclick: () => { m.monitor = !m.monitor; mixer.setMaster(m); changed(); hp.classList.toggle('primary', m.monitor); } }, '🎧');
    const lim = el('button', { class: 'btn small' + (m.limiter ? ' primary' : ''), title: 'Limiter protects the stream from distortion', onclick: () => { m.limiter = !m.limiter; mixer.setMaster(m); changed(); lim.classList.toggle('primary', m.limiter); } }, 'LIM');
    mx.append(strip({ id: 'master', name: 'MASTER', cfg: m, master: true, extra: el('span', { style: 'display:flex;gap:4px;flex:1' }, hp, lim) }));
    mx.append(el('div', { class: 'strip add', onclick: () => inputSettings(null) }, '+ Add mic / input'));
    put(body, mx);
  };
  function inputSettings(a) {
    const isNew = !a;
    const cfg = a ? clone(a) : { id: uid('in'), name: `Mic ${show.audio.inputs.length + 1}`, deviceId: (rt.devices.audio.find(d => /ssl/i.test(d.label)) || rt.devices.audio[0] || {}).id || '', channel: '1', gain: 0, mute: false, delay: 0, lowcut: true, voice: true, pan: 0 };
    const devSel = select(rt.devices.audio.map(d => [d.id, d.label]), cfg.deviceId, v => { cfg.deviceId = v; });
    const chSel = select([['1', 'Input 1 (mono)'], ['2', 'Input 2 (mono)'], ['3', 'Input 3 (mono)'], ['4', 'Input 4 (mono)'], ['stereo', 'Inputs 1+2 as stereo'], ['mix', 'Inputs 1+2 mixed to mono']], cfg.channel, v => { cfg.channel = v; });
    const body = el('div', null,
      el('div', { class: 'field' }, el('span', null, 'Name'), el('input', { type: 'text', value: cfg.name, oninput: e => { cfg.name = e.target.value; } })),
      el('div', { class: 'grid2' },
        el('div', { class: 'field' }, el('span', null, 'Audio device'), devSel),
        el('div', { class: 'field' }, el('span', null, 'Which input'), chSel)),
      el('div', { class: 'muted', style: 'font-size:.85em;margin:-4px 0 12px' }, 'SSL 2 / 2+: mic or instrument on input 1 or 2. For camera audio over HDMI/SDI choose the Blackmagic audio device.'),
      el('div', { class: 'grid2' },
        el('div', { class: 'field' }, el('span', null, 'Audio delay (lip sync)'), el('div', { class: 'row' }, el('input', { type: 'number', min: 0, max: 2000, step: 10, value: cfg.delay, oninput: e => { cfg.delay = +e.target.value || 0; } }), 'ms')),
        el('div', { class: 'field' }, el('span', null, 'Pan'), el('input', { type: 'range', min: -1, max: 1, step: 0.05, value: cfg.pan, oninput: e => { cfg.pan = +e.target.value; } }))),
      el('div', { class: 'row wrap', style: 'gap:18px;margin-bottom:14px' },
        check(' Low-cut (removes rumble)', cfg.lowcut, v => { cfg.lowcut = v; }),
        check(' Voice leveler (gentle compression)', cfg.voice, v => { cfg.voice = v; })),
      el('div', { class: 'row' },
        isNew ? null : el('button', { class: 'btn danger', onclick: () => { mixer.removeInput(cfg.id); show.audio.inputs = show.audio.inputs.filter(x => x.id !== cfg.id); changed(); closeModal(); refresh('audio'); } }, 'Remove input'),
        el('span', { class: 'grow' }),
        el('button', { class: 'btn primary', onclick: async () => {
          if (isNew) show.audio.inputs.push(cfg); else Object.assign(a, cfg);
          const target = isNew ? cfg : a;
          changed(); closeModal();
          await openAudioInput(target, true);
          refresh('audio');
        } }, isNew ? 'Add input' : 'Save')));
    openModal(isNew ? 'Add audio input' : `Audio input — ${cfg.name}`, body);
  }
  async function openAudioInput(a, rebuild) {
    try {
      if (rebuild || !mixer.strips.has(a.id)) await mixer.addInput(a);
      else mixer.update(a.id, a);
    } catch (e) { toast(`${a.name}: could not open audio device (${e.message || e.name}).`, 'error'); }
  }
  function tickMeters() {
    const lv = mixer.levels();
    for (const [id, m] of rt.meters) {
      const db = lv[id];
      if (db === undefined) continue;
      m.i.style.height = `${clamp((db + 60) / 60, 0, 1) * 100}%`;
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
    tickIntroStatus();
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
            select(devOpts, cam.deviceId, v => { cam.deviceId = v; cam.deviceLabel = (rt.devices.video.find(d => d.id === v) || {}).label || ''; changed(); openCamera(cam); }, { class: 'grow' }),
            select([['720', '720p'], ['1080', '1080p'], ['2160', '4K']], cam.res || '1080', v => { cam.res = v; changed(); openCamera(cam); })),
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
    for (const r of ['intro', 'ending']) if (show[r].fileId === f.id) { show[r].fileId = ''; show.shots = show.shots.filter(s => s.role !== r); }
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
        previewCanvas.height = Math.round(960 * o.height / o.width);
      }
    };
    const body = el('div', null,
      el('h3', { id: 'set-youtube' }, 'YouTube'),
      el('div', { class: 'field' }, el('span', null, 'Server'), select([['rtmps://a.rtmps.youtube.com:443/live2', 'YouTube — primary (secure RTMPS, recommended)'], ['rtmp://a.rtmp.youtube.com/live2', 'YouTube — primary (RTMP)'], ['custom', 'Custom server (Facebook, Vimeo, other)…']], y.server, v => { y.server = v; customRow.classList.toggle('hidden', v !== 'custom'); saveSettings(); })),
      customRow,
      el('div', { class: 'field' }, el('span', null, 'Stream key'), el('div', { class: 'row' }, keyInput, el('button', { class: 'btn small', onclick: e => { keyInput.type = keyInput.type === 'password' ? 'text' : 'password'; e.target.textContent = keyInput.type === 'password' ? 'Show' : 'Hide'; } }, 'Show'))),
      el('div', { class: 'muted', style: 'font-size:.85em' }, 'Find it in YouTube Studio → Create → Go live → Stream → “Stream key”. Keep it private — it is stored encrypted on this computer.'),

      el('h3', null, 'Video output'),
      live ? el('div', { class: 'status-bad', style: 'margin-bottom:8px' }, 'Locked while live or recording.') : null,
      el('div', { class: 'grid2' },
        el('div', { class: 'field' }, el('span', null, 'Resolution'), select([['1920x1080', '1080p (1920×1080)'], ['1280x720', '720p (1280×720)']], `${o.width}x${o.height}`, v => { const [w, h] = v.split('x').map(Number); changeOut('width', w); changeOut('height', h); })),
        el('div', { class: 'field' }, el('span', null, 'Frame rate'), select([[25, '25 fps'], [30, '30 fps'], [50, '50 fps'], [60, '60 fps']], o.fps, v => changeOut('fps', +v))),
        el('div', { class: 'field' }, el('span', null, 'Stream bitrate (kbps)'), el('input', { type: 'number', min: 1500, max: 20000, step: 500, value: o.bitrate, onchange: e => changeOut('bitrate', clamp(+e.target.value, 1500, 20000)) })),
        el('div', { class: 'field' }, el('span', null, 'Encoder'), select([['x264', 'Software (works on every PC)'], ['nvenc', 'NVIDIA graphics card (NVENC)'], ['qsv', 'Intel graphics (Quick Sync)'], ['amf', 'AMD graphics card (AMF)']], o.encoder, v => changeOut('encoder', v)))),
      el('div', { class: 'muted', style: 'font-size:.85em' }, 'Tip: use a hardware encoder if your PC has one — it leaves the processor free. Your upload speed should be about 1.5× the bitrate.'),

      el('h3', null, 'Recording'),
      el('div', { class: 'field' }, el('span', null, 'Save recordings to'), el('div', { class: 'row' }, el('input', { type: 'text', class: 'grow', value: s.recordDir, readonly: true, id: 'recDir' }),
        el('button', { class: 'btn small', onclick: async () => { const p = await S.pickFolder(); if (p) { s.recordDir = p; $('#recDir').value = p; saveSettings(); } } }, 'Change…'),
        el('button', { class: 'btn small', onclick: () => S.openFolder(s.recordDir) }, 'Open'))),
      el('div', { class: 'grid2' },
        el('div', { class: 'field' }, el('span', null, 'Recording quality (kbps)'), el('input', { type: 'number', min: 6000, max: 60000, step: 1000, value: o.recordBitrate, onchange: e => changeOut('recordBitrate', clamp(+e.target.value, 6000, 60000)) })),
        el('div', { class: 'field' }, el('span', null, ' '), check(' Start recording automatically when I go live', s.autoRecord, v => { s.autoRecord = v; saveSettings(); }))),

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
    A('take', 'Switching', 'Take — fade Preview to air', 'Space', () => take('auto'));
    A('cut', 'Switching', 'Cut — instant switch', 'Enter', () => take('cut'));
    A('ftb', 'Switching', 'Fade to black / back', 'KeyB', () => setBlack(!engine.isBlack));
    A('nextShot', 'Switching', 'Next shot into Preview', 'ArrowRight', () => stepPreview(1));
    A('prevShot', 'Switching', 'Previous shot into Preview', 'ArrowLeft', () => stepPreview(-1));
    A('intro', 'Videos', 'Play before-service video', 'KeyI', () => playRole('intro'));
    A('startService', 'Videos', 'Start service — fade video into camera', 'KeyS', startService);
    A('ending', 'Videos', 'Play closing video', '', () => playRole('ending'));
    A('hideAll', 'Labels & speakers', 'Hide all labels and name captions', 'KeyH', hideAllGraphics);
    show.speakers.forEach((p, i) => A('spk:' + p.id, 'Speakers (show / hide name caption)', `${p.name}${p.title ? ' — ' + p.title : ''}`, i < 9 ? `Alt+Digit${i + 1}` : '', () => toggleSpeaker(p.id)));
    show.labels.forEach((L, i) => A('lbl:' + L.id, 'Labels (show / hide)', L.title || 'Label', i < 8 ? `F${i + 1}` : '', () => toggleLabel(L.id)));
    show.shots.forEach((sh, i) => A('shot:' + sh.id, 'Shots — put in Preview', sh.name, i < 9 ? `Digit${i + 1}` : '', () => { setPreview(sh.id); editShot(sh.id, true); }));
    show.shots.forEach((sh, i) => A('air:' + sh.id, 'Shots — straight to air', sh.name, i < 9 ? `Shift+Digit${i + 1}` : '', () => takeShot(sh.id, 'auto')));
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
    const list = show.shots;
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
    const ssl = rt.devices.audio.find(d => /ssl/i.test(d.label)) || rt.devices.audio.find(d => d.id === 'default') || rt.devices.audio[0];
    if (ssl) {
      show.audio.inputs.push({ id: uid('in'), name: 'Mic 1', deviceId: ssl.id, channel: '1', gain: 0, mute: false, delay: 0, lowcut: true, voice: true, pan: 0 });
      if (/ssl/i.test(ssl.label)) show.audio.inputs.push({ id: uid('in'), name: 'Mic 2', deviceId: ssl.id, channel: '2', gain: 0, mute: false, delay: 0, lowcut: true, voice: true, pan: 0 });
    }
    show.firstRunDone = true;
    changed();
  }
  async function bootShow() {
    if (!show.firstRunDone) await firstRun();
    show.labels.forEach(l => engine.setLabel(l, false));
    syncRoleShots();
    const prog = show.shots[0], prev = show.shots[1] || show.shots[0];
    engine.cut(prog ? prog.id : null);
    setPreview(prev ? prev.id : null);
    rt.editingId = prev ? prev.id : null;
    renderGrid();
    await Promise.all([
      ...show.cameras.map(c => openCamera(c)),
      ...show.files.map(f => loadFile(f)),
      ...show.audio.inputs.map(a => openAudioInput(a, true))
    ]);
    refreshAll();
  }

  applyUI();
  await refreshDevices();
  engine.start();
  requestAnimationFrame(tickMeters);
  await bootShow();
  renderHeader();
  checkWake();
  window.__live = { engine, mixer, get show() { return show; }, settings, rt, take, takeShot, setPreview, playRole, toggleLabel, setBlack };
})();
