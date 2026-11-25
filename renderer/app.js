/* Live Studio — interface and show control */
(async function () {
  'use strict';
  const S = window.studio;
  const { Engine, makeBars, NEUTRAL, LABEL_PRESETS, LABEL_STYLES, LABEL_ANIMS, labelDesign, labelAnimMs, drawLabel } = window.LiveEngine;
  const { Mixer, compCurve } = window.LiveAudio;

  /* ================= helpers ================= */
  const $ = (s, r = document) => r.querySelector(s);
  // a text as it will appear on screen (translated) — for code that compares before it sets, so nothing is redrawn needlessly
  const T = s => (window.I18N ? window.I18N.tr(s) : s);
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
  /* service log (see “service log” near the end): events are collected here and written to the file every 5 s */
  const LOG = { buf: [], on: !!S.logWrite };
  const logTime = () => { const d = new Date(), z = n => String(n).padStart(2, '0'); return `${z(d.getHours())}:${z(d.getMinutes())}:${z(d.getSeconds())}.${Math.floor(d.getMilliseconds() / 100)}`; };
  function logEvent(kind, msg) { if (LOG.on) { LOG.buf.push(`${logTime()}  ${kind.padEnd(8)} ${msg}`); if (LOG.buf.length > 5000) LOG.buf.splice(0, 1000); } }
  function logFlush() { if (!LOG.on || !LOG.buf.length) return; const t = LOG.buf.join('\r\n') + '\r\n'; LOG.buf = []; S.logWrite(t).catch(() => {}); }
  setInterval(logFlush, 5000);
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
  const fmt = s => { s = Math.max(0, Math.floor(s)); const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, x = s % 60; return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}`; };
  const fmtShort = s => { s = Math.max(0, Math.ceil(s)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
  const clone = o => JSON.parse(JSON.stringify(o));
  function toast(msg, type = '', action) {
    logEvent(type === 'error' ? 'ERROR' : 'MESSAGE', String(msg));
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

  /* vertical fader (like a plug-in fader): drag up / down anywhere on it (hold Shift for fine moves), mouse wheel
     for small steps, double-click to reset, or type a number in the box under it */
  function vfader({ min, max, value, log = false, round = v => Math.round(v * 10) / 10, fmt, onInput, reset, title }) {
    const toF = v => log ? Math.log(v / min) / Math.log(max / min) : (v - min) / (max - min);
    const fromF = f => { f = clamp(f, 0, 1); return round(log ? min * Math.pow(max / min, f) : min + f * (max - min)); };
    let cur = clamp(value, min, max);
    const cap = el('div', { class: 'vf-cap' }, el('i'));
    const track = el('div', { class: 'vf-track', title: title || 'Drag up / down · Shift = fine · double-click = reset' }, el('div', { class: 'vf-slot' }), cap);
    const box = el('input', { class: 'vf-val mono', type: 'text', value: fmt(cur), title: 'Type a value and press Enter' });
    const place = () => { cap.style.top = `${(1 - toF(cur)) * 100}%`; if (document.activeElement !== box) box.value = fmt(cur); };
    const set = v => { v = clamp(round(v), min, max); if (v === cur) return; cur = v; place(); onInput(v); };
    track.addEventListener('pointerdown', e => {
      e.preventDefault(); track.setPointerCapture(e.pointerId);
      const h = track.getBoundingClientRect().height, y0 = e.clientY, f0 = toF(cur);
      const move = ev => set(fromF(f0 - (ev.clientY - y0) / h * (ev.shiftKey ? 0.15 : 1)));
      const up = () => { track.removeEventListener('pointermove', move); track.removeEventListener('pointerup', up); track.removeEventListener('pointercancel', up); };
      track.addEventListener('pointermove', move); track.addEventListener('pointerup', up); track.addEventListener('pointercancel', up);
    });
    track.addEventListener('wheel', e => { e.preventDefault(); set(fromF(toF(cur) + (e.deltaY < 0 ? 1 : -1) * (log ? 0.01 : 0.1 / (max - min)) * (e.shiftKey ? 1 : 1))); }, { passive: false });
    track.addEventListener('dblclick', () => { if (reset !== undefined) set(reset); });
    const typed = () => { const v = parseFloat(String(box.value).replace('−', '-').replace(',', '.')); if (isFinite(v)) set(v); box.value = fmt(cur); };
    box.addEventListener('keydown', e => { if (e.key === 'Enter') { typed(); box.blur(); } if (e.key === 'Escape') { box.value = fmt(cur); box.blur(); } });
    box.addEventListener('blur', typed);
    place();
    return { track, box };
  }

  /* ================= defaults ================= */
  const SHOT_COLORS = ['#64748b', '#2563eb', '#16a34a', '#d97706', '#dc2626', '#9333ea', '#0891b2', '#db2777'];
  const PANEL_DEFS = {
    monitors: { title: 'Video', hint: 'left = preview (next) · right = live' },
    audio: { title: 'Audio', hint: 'what the stream hears' },
    shots: { title: 'Shots', hint: 'click = next · double-click = on air' },
    media: { title: 'Service', hint: 'start and end the service' },
    speakers: { title: 'People', hint: 'click = preview, then TAKE · double-click = on screen now' },
    labels: { title: 'Titles & Graphics', hint: 'click = Preview, then TAKE · double-click = on air now' },
    inputs: { title: 'Cameras & Files' },
    editor: { title: 'Shot Framing', hint: 'zoom and move the picture' },
    color: { title: 'Color & Exposure' }
  };
  // Two screens: "Run Show" has only what you touch during a service; "Setup" has the things you prepare beforehand.
  const LAYOUTS = {
    // like Wirecast: big Preview and Program across the whole width, everything else in rows underneath
    live: [['monitors', 12, 6], ['shots', 5, 4], ['labels', 4, 2], ['media', 3, 4], ['speakers', 4, 2]], // audio controls sit under the monitors
    classic: [['monitors', 9, 5], ['media', 3, 4], ['audio', 3, 4], ['shots', 9, 3], ['speakers', 6, 2], ['labels', 6, 2]],
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
        hold: { musicId: '', musicLoop: true, mode: 'clock', target: '10:00', org: 'Pilgrim Baptist Church · Spokane, WA', title: 'Welcome', subtitle: 'Service will begin shortly', title2: 'Добро пожаловать', subtitle2: 'Служение скоро начнётся', lang2: 'ru', layout: 'side', dim: 0.35, blur: 0, accent: '#d4a24c', zoom: 1.06, focusX: 0.4, focusY: 0, bgColor: '#0b1a33', bgColor2: '#1e1b4b', bgFile: '', textColor: '#ffffff', autoStart: false },
        start: { record: true, goLive: true, videoId: '', fadeMs: 2000, cameraShot: '', ytLive: true },
        end: { mode: 'video', videoId: '', slideImg: '', musicId: '', musicLoop: false, slideSecs: 60, fadeMs: 1500, then: 'hold', stopRec: true, endStream: true, endAfter: 30, ytComplete: true }
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
    recordDir: '', autoRecord: false, ftbAudio: true, zebra: false, moveSpeed: 0.12, updates: 'ask',
    ui: { scale: 1, accent: '#3b82f6', card: 1, layouts: defaultLayouts(), layoutV: 5 },
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
  /* 4K / 1440p: only the native engine makes those (it scales the 1080p cameras up and draws graphics at full size).
     The window's own picture — the monitors, and the whole output with the classic engine — stays at most 1080p. */
  const bigOut = () => (settings.output.height || 1080) > 1080;
  const uiH = () => Math.min(1080, settings.output.height || 1080), uiW = () => Math.round(uiH() * (settings.output.width || 1920) / (settings.output.height || 1080));
  // interface language (everything on screen is translated as it appears — see i18n.js)
  const setLanguage = l => { if (window.I18N) window.I18N.setLang(l); if (S.setLang) S.setLang(l); };
  setLanguage(settings.lang || 'en');
  if (settings.ui.layoutV < 4 || !settings.ui.layouts) { settings.ui.layouts = defaultLayouts(); settings.ui.layoutV = 5; delete settings.ui.layout; }
  if (settings.ui.layoutV === 4) { settings.ui.layouts.live = layoutFrom('live'); settings.ui.layoutV = 5; } // 1.25: big monitors (the Setup page is kept)
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
  // 1.21: GO LIVE only connects to YouTube; recording starts with START SERVICE
  if (!settings.autoRecV) { settings.autoRecord = false; settings.autoRecV = 1; }
  let view = 'live';
  const curLayout = () => settings.ui.layouts[view];

  /* Nothing is written to disk until you press Save. A change only marks the show (or the settings) as
     unsaved; closing the program then asks whether to save. */
  let booting = true;
  const dirty = { show: false, settings: false };
  function updateSaveBtn() {
    const b = $('#btnSave'), d = dirty.show || dirty.settings;
    if (!b || b.classList.contains('ok')) return;
    b.classList.toggle('dirty', d);
    b.textContent = d ? '💾 Save •' : '💾 Save';
    b.title = d ? 'You have unsaved changes — click to save them (Ctrl+Shift+S)' : 'Everything is saved (Ctrl+Shift+S)';
    if (S.setDirty) S.setDirty(d);
  }
  function markDirty(which) { if (booting) return; if (!dirty[which]) { dirty[which] = true; updateSaveBtn(); } }
  const saveShow = () => markDirty('show');
  const saveSettings = () => markDirty('settings');
  const changed = () => markDirty('show');

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

  // 1.27: the output runs at the cameras' exact rate. 60.00 with 59.94 cameras means one camera picture is shown
  // twice about every 17 seconds (a small hitch on YouTube); 59.94 avoids it.
  if (!settings.output.fpsV) {
    const camRates = show.cameras.map(c => String(c.fps || ''));
    if (settings.output.fps === 60 && camRates.includes('59.94')) settings.output.fps = 59.94;
    if (settings.output.fps === 30 && camRates.includes('29.97')) settings.output.fps = 29.97;
    settings.output.fpsV = 1;
    setTimeout(() => S.saveSettings(settings).catch(() => {}), 3000);
  }
  /* ================= engine + mixer ================= */
  let engine;
  try {
    engine = new Engine({ width: uiW(), height: uiH(), fps: settings.output.fps });
    engine.frameSync = false; // see engine.js — the normal camera path is used
  } catch (e) {
    document.body.innerHTML = `<div style="padding:40px;font-size:18px">Live Studio could not start the video engine.<br><br>${e.message}<br><br>Update your graphics driver and restart.</div>`;
    return;
  }
  engine.getShot = getShot;
  engine.moveSpeed = settings.moveSpeed;
  engine.zebra = settings.zebra;
  engine.setSource('bars', makeBars(uiW(), uiH()), 'image');
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
    show.files.filter(f => f.kind !== 'audio').forEach(f => o.push([f.id, `${f.kind === 'image' ? '🖼' : '🎞'} ${f.name}`]));
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
      rt.devices.out = list.filter(d => d.kind === 'audiooutput' && d.deviceId !== 'communications').map(d => ({ id: d.deviceId, label: d.label || 'Sound output' }));
    } catch (e) { console.warn(e); }
  }
  /* headphone / monitor output (e.g. the SSL 2, feeding a loudness meter): remembered by name, because Windows
     gives devices new ids each time the program starts */
  function outChoices() {
    const list = rt.devices.out || [];
    return list.filter(d => d.id !== 'default').map(d => [d.label + '|' + list.filter(x => x.label === d.label).indexOf(d), d.label]);
  }
  async function applyOutput(quiet) {
    const o = settings.monitorOut;
    const list = rt.devices.out || [];
    let dev = null;
    if (o && o.label) { const same = list.filter(d => d.label === o.label); dev = same[o.idx || 0] || same[0] || null; }
    try {
      await mixer.setOutput(dev ? dev.id : '');
      rt.outNote = o && o.label && !dev ? `“${o.label}” not found — using the Windows default for now` : '';
    } catch (e) { rt.outNote = e.message; if (!quiet) toast('Could not switch the sound output: ' + e.message, 'error'); }
  }
  /* program playback (separate from the headphones): the program sound goes to this device all the time */
  async function applyPlayback(quiet) {
    const o = settings.playbackOut;
    const list = rt.devices.out || [];
    let dev = null;
    if (o && o.label) { const same = list.filter(d => d.label === o.label); dev = same[o.idx || 0] || same[0] || null; }
    try {
      await mixer.setPlayback(dev ? dev.id : null, settings.playbackGain ?? 0);
      rt.playNote = o && o.label && !dev ? `“${o.label}” not found — program playback is off until it is plugged in` : '';
    } catch (e) { rt.playNote = e.message; if (!quiet) toast('Could not switch the program playback: ' + e.message, 'error'); }
  }
  navigator.mediaDevices && navigator.mediaDevices.addEventListener('devicechange', async () => {
    await refreshDevices();
    resolveDevices();
    applyOutput(true);
    applyPlayback(true);
    if (!rt.nativeTest) for (const c of show.cameras) if (!rt.cams.has(c.id) && rt.devices.video.find(d => d.id === c.deviceId)) openCamera(c);
    for (const a of show.audio.inputs) if (!mixer.strips.has(a.id) && rt.devices.audio.find(d => d.id === a.deviceId)) openAudioInput(a, true);
    refresh('inputs');
  });
  function closeCamera(id) {
    if (NAT.on) { natCloseCamera(id); engine.removeSource(id); return; }
    const c = rt.cams.get(id);
    if (c) { c.stream.getTracks().forEach(t => t.stop()); c.v.remove(); rt.cams.delete(id); }
    engine.removeSource(id);
  }
  rt.camNote = new Map();
  async function openCamera(cam) {
    if (NAT.on) { natOpenCamera(cam); return; }
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
      // 1080i: the card gives whole frames at half the field rate (1080i59.94 → 29.97), blended so lines do not comb
      const fps = cam.signal === 'i' && +cam.fps > 30 ? +cam.fps / 2 : +cam.fps || 0;
      if (cam.signal === 'i') engine.deint.add(cam.id); else engine.deint.delete(cam.id);
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
        setTimeout(() => { if (camById(cam.id) && !rt.nativeTest) refreshDevices().then(() => openCamera(cam)); }, 3000);
      });
    } catch (e) {
      rt.camStatus.set(cam.id, { ok: false, text: e.name === 'NotReadableError' ? 'Device busy (close other apps using it)' : `Not available: ${e.message || e.name}` });
    }
    refreshInputStatus();
  }

  /* ================= native engine (OBS-style) =================
     A separate program captures the cameras itself, mixes the program on its own steady clock (locked to the camera
     on air) and feeds YouTube and the recording. This window still does everything you see and touch: it tells the
     engine what is on air and sends it the graphics, captions and sound; the engine sends back small camera pictures. */
  const NAT = { on: false, ready: false, devices: null, cams: new Map(), M: null, force: new Map(), tried: new Map() }; // force / tried: 1080i vs 1080p chosen automatically
  rt.eng = null; // NAT while the native engine is in use
  const natW = () => settings.output.width || 1920, natH = () => settings.output.height || 1080;
  // the size a camera is captured at: the output size up to 1080p; for 4K / 1440p output the camera's own size (Inputs → resolution)
  const natCap = cam => natH() <= 1080 ? [natW(), natH()] : ({ 2160: [3840, 2160], 1080: [1920, 1080], 720: [1280, 720] }[(cam && cam.res) || '1080'] || [1920, 1080]);
  const fpsND = fps => fps === 59.94 ? [60000, 1001] : fps === 29.97 ? [30000, 1001] : fps === 23.98 ? [24000, 1001] : [Math.round(fps * 1000), 1000];
  const hexRGB = h => { const m = /^#?([0-9a-f]{6})$/i.exec(h || ''); const n = m ? parseInt(m[1], 16) : 0; return [n >> 16 & 255, n >> 8 & 255, n & 255]; };
  // a card's formats at exactly the output size and rate (as in the native test), best first
  function natExact(v, loose, cam, rateOverride) {
    const [W, H] = natCap(cam), t = rateOverride || settings.output.fps || 59.94, tol = loose ? 0.1 : 0.05, near = f => Math.abs(f - t) < tol;
    const FMT = ['uyvy422', 'yuyv422', 'nv12', 'yuv420p', 'v210'], r = m => (FMT.indexOf(m.fmt) + 10) % 10;
    return (v.modes || []).filter(m => m.w === W && m.h === H && (near(m.maxFps) || near(m.minFps) || (t > m.minFps && t < m.maxFps))).sort((a, b) => r(a) - r(b));
  }
  // 60 output with 59.94 cards (or 30 / 29.97): still usable, one repeated frame about every 17 s — and said so
  const natFits = (v, cam) => natExact(v, false, cam).length ? natExact(v, false, cam) : natExact(v, true, cam);
  /* the card a camera uses: the one chosen in Inputs, or the same card the classic engine used (same name and place
     in the list — e.g. “Blackmagic WDM Capture” 2 and 3), or the next free card that has the right format */
  function natCard(cam) {
    const list = (NAT.devices && NAT.devices.video) || [];
    let v = null;
    if (cam.native && cam.native.name) v = list.find(x => x.name === cam.native.name && x.n === (cam.native.n || 0)) || null;
    if (!v) {
      const taken = new Set([...NAT.cams].filter(([id]) => id !== cam.id).map(([, c]) => c.key)), free = x => natFits(x, cam).length && !taken.has(x.name + '#' + x.n);
      const same = list.filter(x => x.name === cam.deviceLabel);
      v = (cam.deviceIdx !== undefined && same.find(x => x.n === cam.deviceIdx && free(x))) || same.find(free) || list.find(free) || null;
    }
    if (!v) return null;
    const plan = natPlan(v, cam, natForce(cam));
    if (plan.deint) {
      const m = plan.mode, cap = natCap(cam), out = settings.output.fps || 59.94;
      return { name: v.name, n: v.n, w: cap[0], h: cap[1], fps: plan.deint === 'field' ? out : +m.maxFps.toFixed(2), capFps: +m.maxFps.toFixed(2), deint: plan.deint, pixFmt: m.kind === 'pixel_format' ? m.fmt : null, vcodec: m.kind === 'vcodec' ? m.fmt : null, exact: true, key: v.name + '#' + v.n, label: plan.label };
    }
    const m = natFits(v, cam)[0], cap = natCap(cam);
    if (m && !natExact(v, false, cam).length) logEvent('NATIVE', `warning: ${v.name} ${v.n + 1} has no ${settings.output.fps} fps — capturing its ${(+m.maxFps.toFixed(2))} fps; set Settings → Video output → Frame rate to ${(+m.maxFps.toFixed(2))} for a perfectly smooth picture`);
    return { name: v.name, n: v.n, w: cap[0], h: cap[1], fps: m ? +m.maxFps.toFixed(2) : (settings.output.fps || 59.94), pixFmt: m && m.kind === 'pixel_format' ? m.fmt : null, vcodec: m && m.kind === 'vcodec' ? m.fmt : null, exact: !!m, key: v.name + '#' + v.n };
  }
  /* 1080i: an interlaced camera shows up on the card as whole frames at half its field rate (1080i59.94 = 29.97
     frames). Those are captured and deinterlaced (bwdif) back to full motion: 1080i59.94 → 59.94p (one picture per
     field), or to one picture per frame when the output itself is 25 / 29.97 / 30.
     cam.signal: 'auto' (default) | 'p' (progressive) | 'i' (interlaced). Automatic uses the progressive format when
     the card has it, the interlaced one when it has only that, and switches by itself when the picture says otherwise
     (combing seen, or no picture / black on the format it tried) — see natAuto. */
  const natForce = cam => (NAT.force.get(cam.id) || (cam.signal === 'i' ? 'i' : cam.signal === 'p' ? 'p' : null));
  function natPlan(v, cam, want) {
    const out = settings.output.fps || 59.94, P = natExact(v, false, cam), half = out > 30 ? natExact(v, false, cam, out / 2) : [];
    const iName = r => `1080i${(+(r * 2).toFixed(2))}`;
    if (want !== 'p') {
      if (out > 30 && half.length && (want === 'i' || !P.length)) return { deint: 'field', mode: half[0], label: `${iName(half[0].maxFps)} → ${out}p` };
      if (out <= 30 && P.length && want === 'i') return { deint: 'frame', mode: P[0], label: `${iName(P[0].maxFps)} → ${out}p` };
    }
    return { deint: null };
  }
  function natPreviewCams() { S.nativeSend({ cmd: 'preview', cam: { w: 384, h: 216, every: 3 }, cams: [...NAT.cams.keys()], pgm: { w: 0, h: 0, every: 0 } }); }
  function natOpenCamera(cam) {
    if (!engine.sources.has(cam.id) || engine.sources.get(cam.id).kind !== 'raw') engine.setRawSource(cam.id);
    if (!NAT.ready || !NAT.devices) { rt.camStatus.set(cam.id, { ok: false, text: 'Starting the native engine…' }); refreshInputStatus(); return; }
    const d = natCard(cam);
    if (!d) { const c = natCap(cam); rt.camStatus.set(cam.id, { ok: false, text: `No free capture card with ${c[0]}×${c[1]} at ${settings.output.fps} fps — choose one below` }); refreshInputStatus(); return; }
    const prev = NAT.cams.get(cam.id);
    if (prev && prev.key === d.key && prev.fmt === (d.pixFmt || d.vcodec) && prev.deint === (d.deint || null)) return; // already capturing it
    NAT.cams.set(cam.id, { key: d.key, fmt: d.pixFmt || d.vcodec, deint: d.deint || null, dev: d, since: performance.now(), bad: 0, comb: 0 });
    rt.camStatus.set(cam.id, { ok: false, text: `Connecting to ${d.name} ${d.n + 1}…` });
    S.nativeCamera(cam.id, d);
    if (cam.color) S.nativeSend(Object.assign({ cmd: 'color', id: cam.id }, cam.color));
    natPreviewCams();
    logEvent('NATIVE', `camera ${cam.name}: ${d.name} #${d.n + 1} · ${d.w}×${d.h} at ${d.capFps || d.fps}${d.deint ? ` interlaced (${d.label}, deinterlaced)` : ''} · ${d.pixFmt || d.vcodec || 'the card’s own format'}`);
    refreshInputStatus();
  }
  function natCloseCamera(id) { if (NAT.cams.delete(id) && NAT.ready) { S.nativeSend({ cmd: 'camera-close', id }); natPreviewCams(); } }
  if (S.onNative) S.onNative((h, payload) => {
    switch (h.ev) {
      case 'ready': NAT.ready = true; logEvent('ENGINE', `ready · ${h.w}×${h.h} · ${h.threads} threads`); natResync(); break;
      case 'cam-status': {
        const cam = camById(h.id), d = NAT.cams.get(h.id);
        rt.camStatus.set(h.id, { ok: h.ok, text: h.ok ? (d && d.dev.deint ? `${d.dev.label} · deinterlaced · native (${d.dev.name} ${d.dev.n + 1})` : `${d ? d.dev.w : natW()}×${d ? d.dev.h : natH()} · ${settings.output.fps} fps · native${d ? ` (${d.dev.name} ${d.dev.n + 1})` : ''}`) : h.text });
        refreshInputStatus();
        if (cam) logEvent('NATIVE', `camera ${cam.name}: ${h.ok ? 'picture is coming in' : h.text}`);
        break;
      }
      case 'cam-frame': if (payload && NAT.cams.has(h.id)) engine.rawPatch(h.id, { full: true, w: h.w, h: h.h, data: payload }); break;
      case 'stats': rt.engStats = h; natAuto(h); break;
      case 'audio-port-ok': NAT.portOK = true; logEvent('ENGINE', 'sound goes straight from the sound thread to the engine'); break;
      case 'log': logEvent('ENGINE', h.line); break;
      case 'exit':
        if (NAT.on) { NAT.ready = false; NAT.cams.clear(); logEvent('ENGINE', `stopped (${h.error || 'code ' + h.code}) — restarting`); toast('The native engine stopped — restarting it…', 'error'); }
        break;
    }
  });
  async function natStart() {
    if (!S.nativeStart) return false;
    const [num, den] = fpsND(settings.output.fps || 59.94);
    const r = await S.nativeStart({ w: natW(), h: natH(), fpsNum: num, fpsDen: den, moveSpeed: settings.moveSpeed ?? 0.12 });
    if (!r || r.error) { toast(`Native engine: ${r ? r.error : 'no answer'} — using the classic engine.`, 'error'); logEvent('ENGINE', `could not start: ${r ? r.error : 'no answer'}`); return false; }
    NAT.on = true; rt.eng = NAT;
    mixer.enablePcmTap((pcm, rate) => { if (NAT.ready) S.nativeAudio(rate, pcm); }).then(() => {
      // the sound goes straight from the sound thread to the engine; if that line does not work, through the window
      if (!S.isApp || NAT.portOK) return;
      const ch = new MessageChannel();
      window.postMessage('ls-native-audio-port', '*', [ch.port2]);
      mixer.pcmTapPort(ch.port1);
      setTimeout(() => { if (NAT.on && !NAT.portOK) { mixer.pcmTapPort(null); logEvent('ENGINE', 'sound goes to the engine through the window (the direct line did not answer)'); } }, 4000);
    }).catch(e => logEvent('ENGINE', 'sound could not be connected: ' + e.message));
    if (!NAT.devices) S.nativeDevices().then(d => {
      NAT.devices = d || { video: [] };
      for (const v of NAT.devices.video) logEvent('NATIVE', `card ${v.name} #${v.n + 1}: ${(v.modes || []).length} formats${natExact(v).length ? ` · has ${natW()}×${natH()} at ${settings.output.fps} ✓` : ''}`);
      natResync(); refresh('inputs');
    }).catch(() => { NAT.devices = { video: [] }; });
    engine.onFrame = natFrame;
    logEvent('ENGINE', 'native engine (OBS-style) started');
    return true;
  }
  async function natStop() {
    NAT.on = false; NAT.ready = false; rt.eng = null; engine.onFrame = null; NAT.M = null;
    mixer.disablePcmTap();
    for (const id of [...NAT.cams.keys()]) { NAT.cams.delete(id); engine.removeSource(id); }
    if (S.nativeStop) await S.nativeStop();
    logEvent('ENGINE', 'native engine stopped — classic engine');
  }
  async function switchEngine(v) {
    for (const c of show.cameras) closeCamera(c.id);
    if (v === 'native') { if (NAT.on) await natStop(); if (!(await natStart())) { settings.output.engine = 'classic'; saveSettings(); } }
    else if (NAT.on) await natStop();
    vstApplyD();
    await wait(1600); // the cards need a moment before another program can open them (24 Nov: “device already in use”)
    for (const c of show.cameras) openCamera(c);
    refreshAll();
  }
  // everything is sent again (after a start or restart of the engine)
  function natAuto(st) {
    for (const [id, c] of NAT.cams) {
      const cam = camById(id), s2 = st.cams && st.cams[id];
      if (!cam || !s2 || (cam.signal && cam.signal !== 'auto')) continue;
      const age = performance.now() - c.since, out = settings.output.fps || 59.94;
      // whole frames that are combed: the camera is interlaced → deinterlace them
      c.comb = s2.ok && s2.comb > 3 ? c.comb + 1 : 0;
      if (!c.deint && c.comb >= 3) {
        NAT.force.set(id, 'i');
        logEvent('NATIVE', `camera ${cam.name}: the picture is interlaced (combing ${s2.comb}‰) — deinterlacing it`);
        toast(`${cam.name}: interlaced signal (1080i) recognised — deinterlacing it.`, 'ok');
        natOpenCamera(cam); continue;
      }
      // no picture, or only black, on the format tried: the camera may send the other kind (1080i vs 1080p)
      c.bad = (!s2.ok || s2.dark) && age > 3000 ? c.bad + 1 : 0;
      c.good = s2.ok && !s2.dark ? (c.good || 0) + 1 : 0;
      if (c.good >= 10) NAT.tried.delete(id); // a good picture again: free to try again next time
      const tried = NAT.tried.get(id) || new Set();
      if (c.bad >= 5 && out > 30 && !tried.has('done')) {
        tried.add(c.deint ? 'i' : 'p'); NAT.tried.set(id, tried);
        const other = c.deint ? 'p' : 'i', v = (NAT.devices.video || []).find(x => x.name + '#' + x.n === c.key);
        if (!tried.has(other) && v && (other === 'p' ? natExact(v, false, cam).length : natExact(v, false, cam, out / 2).length)) {
          NAT.force.set(id, other);
          logEvent('NATIVE', `camera ${cam.name}: no picture as ${c.deint ? '1080i' : '1080p'} — trying ${other === 'i' ? '1080i' : '1080p'}`);
          natOpenCamera(cam);
        } else {
          tried.add('done');
          logEvent('NATIVE', `camera ${cam.name}: no picture as 1080p or 1080i — check the camera, the cable and the card's input`);
          if (NAT.force.has(id)) { NAT.force.delete(id); natOpenCamera(cam); }
        }
      }
    }
  }
  function natResync() {
    if (!NAT.ready) return;
    NAT.M = { pid: undefined, sig: '', trans: null, black: null, webs: new Map(), labels: new Map(), stills: new Map(), videos: new Map(), bands: new Map(), noted: new Set() };
    for (const w of show.webs) S.nativeWeb(w.id, null);
    if (!NAT.devices) return; // the cameras once the cards are known
    NAT.cams.clear();
    for (const c of show.cameras) natOpenCamera(c);
    natPreviewCams();
  }
  function natNote(M, key, text) { if (!M.noted.has(key)) { M.noted.add(key); logEvent('NATIVE', text); } }
  const natCanvas = (() => { let c = null; return (w, h) => { if (!c) { const cv = document.createElement('canvas'); c = { cv, ctx: cv.getContext('2d', { willReadFrequently: true }) }; } if (c.cv.width !== w || c.cv.height !== h) { c.cv.width = w; c.cv.height = h; } return c; }; })();
  // the pixels of a picture (straight alpha RGBA), at most 3840 wide
  function natPixels(el2) {
    const nw = el2.naturalWidth || el2.videoWidth || el2.width, nh = el2.naturalHeight || el2.videoHeight || el2.height;
    if (!nw || !nh) return null;
    const s = Math.min(1, 3840 / Math.max(nw, nh)), w = Math.max(2, Math.round(nw * s)), h = Math.max(2, Math.round(nh * s));
    const c = natCanvas(w, h); c.ctx.clearRect(0, 0, w, h); c.ctx.drawImage(el2, 0, 0, w, h);
    return { w, h, px: new Uint8Array(c.ctx.getImageData(0, 0, w, h).data.buffer) };
  }
  function natStill(M, id, so) {
    const ver = so.ver || 0, prev = M.stills.get(id);
    if (prev && prev.el === so.el && (prev.ver === ver || performance.now() - prev.at < 1000)) return; // a slide that redraws itself: at most once a second
    const p = natPixels(so.el);
    if (!p) return;
    S.nativeSend({ cmd: 'still', id, w: p.w, h: p.h }, p.px);
    M.stills.set(id, { el: so.el, ver, at: performance.now() });
  }
  // the engine's name for one of this window's sources (sent to it the first time)
  function natSource(M, src) {
    if (!src) return null;
    if (/^#[0-9a-f]{6}$/i.test(src)) return src; // a plain colour
    if (camById(src)) return src;
    const f = fileById(src), m = f && rt.files.get(src);
    if (f && f.kind === 'video') {
      if (!m || !m.el) return null;
      if (M.videos.get(src) !== m.el) {
        M.videos.set(src, m.el);
        S.nativeSend({ cmd: 'video', id: src, path: f.path, loop: !!f.loop });
        if (f.color) S.nativeSend(Object.assign({ cmd: 'color', id: src }, f.color));
        const v = m.el, st = () => { if (NAT.M === M && M.videos.get(src) === v) S.nativeSend({ cmd: 'video-state', id: src, playing: !v.paused && !v.ended, t: v.currentTime }); };
        for (const ev of ['play', 'playing', 'pause', 'seeked', 'ended']) v.addEventListener(ev, st);
        st();
      }
      return src;
    }
    const so = engine.sources.get(src);
    if (so && so.el && so.kind === 'image') { natStill(M, src, so); return src; }
    return null;
  }
  function natBase(M, id) {
    const sh = id ? getShot(id) : null;
    if (!sh || !sh.main || !sh.main.source) return null;
    const src = natSource(M, sh.main.source);
    if (!src) { natNote(M, 'src' + sh.id, `“${sh.name}”: its picture is not in the native engine yet`); return null; }
    const fr = sh.main.frame || {};
    const b = { key: sh.id, src, zoom: fr.zoom || 1, x: fr.x ?? 0.5, y: fr.y ?? 0.5 };
    const g = window.LiveEngine.greenOf(sh);
    if (g) {
      const bg = natSource(M, g.bg);
      if (!bg && g.bg) natNote(M, 'gbg' + sh.id, `“${sh.name}”: the green screen background is not in the native engine yet — black for now`);
      b.green = { cb: +g.cb.toFixed(4), cr: +g.cr.toFixed(4), sim: +g.sim.toFixed(4), smooth: +g.smooth.toFixed(4), spill: +g.spill.toFixed(4), bg: bg ? { src: bg } : null };
    }
    const p = sh.pip;
    if (p && p.enabled && p.source) {
      const ps = natSource(M, p.source);
      if (ps) {
        const r = window.LiveEngine.pipRect(p, engine.W, engine.H), pf = p.frame || {};
        b.pip = { key: sh.id + ':p', src: ps, zoom: pf.zoom || 1, x: pf.x ?? 0.5, y: pf.y ?? 0.5, rect: r.map(v => +v.toFixed(4)), border: p.border !== false };
      } else natNote(M, 'pip' + sh.id, `“${sh.name}”: the small picture is not in the native engine yet`);
    }
    return b;
  }
  // the rows a caption covers (worked out once per caption, from its final look)
  function natBand(M, L) {
    const key = L.key || '';
    if (M.bands.has(key)) return M.bands.get(key);
    const W = engine.W, H = engine.H, c = natCanvas(W, H);
    c.ctx.setTransform(1, 0, 0, 1, 0, 0); c.ctx.clearRect(0, 0, W, H);
    window.LiveEngine.drawLabel(c.ctx, W, H, L.data, 1, false);
    const a = c.ctx.getImageData(0, 0, W, H).data;
    let y0 = -1, y1 = -1;
    for (let y = 0; y < H; y++) { const row = y * W * 4; for (let x = 3; x < W * 4; x += 8) if (a[row + x]) { if (y0 < 0) y0 = y; y1 = y; break; } }
    let band = null;
    if (y0 >= 0) { const m = Math.round(H * 0.03) + 16, t = Math.max(0, y0 - m) & ~1, b = Math.min(H, y1 + 1 + m); band = { y: t, h: Math.min(H - t, b - t + 1) & ~1 }; }
    M.bands.set(key, band);
    return band;
  }
  // every frame of this window: tell the engine what changed
  function natFrame(now) {
    const M = NAT.M;
    if (!NAT.ready || !M) return;
    const W = natW(), H = natH();
    // program
    const tr = engine.trans;
    if (tr && tr !== M.trans) {
      M.trans = tr;
      const b = natBase(M, tr.to);
      S.nativeSend({ cmd: 'program', base: b, ms: Math.max(1, tr.dur - (now - tr.start)) });
      M.pid = tr.to; M.sig = JSON.stringify(b);
    } else if (!tr) {
      M.trans = null;
      const b = natBase(M, engine.programId), sig = JSON.stringify(b);
      if (engine.programId !== M.pid || sig !== M.sig) { S.nativeSend({ cmd: 'program', base: b, ms: 0 }); M.pid = engine.programId; M.sig = sig; }
    }
    if (engine.black !== M.black) { M.black = engine.black; S.nativeSend({ cmd: 'black', on: engine.black.to === 1, ms: engine.black.dur }); }
    // graphics: web pages (pictures come from the page itself) and pictures (sent once)
    let k = 0; const seen = new Set();
    for (const [id, w] of engine.webs) {
      k++; seen.add(id);
      const d = w.data || {}, r = d.rect || [0, 0, 1, 1], kc = d.key && d.key.on ? hexRGB(d.key.color) : null;
      const cfg = { x: Math.round(r[0] * W), y: Math.round(r[1] * H), w: Math.round(r[2] * W), h: Math.round(r[3] * H), z: 10 + k, opacity: d.opacity ?? 1, fadeMs: d.fadeMs ?? 400,
        key: kc ? { on: true, r: kc[0] / 255, g: kc[1] / 255, b: kc[2] / 255, tol: d.key.tol ?? 0.15 } : { on: false }, visible: w.target > 0 };
      const sig = JSON.stringify(cfg), prev = M.webs.get(id) || {};
      const so = engine.sources.get(d.src || id);
      if (so && so.kind === 'raw') { if (prev.sig !== sig) { S.nativeWeb(id, cfg); M.webs.set(id, { sig, raw: true }); } continue; }
      if (!so || !so.el || !so.ready) continue; // not loaded yet
      const pver = (d.src || id) + ':' + (so.ver || 0);
      if (prev.pver !== pver) {
        const p = natPixels(so.el);
        if (!p) continue;
        S.nativeSend(Object.assign({ cmd: 'overlay', id: 'pic:' + id, sw: p.w, sh: p.h, premult: false }, cfg), p.px);
        M.webs.set(id, { sig, pver });
      } else if (prev.sig !== sig) { S.nativeSend(Object.assign({ cmd: 'overlay-set', id: 'pic:' + id }, cfg)); M.webs.set(id, { sig, pver }); }
    }
    for (const [id, v] of M.webs) if (!seen.has(id)) { M.webs.delete(id); if (v.raw) S.nativeWeb(id, null); else S.nativeSend({ cmd: 'overlay-remove', id: 'pic:' + id }); }
    // captions: every step of their animation (about 30 a second), then nothing while they stay up
    let li = 0;
    for (const [id, L] of engine.labels) {
      li++;
      const state = L.alpha > 0 && L.data && L.shown ? L.shown + '|' + L.key : null, prev = M.labels.get(id);
      if (state === (prev ? prev.state : null)) continue;
      if (!state) { S.nativeSend({ cmd: 'overlay-remove', id: 'lbl:' + id }); M.labels.delete(id); continue; }
      if (!L.shown.startsWith('full') && prev && now - prev.at < 30) continue;
      const band = natBand(M, L);
      if (!band || band.h < 2) continue;
      const px = L.ctx.getImageData(0, band.y, engine.W, band.h).data, k = H / engine.H; // (drawn at ≤1080p; 4K / 1440p: scaled up by the engine)
      S.nativeSend({ cmd: 'overlay', id: 'lbl:' + id, z: 1000 + li, sw: engine.W, sh: band.h, x: 0, y: Math.round(band.y * k) & ~1, w: W, h: Math.round(band.h * k) & ~1, premult: false, alpha: 1, fadeMs: 0 }, new Uint8Array(px.buffer));
      M.labels.set(id, { state, at: now });
    }
    for (const [id] of M.labels) if (!engine.labels.has(id)) { S.nativeSend({ cmd: 'overlay-remove', id: 'lbl:' + id }); M.labels.delete(id); }
  }

  /* ================= files (intro / ending / clips / images) ================= */
  async function urlForFile(f) {
    if (S.readMedia) {
      const bytes = await S.readMedia(f.path);
      const ext = (f.path.split('.').pop() || '').toLowerCase();
      const types = { mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska', mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', flac: 'audio/flac', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', jfif: 'image/jpeg', bmp: 'image/bmp', avif: 'image/avif', webp: 'image/webp', gif: 'image/gif' };
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
      } else if (f.kind === 'audio') {
        // music: sound only, played under a shot (no picture)
        v = el('audio', { preload: 'auto' });
        v.src = url; v.loop = !!f.loop;
        $('#sourceBin').append(v);
        await new Promise((res, rej) => {
          v.addEventListener('loadedmetadata', res, { once: true });
          v.addEventListener('error', () => rej(new Error('This music file can\'t be played. Use MP3, WAV or M4A.')), { once: true });
        });
        v.pause(); v.currentTime = 0;
        mixer.attachMedia(f.id, v);
        v.addEventListener('ended', () => onMediaEnded(f.id));
        rt.files.set(f.id, { ok: true, el: v, url, text: `♪ music · ${fmtShort(v.duration)}`, duration: v.duration });
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
      const kind = /\.(png|jpe?g|jfif|webp|gif|bmp|avif)$/i.test(p.name) ? 'image' : /\.(mp3|wav|m4a|aac|ogg|oga|opus|flac|wma)$/i.test(p.name) ? 'audio' : 'video';
      const f = { id: uid('file'), name: p.name.replace(/\.[^.]+$/, ''), path: p.path, kind, loop: false, color: clone(NEUTRAL) };
      show.files.push(f); added.push(f);
      await loadFile(f);
    }
    if (added.length) { changed(); refreshAll(); }
    return added;
  }
  // the files a shot plays: its video(s) and the music under it
  const mediaOf = shot => shot ? [shot.main && shot.main.source, shot.pip && shot.pip.enabled ? shot.pip.source : null, shot.music || null]
    .filter(id => id && ['video', 'audio'].includes((fileById(id) || {}).kind)) : [];

  /* sound follows the shot: what the stream hears while a shot is live.
     auto = a video plays with only its own sound, everything else uses the cameras / sound desk */
  const SOUND_MODES = [['auto', 'Automatic — videos & music: their own sound · everything else: sound desk'], ['video', 'Only the video / music'], ['live', 'Only the sound desk / cameras'], ['both', 'Both together']];
  function soundMode(sh) {
    // the holding slide: its music (if any), and the sound desk only when it is not muted
    if (sh && sh.role === 'hold') return SV().hold.mute !== false ? 'video' : sh.music ? 'both' : 'live';
    const m = (sh && sh.sound) || 'auto';
    if (m !== 'auto') return m;
    const main = sh && sh.main && sh.main.source;
    if (main && (fileById(main) || {}).kind === 'video') return 'video';
    if (sh.music && (fileById(sh.music) || {}).kind === 'audio') return 'video'; // a slide with music: just the music
    return mediaOf(sh).length ? 'both' : 'live'; // a video picture-in-picture over a camera keeps both
  }
  const liveInputsOn = sh => !!sh && soundMode(sh) !== 'video';
  const videoSoundOn = sh => !!sh && soundMode(sh) !== 'live';
  /* each shot's own mix: volume of its music, its video sound and the sound desk (dB; −40 = off) */
  const holdMuted = sh => !!sh && sh.role === 'hold' && SV().hold.mute !== false;
  const holdMusicOk = () => { const id = SV().hold.musicId; return !!(id && rt.files.get(id) && rt.files.get(id).ok); };
  const dbGain = db => db <= -40 ? 0 : Math.pow(10, db / 20);
  const mixOf = sh => Object.assign({ music: 0, video: 0, live: 0 }, sh && sh.mix);
  const mediaLevel = (sh, id) => videoSoundOn(sh) ? dbGain((fileById(id) || {}).kind === 'audio' ? mixOf(sh).music : mixOf(sh).video) : 0;
  const liveLevel = sh => liveInputsOn(sh) && !holdMuted(sh) ? dbGain(mixOf(sh).live) : 0;
  const loopFor = (sh, id) => sh.role === 'hold' ? SV().hold.musicLoop !== false
    : sh.role === 'close' ? !!(SV().end.mode === 'slide' && SV().end.musicLoop && id === sh.music)
    : !!(fileById(id) || {}).loop && !sh.role;
  // apply a shot's mix straight away if it is on air (after its sliders or music were changed)
  function refreshOnAir(sh) {
    if (sh && engine.programId === sh.id && !engine.inTransition) {
      const want = mediaOf(sh);
      for (const id of want) { const f = rt.files.get(id); if (f && f.el && f.el.paused) { f.el.loop = loopFor(sh, id); f.el.currentTime = 0; f.el.play().catch(() => {}); } }
      for (const [id, f] of rt.files) if (f.el && (f.el.tagName === 'AUDIO' || f.el.tagName === 'VIDEO') && !want.includes(id) && !f.el.paused && !f.cued && !f.pvManual) { mixer.setMediaLevel(id, 0, 150); setTimeout(() => { if (!mediaOf(getShot(engine.programId)).includes(id)) f.el.pause(); }, 200); }
      audioGate(150, sh.id);
      for (const id of want) mixer.setMediaLevel(id, mediaLevel(sh, id), 120);
    }
    updatePfl();
  }

  /* busy moments: anything that holds up the program thread for more than 50 ms (shown in the frame monitor) */
  try {
    new PerformanceObserver(list => {
      const L = rt.longTasks || (rt.longTasks = []);
      for (const e of list.getEntries()) { L.push([performance.now(), e.duration]); rt.longWin = rt.longWin || []; rt.longWin.push(e.duration); }
      const cut = performance.now() - 60000; while (L.length && L[0][0] < cut) L.shift();
    }).observe({ entryTypes: ['longtask'] });
  } catch (e) { /* not available */ }
  /* the on-screen size of a canvas, remembered and only re-measured when it actually changes size */
  const sizeCache = new WeakMap();
  const sizeObs = new ResizeObserver(es => { for (const e of es) sizeCache.set(e.target, { width: e.contentRect.width, height: e.contentRect.height }); });
  function cssSize(c) {
    let r = sizeCache.get(c);
    if (!r) { const b = c.getBoundingClientRect(); r = { width: b.width, height: b.height }; sizeCache.set(c, r); sizeObs.observe(c); }
    return r;
  }
  // write text / styles only when they change (each write makes the browser redo the page layout)
  const setText = (n, t) => { t = T(t); if (n.textContent !== t) n.textContent = t; };

  /* ================= switching ================= */
  function setPreview(id) {
    rt.previewId = id; engine.previewId = id;
    const onAir = mediaOf(getShot(engine.programId));
    for (const m of mediaOf(getShot(id))) {
      const f = rt.files.get(m);
      if (f && f.el && !onAir.includes(m) && f.el.paused) f.el.currentTime = 0;
    }
    updatePfl();
    renderTally();
  }
  function startProgram(toId, fromId, ms) {
    const to = getShot(toId), from = getShot(fromId);
    const toM = mediaOf(to), fromM = mediaOf(from);
    for (const id of toM) {
      if (fromM.includes(id)) { mixer.setMediaLevel(id, mediaLevel(to, id), Math.max(60, ms)); continue; }
      const f = rt.files.get(id);
      if (f && f.el) {
        f.el.loop = loopFor(to, id);
        f.el.currentTime = 0; f.el.play().catch(() => {}); mixer.setMediaLevel(id, mediaLevel(to, id), Math.max(60, ms));
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
    // a title / graphic cued in Preview: TAKE shows it (or hides it, if it was already on)
    if (rt.armedGfx && msOverride === undefined) { const it = gfxItems().find(x => x.id === rt.armedGfx); armGfx(null); if (it) { it.toggle(); refresh('labels'); } return; }
    if (engine.inTransition) return;
    const to = rt.previewId, from = engine.programId;
    if (!to || to === from) return;
    const ms = kind === 'cut' ? 0 : (msOverride !== undefined ? msOverride : show.transition.ms);
    for (const f of rt.files.values()) { f.cued = false; f.pvManual = false; } // a video that was previewed starts from the beginning on air
    startProgram(to, from, ms);
    if (ms) engine.fade(to, ms); else engine.cut(to);
    audioGate(ms, to);
    rt.previewId = from || to; engine.previewId = rt.previewId;
    rt.webSuppress.clear();
    refreshWebs();
    if (rt.pvListen) setPvListen(false); else updatePfl(); // once it is on air, the headphones go back to normal
    renderTally();
  }
  function takeShot(id, kind, ms) { if (!getShot(id) || id === engine.programId) return; setPreview(id); take(kind, ms); }
  // the stream is silent while the holding slide is on air (and during fade to black)
  function audioGate(ms, targetId) {
    const sh = getShot(targetId || (engine.trans ? engine.trans.to : engine.programId));
    // silent: fade to black (if set), or the holding slide when it is muted and has no music
    const silent = (engine.isBlack && settings.ftbAudio) || (holdMuted(sh) && !(sh.music && holdMusicOk()));
    // coming out of the holding slide, the sound fades in gently even on a hard cut
    if (!silent && rt.holdSilent && !holdMuted(sh)) ms = Math.max(ms || 0, SV().hold.audioFade ?? 1500);
    rt.holdSilent = holdMuted(sh);
    rt.gated = silent;
    mixer.fadeMaster(!silent, Math.max(50, ms || 300));
    const lv = liveLevel(sh);
    mixer.setLiveInputs(lv > 0, Math.max(60, ms || 0), lv);
  }
  function setBlack(on) {
    engine.setBlack(on, show.transition.ms || 500);
    audioGate(show.transition.ms || 500);
    renderTally();
  }
  function onMediaEnded(fileId) {
    const shot = getShot(engine.programId);
    if (!shot) return;
    const main = shot.main && shot.main.source, trigger = (fileById(main) || {}).kind === 'video' ? main : shot.music;
    if (fileId !== trigger) return;
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
    h.music = SV().hold.musicId && fileById(SV().hold.musicId) ? SV().hold.musicId : '';
    for (const [role, cfg, vname] of [['open', SV().start, 'Opening video'], ['close', SV().end, 'Closing video']]) {
      const slide = role === 'close' && cfg.mode === 'slide';
      const src = slide ? cfg.slideImg : cfg.videoId, name = slide ? 'Closing slide' : vname;
      let s = roleShot(role);
      if (!src || !fileById(src)) { if (s && s.id !== engine.programId) show.shots = show.shots.filter(x => x !== s); continue; }
      if (!s) { s = newShot(name, src, '#d97706'); s.role = role; show.shots.push(s); }
      s.main.source = src; s.name = name;
      s.music = slide && cfg.musicId && fileById(cfg.musicId) ? cfg.musicId : '';
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
    if (rt.service === 'closing') { serviceEnded(); return; } // pressing END SERVICE again finishes straight away
    syncRoleShots();
    clearEndTimer();
    const c = roleShot('close'), en = SV().end, ok = id => !!(id && rt.files.get(id) && rt.files.get(id).ok);
    if (c && ok(c.main.source)) {
      takeShot(c.id, 'auto', en.fadeMs); setServiceState('closing');
      // a closing slide with no music (or with looping music) has no natural end: it stays up for the time you chose
      clearTimeout(rt.closeTimer); rt.closeEndAt = 0;
      if (en.mode === 'slide' && (!ok(c.music) || en.musicLoop) && (en.slideSecs || 60) < 36000) {
        rt.closeEndAt = Date.now() + (en.slideSecs || 60) * 1000;
        rt.closeTimer = setTimeout(() => { if (rt.service === 'closing') serviceEnded(); }, (en.slideSecs || 60) * 1000);
      }
    } else serviceEnded();
  }
  function serviceEnded() {
    const e = SV().end;
    clearTimeout(rt.closeTimer); rt.closeEndAt = 0;
    if (e.then === 'hold') { const go = () => engine.inTransition ? setTimeout(go, 50) : takeShot('shot_hold', 'auto', e.fadeMs); go(); } // wait for a fade still running
    else {
      setBlack(true);
      // fading to black: the closing music / video sound fades out with the picture
      for (const m of mediaOf(getShot(engine.programId))) {
        mixer.setMediaActive(m, false, e.fadeMs);
        setTimeout(() => { const f = rt.files.get(m); if (f && f.el && engine.isBlack) f.el.pause(); }, e.fadeMs + 150);
      }
    }
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
      } else if (e.type === 'pic') {
        const pf = rt.files.get(e.file), im = pf && pf.ok && pf.el && pf.el.tagName === 'IMG' ? pf.el : null;
        const w = e.size, hh = im && im.naturalWidth ? w * im.naturalHeight / im.naturalWidth : w * 0.6, x0 = left(w);
        if (im) {
          g.save(); g.globalAlpha = e.opacity ?? 1;
          if (e.shadow) { g.shadowColor = 'rgba(0,0,0,.5)'; g.shadowBlur = 24; g.shadowOffsetY = 4; }
          if (e.round) { roundRectPath(g, x0, e.y, w, hh, Math.min(w, hh) * e.round / 200); g.clip(); }
          g.drawImage(im, x0, e.y, w, hh); g.restore();
        } else { g.strokeStyle = 'rgba(255,255,255,.5)'; g.setLineDash([10, 8]); g.lineWidth = 3; g.strokeRect(x0, e.y, w, hh); g.setLineDash([]); g.font = `400 28px ${font}`; g.textAlign = 'left'; g.fillStyle = '#fff'; g.fillText('picture not found', x0 + 14, e.y + 44); }
        boxes.push({ id: e.id, x: x0, y: e.y, w, h: hh });
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
          el('button', { class: 'btn small', style: 'margin:6px 0 12px 8px', onclick: async () => {
            const a2 = await addFiles(); const i = a2.find(f => f.kind === 'image');
            if (!i) { if (a2.length) toast('That file is not a picture. Use PNG or JPG (PNG keeps a see-through background).', 'error'); return; }
            const n = { id: uid('pic'), type: 'pic', name: '🖼 ' + i.name, file: i.id, x: 1500, y: 80, size: 300, align: 'left', opacity: 1, round: 0, on: true, custom: true };
            h.elements.push(n); sel = n.id; done(); draw(); setTimeout(drawHold, 400); setTimeout(drawHold, 1500);
          } }, '+ Add picture / logo'),
          el('h3', null, e.name),
          e.type === 'text' ? el('div', { class: 'field' }, el('span', null, 'Text'), el('input', { type: 'text', value: e.text, oninput: ev => { e.text = ev.target.value; done(); } })) : null,
          e.type === 'pic' ? [
            el('div', { class: 'field' }, el('span', null, 'Picture'), select(show.files.filter(f => f.kind === 'image').map(f => [f.id, f.name]), e.file, v => { e.file = v; e.name = '🖼 ' + (fileById(v) || {}).name; done(); draw(); })),
            slider({ label: 'Size', min: 40, max: 1920, step: 2, value: e.size, fmt: v => `${v}`, onInput: v => { e.size = v; done(); } }),
            slider({ label: 'See-through', min: 0.05, max: 1, step: 0.01, value: e.opacity ?? 1, reset: 1, fmt: v => `${Math.round(v * 100)}%`, onInput: v => { e.opacity = v; done(); } }),
            slider({ label: 'Round corners', min: 0, max: 100, step: 1, value: e.round || 0, reset: 0, fmt: v => v ? `${v}` : 'off', onInput: v => { e.round = v; done(); } }),
            el('div', { style: 'margin:6px 0' }, check(' Shadow', !!e.shadow, v => { e.shadow = v; done(); }))] : null,
          e.type !== 'bar' && e.type !== 'pic' ? slider({ label: 'Size', min: 16, max: 320, step: 1, value: e.size, fmt: v => `${v}`, onInput: v => { e.size = v; done(); } }) : null,
          e.type === 'bar' ? slider({ label: 'Length', min: 20, max: 1200, step: 2, value: e.w, fmt: v => `${v}`, onInput: v => { e.w = v; done(); } }) : null,
          e.type === 'bar' ? slider({ label: 'Thickness', min: 2, max: 40, step: 1, value: e.h, fmt: v => `${v}`, onInput: v => { e.h = v; done(); } }) : null,
          slider({ label: 'Left ↔ right', min: -400, max: 1920, step: 1, value: e.x, fmt: v => `${v}`, onInput: v => { e.x = v; done(); } }),
          slider({ label: 'Up ↕ down', min: -200, max: 1080, step: 1, value: e.y, fmt: v => `${v}`, onInput: v => { e.y = v; done(); } }),
          el('div', { class: 'row wrap', style: 'gap:10px;margin:8px 0' },
            select([['left', 'Align left'], ['center', 'Centre'], ['right', 'Align right']], e.align || 'left', v => { e.align = v; done(); }),
            e.type === 'text' ? select([[300, 'Light'], [400, 'Regular'], [600, 'Semi-bold'], [700, 'Bold'], [800, 'Extra bold']], e.weight, v => { e.weight = +v; done(); }) : null,
            e.type !== 'pic' ? colorIn('Colour', e.color || h.accent, v => { e.color = v; done(); }) : null),
          e.type === 'text' ? el('div', { class: 'row wrap', style: 'gap:14px' }, check(' ALL CAPS', e.upper, v => { e.upper = v; done(); }), check(' Shadow', e.shadow !== false, v => { e.shadow = v; done(); }),
            el('label', { class: 'inline' }, 'Letter spacing', el('input', { type: 'number', value: e.spacing || 0, min: 0, max: 30, style: 'width:64px', oninput: ev => { e.spacing = +ev.target.value || 0; done(); } }))) : null,
          e.type === 'clock' ? el('div', { class: 'row wrap', style: 'gap:14px' }, check(' Box behind the clock', e.card !== false, v => { e.card = v; done(); }), check(' Date / “starts in” line', e.label !== false, v => { e.label = v; done(); })) : null,
          e.custom ? el('button', { class: 'btn small danger', style: 'margin-top:10px', onclick: () => { h.elements = h.elements.filter(x => x !== e); sel = 'title'; done(); draw(); } }, e.type === 'pic' ? 'Remove this picture' : 'Delete this line') : null,
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
          el('div', { style: 'margin:10px 0' }, check(' Mute the cameras / sound desk while the holding slide is on air (its music still plays)', h.mute !== false, v => { h.mute = v; done(); refreshOnAir(getShot('shot_hold')); })),
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
  // the clock on the holding slide is redrawn every second only while the slide is on the Program / Preview or its
  // designer is open; otherwise every 10 s (enough for its shot tile) — redrawing a full-size slide is not free
  let holdStale = true, holdLazyAt = 0;
  setInterval(() => {
    const s2 = Math.floor(Date.now() / 1000);
    const shown = engine.usedRecently('hold', 1500) || !!document.querySelector('.hold-stage');
    if (shown) { if (s2 !== lastHoldSec || holdStale) { lastHoldSec = s2; holdStale = false; drawHold(); } }
    else if (Date.now() - holdLazyAt > 10000) { holdLazyAt = Date.now(); lastHoldSec = s2; holdStale = true; drawHold(); }
  }, 100);

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
      rt.speakerSwap = setTimeout(go, labelAnimMs(rt.speakerObj, true) + 80);
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
  /* ---------- one encoder for everything that goes out ----------
     The stream and the recording each ran their own MediaRecorder: the program picture was captured and encoded
     twice at the same time, which roughly doubled the load (the 22 Nov log: CPU 20% → 60–87% with both running).
     Now one MediaRecorder runs while anything is going out and the stream and the recording both take its output.
     Whoever starts later joins at the next keyframe (about once a second). */
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const concatU8 = (a, b) => { const n = new Uint8Array(a.length + b.length); n.set(a, 0); n.set(b, a.length); return n; };
  const Feed = {
    rec: null, subs: [],
    bitrate() { const o = settings.output; return clamp(Math.max(o.bitrate * 2000, (o.recordBitrate || 0) * 3000), 10e6, 30e6); },
    running() { return !!(this.rec && this.rec.state !== 'inactive'); },
    start(mime) {
      this.track = engine.videoTrack().clone();
      const ms = new MediaStream([this.track, ...mixer.stream().getAudioTracks()]);
      this.scan = new EbmlScanner(); this.offset = 0; this.pre = new Uint8Array(0); this.header = null; this.hist = []; this.chain = Promise.resolve();
      this.mime = mime;
      this.rec = new MediaRecorder(ms, { mimeType: mime, videoBitsPerSecond: this.bitrate(), audioBitsPerSecond: 510000, videoKeyFrameIntervalDuration: 1000 });
      // each piece is read right away (in parallel) and handled in order, so nothing piles up
      this.rec.ondataavailable = e => { if (!e.data || !e.data.size) return; const ab = e.data.arrayBuffer(); this.chain = this.chain.then(() => ab).then(b => this._data(new Uint8Array(b))).catch(() => {}); };
      for (const sub of this.subs) sub.joined = true; // whoever is here at the start gets everything from the beginning
      this.rec.start(250);
      logEvent('ENCODER', `shared encoder started (${(this.bitrate() / 1e6).toFixed(0)} Mbps, keyframe about every second)`);
    },
    _send(sub, u8) { const id = sub.id; sub.chain = sub.chain.then(() => S.outWrite(id, u8.buffer.byteLength === u8.length ? u8.buffer : u8.slice().buffer)).catch(() => {}); },
    _data(u8) {
      const at = this.offset; this.offset += u8.length;
      const evs = this.scan.push(u8);
      if (!this.header) { this.pre = concatU8(this.pre, u8); if (this.scan.headerEnd >= 0) { this.header = this.pre.slice(0, this.scan.headerEnd); this.pre = null; } }
      // keep the last few seconds, so a newcomer can begin exactly at a keyframe cluster (whose first video block
      // may only arrive in a later piece than the cluster's start — 24 Nov log: the recording began mid-cluster)
      this.hist.push({ at, u8 });
      while (this.hist.length > 32) this.hist.shift();
      for (const sub of this.subs) if (sub.joined && !sub.justJoined) this._send(sub, u8);
      for (const sub of this.subs) sub.justJoined = false;
      const key = evs.filter(e => e.type === 'key' && this.hist.length && e.offset >= this.hist[0].at).pop();
      if (key && this.header) {
        const waiting = this.subs.filter(sub => !sub.joined);
        if (waiting.length) {
          const parts = this.hist.filter(h => h.at + h.u8.length > key.offset);
          let tail = new Uint8Array(0);
          for (const h of parts) tail = concatU8(tail, h.at >= key.offset ? h.u8 : h.u8.subarray(key.offset - h.at));
          for (const sub of waiting) { this._send(sub, concatU8(this.header, tail)); sub.joined = true; sub.justJoined = false; if (sub.onJoin) sub.onJoin(true); }
        }
      }
    },
    // add an output; resolves true once it is receiving data (false if no keyframe came in time)
    join(id, mime) {
      const sub = { id, joined: false, chain: Promise.resolve(), t0: performance.now() };
      this.subs.push(sub);
      if (!this.running()) { this.start(mime); return Promise.resolve(true); }
      if (this.mime !== mime) { this.subs = this.subs.filter(x => x !== sub); return Promise.resolve(false); }
      return new Promise(res => {
        sub.onJoin = ok => { sub.onJoin = null; logEvent('ENCODER', `joined the shared encoder after ${Math.round(performance.now() - sub.t0)} ms`); res(ok); };
        setTimeout(() => { if (!sub.joined && sub.onJoin) { sub.onJoin = null; this.subs = this.subs.filter(x => x !== sub); res(false); } }, 5000);
      });
    },
    async leave(id) {
      const sub = this.subs.find(x => x.id === id);
      if (!sub) return;
      if (this.subs.length === 1 && this.running()) {
        // the last one out: stop the encoder so its final bytes are written
        const rec = this.rec; this.rec = null;
        await Promise.race([new Promise(res => { rec.addEventListener('stop', res, { once: true }); rec.stop(); }), wait(3000)]);
        await Promise.race([this.chain, wait(3000)]);
        if (this.track) this.track.stop();
        logEvent('ENCODER', 'shared encoder stopped');
      } else if (this.running()) {
        // hand over what has been encoded so far before letting go
        this.rec.requestData(); await wait(150); await Promise.race([this.chain, wait(1500)]);
      }
      this.subs = this.subs.filter(x => x !== sub);
      await Promise.race([sub.chain, wait(3000)]);
    }
  };

  /* own encoder settings for the stream and for the recording (Settings → Live stream quality / Recording quality,
     like Wirecast's encoder presets); kept in settings.output.liveAdv and settings.output.rec */
  const REC_DEF = () => ({ on: false, encoder: '', w: 0, h: 0, fps: 0, speed: '', profile: 'high', gop: 0, cbr: false, aligned: false, x264: '', channels: 2, rate: 48000, timecode: false });
  const ADV_KEY = { live: 'liveAdv', rec: 'rec' };
  const advSettings = kind => { const r = settings.output[ADV_KEY[kind]]; return r && r.on ? Object.assign(REC_DEF(), r) : null; };
  const SPEEDS = {
    x264: [['ultrafast', '1 - Ultra fast encoding'], ['superfast', '2 - Super fast encoding'], ['veryfast', '3 - Very fast encoding'], ['faster', '4 - Faster encoding'], ['fast', '5 - Fast encoding'], ['medium', '6 - Medium (best picture, most processor)']],
    nvenc: [['p1', '1 - Fastest'], ['p2', '2 - Faster'], ['p3', '3 - Fast'], ['p4', '4 - Medium'], ['p5', '5 - Slow (better picture)'], ['p6', '6 - Slower'], ['p7', '7 - Slowest (best picture)']],
    qsv: [['veryfast', '1 - Very fast'], ['faster', '2 - Faster'], ['fast', '3 - Fast'], ['medium', '4 - Medium'], ['slow', '5 - Slow'], ['slower', '6 - Slower'], ['veryslow', '7 - Very slow (best picture)']],
    amf: [['speed', '1 - Speed'], ['balanced', '2 - Balanced'], ['quality', '3 - Quality']]
  };
  const SPEED_DEF = { x264: 'veryfast', nvenc: 'p4', qsv: 'veryfast', amf: 'speed' };
  function recAdvText(r, enc) {
    const sp = (SPEEDS[enc] || []).find(x => x[0] === r.speed) || (SPEEDS[enc] || []).find(x => x[0] === SPEED_DEF[enc]) || ['', ''];
    return [enc, r.w && r.h ? `${r.w}×${r.h}` : 'program size', r.fps ? `${r.fps} fps` : 'program fps', sp[1], r.profile, r.gop ? `key frame every ${r.gop}` : 'key frame default',
      r.cbr ? 'strict CBR' : 'average bitrate', r.aligned ? 'aligned key frames' : '', r.x264 && enc === 'x264' ? `x264 ${r.x264}` : '', r.channels === 1 ? 'mono' : 'stereo', `${r.rate === 44100 ? '44.1' : '48'} kHz`, r.timecode ? 'timecode' : ''].filter(Boolean).join(' · ');
  }
  // the time of day as a timecode (non-drop), so an editor shows when each moment was recorded
  function timecodeNow(fps) {
    const d = new Date(), z = n => String(n).padStart(2, '0'), r = Math.round(fps || 30);
    return `${z(d.getHours())}:${z(d.getMinutes())}:${z(d.getSeconds())}:${z(Math.min(r - 1, Math.floor(d.getMilliseconds() / 1000 * r)))}`;
  }

  class Output {
    constructor(kind) { this.kind = kind; this.active = false; this.id = null; this.chain = Promise.resolve(); }
    async start() {
      const o = settings.output;
      if (rt.eng) { // native engine: it already has the finished picture and sound; FFmpeg is started next to it
        if (!rt.eng.ready) throw new Error('The native engine is still starting — try again in a moment.');
        const rec = advSettings(this.kind === 'stream' ? 'live' : 'rec'), enc0 = rec && rec.encoder ? rec.encoder : o.encoder;
        const fb = rt.encFallback && rt.encFallback.for === enc0 ? rt.encFallback.level : 0;
        const encoder = fb >= 2 ? 'x264' : enc0, safe = fb === 1;
        this.enc0 = enc0; this.conv = !!(rec && rec.fps > 0 && Math.abs(rec.fps - o.fps) > 0.1);
        const fx = vstMs(); // the master plug-ins put the sound this much behind: the picture waits for it
        const base = { engine: true, width: o.width, height: o.height, videoDelayMs: (o.videoDelayMs ?? 20) + fx, fps: o.fps, encoder, safe };
        if (fx) logEvent('ENCODER', `${this.kind}: picture delayed ${(o.videoDelayMs ?? 20) + fx} ms (sync ${o.videoDelayMs ?? 20} + plug-ins ${fx})`);
        const opts = this.kind === 'stream'
          ? Object.assign({ kind: 'stream', url: streamURL(), bitrate: o.bitrate, audioBitrate: o.audioBitrate, adv: rec }, base)
          : Object.assign({ kind: 'record', dir: settings.recordDir, name: show.showName, bitrate: o.recordBitrate, audioBitrate: o.recordAudioBitrate || 256, adv: rec, timecode: rec && rec.timecode ? timecodeNow(rec.fps || o.fps) : '' }, base);
        if (rec) logEvent('ENCODER', `${this.kind}: own encoder settings — ${recAdvText(rec, encoder)}`);
        const r = await S.outStart(opts);
        if (!r || r.error) throw new Error(r ? r.error : 'Encoder did not start');
        this.id = r.id; this.viaEngine = true; this.active = true;
        logEvent('ENCODER', `${this.kind}: fed by the native engine (${encoder})`);
        return;
      }
      const mime = pickMime();
      if (!mime) throw new Error('This computer cannot encode video in the app.');
      // if the graphics-card encoder refused to start: 1 = plain settings, 2 = software encoder (for this session)
      const rec = advSettings(this.kind === 'stream' ? 'live' : 'rec'), enc0 = rec && rec.encoder ? rec.encoder : o.encoder;
      const fb = rt.encFallback && rt.encFallback.for === enc0 ? rt.encFallback.level : 0;
      const encoder = fb >= 2 ? 'x264' : enc0, safe = fb === 1;
      this.enc0 = enc0; this.conv = !!(rec && rec.fps > 0 && Math.abs(rec.fps - o.fps) > 0.1);
      const opts = this.kind === 'stream'
        ? { kind: 'stream', url: streamURL(), fps: o.fps, bitrate: o.bitrate, encoder, safe, audioBitrate: o.audioBitrate, inputCodec: codecOf(mime), adv: rec, width: engine.W, height: engine.H }
        : { kind: 'record', dir: settings.recordDir, name: show.showName, fps: o.fps, encoder, safe, bitrate: o.recordBitrate, audioBitrate: o.recordAudioBitrate || 256, inputCodec: codecOf(mime), adv: rec, timecode: rec && rec.timecode ? timecodeNow(rec.fps || o.fps) : '', width: engine.W, height: engine.H };
      if (rec) logEvent('ENCODER', `${this.kind}: own encoder settings — ${recAdvText(rec, encoder)}`);
      const r = await S.outStart(opts);
      if (!r || r.error) throw new Error(r ? r.error : 'Encoder did not start');
      this.id = r.id;
      // shared encoder: for everything FFmpeg encodes again (the stream; the recording with a graphics-card encoder)
      const reencode = this.kind === 'stream' || ['nvenc', 'qsv', 'amf'].includes(encoder) || !!rec;
      if (reencode && settings.sharedEncoder !== false && window.EbmlScanner && codecOf(mime) === 'h264') {
        this.shared = true;
        if (await Feed.join(this.id, mime)) { this.active = true; return; }
        this.shared = false;
        logEvent('ENCODER', `${this.kind}: could not join the shared encoder in time — using its own`);
      }
      this.track = engine.videoTrack().clone();
      const ms = new MediaStream([this.track, ...mixer.stream().getAudioTracks()]);
      // the picture handed to FFmpeg: when FFmpeg encodes it again (always for the stream; for the recording with a
      // graphics-card encoder) it gets a clean, high-quality copy, so the final file is not compressed twice at a low rate
      const reenc = this.kind === 'stream' || ['nvenc', 'qsv', 'amf'].includes(encoder) || !!rec;
      const vbps = this.kind === 'stream' ? clamp(o.bitrate * 2000, 8e6, 30e6) : reenc ? clamp(o.recordBitrate * 3000, 10e6, 100e6) : clamp(o.recordBitrate * 1000, 1e6, 100e6);
      this.rec = new MediaRecorder(ms, { mimeType: mime, videoBitsPerSecond: vbps, audioBitsPerSecond: 510000 });
      const id = this.id;
      this.rec.ondataavailable = e => {
        if (!e.data || !e.data.size) return;
        const ab = e.data.arrayBuffer();
        this.chain = this.chain.then(() => ab).then(b => S.outWrite(id, b)).catch(() => {});
      };
      this.rec.start(250);
      this.active = true;
    }
    async stopRecorder() {
      if (this.viaEngine) return;
      if (this.shared) { this.shared = false; await Feed.leave(this.id); return; }
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
    if (rt.native && rt.native.id === ev.id) { rt.native.on(ev); return; }
    if (rt.test && rt.test.out.id === ev.id) { rt.test.on(ev); return; }
    // FFmpeg's own messages go to the log (the first 25 of each output — enough to see what went wrong)
    if (ev.type === 'log') { rt.ffLines = rt.ffLines || {}; const n = rt.ffLines[ev.id] = (rt.ffLines[ev.id] || 0) + 1; if (n <= 25) logEvent('ENCODER', `${ev.kind}: ${String(ev.line).slice(0, 300)}`); }
    if (ev.type === 'stats') {
      if (ev.kind === 'stream') { rt.liveStats = ev; if (rt.reconnPending && ev.frame > 30) { rt.reconnPending = false; rt.reconnects = 0; toast('Stream is running again.', 'ok'); } }
      else rt.recStats = ev;
      return;
    }
    if (ev.type === 'exit') {
      logEvent('ENCODER', `${ev.kind} encoder ${ev.expected ? 'finished' : 'stopped'}${ev.code !== undefined ? ` (code ${ev.code})` : ''}${ev.error ? ` — ${ev.error}` : ''}${ev.detail ? ` — ${String(ev.detail).slice(0, 400)}` : ''}`);
      if (ev.file) toast(`Recording saved: ${ev.file}`, 'ok', S.showFile ? { label: 'Show', fn: () => S.showFile(ev.file) } : null);
      if (ev.expected) return;
      // graphics-card encoder refused to start → step down by itself instead of failing over and over
      const mineOut = (ev.kind === 'stream' && rt.live && rt.live.id === ev.id) || (ev.kind === 'record' && rt.rec && rt.rec.id === ev.id);
      // (the encoder that output asked for: its own encoder settings may choose another than Video output)
      const askedEnc = (mineOut && (ev.kind === 'stream' ? rt.live : rt.rec).enc0) || settings.output.encoder;
      const hwName = { nvenc: 'NVIDIA', qsv: 'Intel', amf: 'AMD' }[askedEnc];
      if (ev.encoderFailed && hwName && mineOut) {
        const cur = rt.encFallback && rt.encFallback.for === askedEnc ? rt.encFallback.level : 0;
        if (cur < 2) {
          rt.encFallback = { for: askedEnc, level: cur + 1, detail: ev.detail };
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

  /* ---------- test the stream key: sends ~12 s to YouTube and reports exactly what happened ---------- */
  function openStreamTest() {
    if (rt.live) { toast('You are already live — the header shows how the stream is doing.'); return; }
    if (!settings.youtube.key && settings.youtube.server !== 'custom') { toast('Paste your stream key first.', 'error'); return; }
    const body = el('div'), log = el('div', { class: 'test-log' });
    const line = (txt, cls) => { log.append(el('div', { class: cls || '' }, txt)); };
    const explain = err => {
      const e = String(err || '');
      if (/nvenc|qsv|amf|opening encoder|No capable devices/i.test(e)) return 'The graphics-card encoder will not start on this PC. In Settings → Encoder choose “Software”, or update the graphics driver. This is not a YouTube or key problem.';
      if (/resolve|getaddrinfo|No such host|Network is unreachable/i.test(e)) return 'This PC cannot find YouTube — check the internet connection.';
      if (/timed out|Connection refused|10060|10061|TLS|SSL|handshake/i.test(e)) return 'Could not reach YouTube’s server. A firewall or the network may be blocking it — try the “primary (RTMP)” server in Settings, or another network.';
      if (/Broken pipe|reset|10053|10054|Input\/output|End of file|I\/O error/i.test(e)) return 'YouTube opened the connection and then closed it. That almost always means the stream key is wrong or was replaced — copy it again from YouTube Studio → Go live → Stream.';
      return 'The stream stopped before it got going.';
    };
    let finished = false;
    const finish = () => { finished = true; const t = rt.test; rt.test = null; if (t) { clearTimeout(t.timer); t.out.active = false; t.out.stop().catch(() => {}); } stopBtn.textContent = 'Close'; };
    const stopBtn = el('button', { class: 'btn primary', onclick: () => { if (!finished) finish(); closeModal(); } }, 'Stop test');
    put(body,
      el('div', { class: 'muted', style: 'margin-bottom:10px' }, 'This sends about 12 seconds of your live picture and sound to YouTube with your real settings. If your YouTube stream is public and set to start by itself, viewers could see those seconds.'),
      log, el('div', { class: 'row', style: 'margin-top:14px' }, el('span', { class: 'grow' }), stopBtn));
    openModal('Test the stream key', body);
    (async () => {
      const o = settings.output, y = settings.youtube;
      line(`Server: ${y.server === 'custom' ? y.custom : y.server}`);
      line(`Key: ${y.key ? y.key.slice(0, 4) + '…' + y.key.slice(-4) + ` (${y.key.trim().length} characters)` : '(in the custom address)'}${/\s/.test(y.key || '') ? '  ⚠ contains a space' : ''}`);
      line(`Sending: ${o.width}×${o.height} at ${o.fps} fps, ${o.bitrate} kbps picture, ${o.audioBitrate} kbps sound, encoder: ${o.encoder}`);
      mixer.resume();
      let out, best = 0, gotData = false, t0 = Date.now(), lastShown = 0;
      const status = el('div', { class: 'big' }, 'Connecting to YouTube…'); log.append(status);
      try { out = new Output('stream'); await out.start(); }
      catch (e) { status.textContent = '✗ Could not start'; status.className = 'big status-bad'; line(e.message, 'status-bad'); finished = true; stopBtn.textContent = 'Close'; return; }
      rt.test = { out, timer: setTimeout(async () => {
        if (finished) return;
        finish();
        if (best > 60 && gotData) {
          status.textContent = '✓ YouTube accepted the stream'; status.className = 'big status-ok';
          line(`${best} frames were sent and the connection stayed open. The key and the internet connection work.`, 'status-ok');
          line('If YouTube Studio still does not show it: (1) open Studio → Go live → Stream and check the key there matches the one above; (2) a scheduled event has its own key unless you picked “default stream key”; (3) the preview in Studio can take 20–30 seconds to appear; (4) a scheduled event shows the preview but only goes public when you press GO LIVE in Studio — or connect your YouTube account here and Live Studio does that for you.');
          if (rt.yt.signedIn && rt.yt.event) { await ytPoll().catch(() => {}); const hh = rt.yt.health; line(`YouTube reports for “${rt.yt.event.title}”: ${hh ? (hh.stream === 'active' ? 'receiving the stream ✓' : 'not receiving yet (' + hh.stream + ')') + (hh.issues.length ? ' — ' + hh.issues.join(' · ') : '') : 'no status yet'}.`); }
        } else { status.textContent = '✗ Nothing reached YouTube'; status.className = 'big status-bad'; line('The encoder ran but no frames went out in 12 seconds. Check the internet connection and the key.', 'status-bad'); }
      }, 12000), on: ev => {
        if (ev.type === 'stats') { best = Math.max(best, ev.frame || 0); if (ev.bitrate > 0) gotData = true; if (Date.now() - lastShown > 900) { lastShown = Date.now(); status.textContent = `Sending… ${ev.frame || 0} frames, ${ev.bitrate ? (ev.bitrate / 1000).toFixed(1) + ' Mb/s' : 'starting'}`; } }
        else if (ev.type === 'exit' && !finished) {
          const secs = ((Date.now() - t0) / 1000).toFixed(0);
          finish();
          status.textContent = `✗ The stream stopped after ${secs} s`; status.className = 'big status-bad';
          line(explain(`${ev.detail} ${ev.error}`), 'status-bad');
          line(`Reported: ${ev.detail || ev.error || 'no details'}`, 'muted');
        }
      } };
    })();
  }

  /* ================= native engine test =================
     FFmpeg reads one capture card itself and encodes on the graphics card — the picture never goes through the
     Chrome engine. If this streams perfectly smooth, an OBS-style engine fixes the hitches. */
  /* processor share of each part (from the main process, % of the whole PC) — short names for the log, plain ones for the window */
  const CPU_PARTS = [['page', 'page', 'Picture engine (the program window)'], ['gpu', 'gpu', 'Graphics process'], ['capture', 'cam', 'Camera capture'], ['audio', 'aud', 'Sound'],
    ['overlays', 'web', 'Web graphics'], ['yt', 'yt-enc', 'YouTube encoder (FFmpeg)'], ['rec', 'rec-enc', 'Recording encoder (FFmpeg)'], ['native', 'native', 'Native test (FFmpeg)'],
    ['ffmpeg', 'ff', 'Cameras + other FFmpeg'], ['engine', 'engine', 'Native engine'], ['vst', 'vst', 'Audio plug-ins (VST3)'], ['main', 'main', 'Live Studio main process'], ['helpers', 'help', 'Other Live Studio helpers'], ['monitor', 'mon', 'PC monitor'], ['otherPrograms', 'other', 'Other programs and Windows']];
  const cpuPartsShort = P => CPU_PARTS.filter(([k]) => (P[k] || 0) >= 0.5).map(([k, n]) => `${n} ${Math.round(P[k])}`).join(' ');
  const DECODE_WORDS = { 'cuda-zc': 'graphics card — the picture stays on the card (lowest processor load)', cuda: 'graphics card (NVIDIA), copied back', d3d11va: 'graphics card (Windows D3D11)', dxva2: 'graphics card (Windows DXVA2)', none: 'processor — graphics-card decoding does not work on this PC', auto: 'automatic' };

  function openNativeTest() {
    if (rt.live || rt.rec) { toast('Stop the stream and the recording first — the test uses the capture card on its own.', 'error'); return; }
    const body = el('div');
    let dev = null, pickV = 0, pickM = 0, pickA = -1, dest = settings.youtube.key ? 'yt' : 'file', run = null, lastMsg = '';
    const o = settings.output, target = o.fps || 59.94, W = bigOut() ? 1920 : o.width || 1920, H = bigOut() ? 1080 : o.height || 1080;
    /* The card's picture formats at the output size, the output's own rate first. Only an exact 1080p 59.94 format
       makes a fair test (13:00 log: “Blackmagic WDM Capture” had none and the test silently ran at 25 fps). */
    const near = f => Math.abs(f - target) < 0.05;
    const fits = m => m.w === W && m.h === H && (near(m.maxFps) || near(m.minFps) || (target > m.minFps && target < m.maxFps));
    const FMT = ['uyvy422', 'yuyv422', 'nv12', 'yuv420p', 'v210'], fr = m => { const i = FMT.indexOf(m.fmt); return i < 0 ? 9 : i; };
    const modesOf = v => {
      const seen = new Set(), list = [];
      for (const m of (v.modes || [])) { if (m.w !== W || m.h !== H) continue; const k = `${m.kind}|${m.fmt}|${m.minFps}|${m.maxFps}`; if (!seen.has(k)) { seen.add(k); list.push(m); } }
      return list.sort((a, b) => (fits(b) - fits(a)) || (fr(a) - fr(b)) || (Math.abs(a.maxFps - target) - Math.abs(b.maxFps - target)));
    };
    const hasExact = v => modesOf(v).some(fits);
    const modeFor = v => modesOf(v)[pickM] || null;
    const modeFps = m => fits(m) ? target : +m.maxFps.toFixed(2);
    const camOf = v => { const cs = show.cameras.filter(c => c.deviceLabel === v.name); return cs.length === 1 && dev.video.filter(x => x.name === v.name).length === 1 ? cs[0] : null; };
    const sum1080 = v => { const ms = modesOf(v); if (!ms.length) return `no ${W}×${H} formats`; return `${W}×${H} at ${[...new Set(ms.map(m => +m.maxFps.toFixed(2)))].sort((a, b) => a - b).join(' / ')} fps (${[...new Set(ms.map(m => m.fmt))].join(', ')})${hasExact(v) ? '' : ` — NO ${target}`}`; };
    const vName = v => `${v.name}${dev.video.filter(x => x.name === v.name).length > 1 ? ` — card ${v.n + 1}` : ''}`;
    // the numbers are updated in place (rebuilding the window every second could swallow a click on Stop)
    const statsEl = el('div', { class: 'native-stats mono' });
    const updStats = () => { const L = run && run.last; statsEl.textContent = run ? `${L ? `${(L.fps || 0).toFixed(1)} fps · repeated ${run.dup} · dropped ${run.drop} · speed ${(L.speed || 0).toFixed(2)}× · ${((L.bitrate || 0) / 1000).toFixed(1)} Mb/s` : 'starting…'} · ${fmt((Date.now() - run.t0) / 1000)}` : (lastMsg || 'Not running'); };
    const fmtMode = m => m ? `${m.w}×${m.h} · ${modeFps(m)} fps · ${m.fmt === 'v210' ? 'v210 (10-bit)' : m.fmt}` : 'the card’s own format';
    const finish = (msg) => {
      const r = run; run = null; rt.native = null; rt.nativeTest = false;
      if (r) {
        const secs = Math.round((Date.now() - r.t0) / 1000);
        lastMsg = `${msg ? msg + ' · ' : ''}${secs} s · ${r.frames} frames · repeated ${r.dup} · dropped ${r.drop}${r.minSpeed < 9 ? ` · slowest ${r.minSpeed.toFixed(2)}×` : ''}`;
        logEvent('NATIVE', `test ended: ${lastMsg}`);
      }
      for (const c of show.cameras) openCamera(c); // Live Studio takes the cameras back
      if (body.isConnected) draw();
    };
    const start = async () => {
      const v = dev.video[pickV], a = pickA >= 0 ? dev.audio[pickA] : null, m = modeFor(v);
      if (dest === 'yt' && !settings.youtube.key && settings.youtube.server !== 'custom') { toast('Add your YouTube stream key first (Settings → YouTube).', 'error'); return; }
      rt.nativeTest = true;
      for (const c of show.cameras) closeCamera(c.id);  // a capture card can only be used by one program at a time
      await wait(900);
      if (m && !fits(m)) logEvent('NATIVE', `warning: this format is ${modeFps(m)} fps, not the output ${target} fps — not a fair test`);
      const opts = { kind: 'native', device: v.name, videoNumber: v.n, pixFmt: m && m.kind === 'pixel_format' ? m.fmt : null, vcodec: m && m.kind === 'vcodec' ? m.fmt : null,
        width: W, height: H, fps: target, captureFps: m ? modeFps(m) : target,
        encoder: o.encoder, bitrate: o.bitrate, audioBitrate: o.audioBitrate, audioDevice: a ? a.name : null, audioNumber: a ? a.n : 0,
        url: dest === 'yt' ? streamURL() : null, dir: settings.recordDir };
      const r = await S.outStart(opts);
      if (!r || r.error) { rt.nativeTest = false; toast(`Test could not start: ${r ? r.error : 'no answer'}`, 'error'); finish('could not start'); return; }
      run = { id: r.id, t0: Date.now(), frames: 0, dup: 0, drop: 0, last: null, minSpeed: 9, err: '' };
      logEvent('NATIVE', `test started: ${vName(v)} · ${fmtMode(m)} · sound ${a ? a.name : 'silence'} · ${dest === 'yt' ? 'to YouTube' : 'to a test file'} · ${o.encoder} ${o.bitrate} kbps`);
      rt.native = { id: r.id, on: ev => {
        if (!run) return;
        if (ev.type === 'stats') {
          const dd = Math.max(0, (ev.dup || 0) - run.dup), dr = Math.max(0, (ev.drop || 0) - run.drop);
          run.dup = ev.dup || 0; run.drop = ev.drop || 0; run.frames = ev.frame || run.frames; run.last = ev;
          if (ev.speed && Date.now() - run.t0 > 5000) run.minSpeed = Math.min(run.minSpeed, ev.speed);
          const pc = rt.pc;
          logEvent('NATIVE', `${(ev.fps || 0).toFixed(0)}fps repeated +${dd} dropped +${dr} x${(ev.speed || 0).toFixed(2)} ${((ev.bitrate || 0) / 1000).toFixed(1)}Mb${pc ? ` | cpu ${pc.cpu}% gpu ${pc.gpu}%` : ''}${dd || dr ? '  [!]' : ''}`);
          updStats();
        } else if (ev.type === 'log') { run.err = ev.line; logEvent('NATIVE', `ffmpeg: ${ev.line}`); }
        else if (ev.type === 'exit') {
          if (ev.file) toast(`Test file saved: ${ev.file}`, 'ok', S.showFile ? { label: 'Show', fn: () => S.showFile(ev.file) } : null);
          finish(ev.expected ? 'stopped' : `the test stopped by itself: ${ev.error || run.err || 'code ' + ev.code}`);
        }
      } };
      draw();
    };
    const stop = async () => { if (run) { const id = run.id; await S.outStop(id); } };
    const draw = () => {
      body.innerHTML = '';
      const intro = el('div', { class: 'muted', style: 'margin-bottom:10px' }, 'Streams one camera straight from the capture card through FFmpeg and the graphics card — without the Chrome engine — to see if an OBS-style engine runs perfectly smooth on this PC. Live Studio lets go of the cameras while the test runs and takes them back afterwards. Use an unlisted / private YouTube event.');
      if (!dev) { put(body, intro, el('div', null, 'Looking for capture cards…')); return; }
      if (!dev.video.length) { put(body, intro, el('div', { class: 'status-bad' }, dev.note === 'Only on Windows' ? 'This test only works on the Windows PC.' : 'No capture cards found.')); return; }
      const v = dev.video[pickV], m = modeFor(v), ms = modesOf(v);
      updStats();
      const cardLabel = x => { const c = camOf(x); return `${vName(x)}${c ? ` — your “${c.name}”` : ''}${hasExact(x) ? '' : ` — no ${target} fps`}`; };
      put(body, intro,
        el('div', { class: 'field' }, el('span', null, 'Camera card'), select(dev.video.map((x, i) => [String(i), cardLabel(x)]), String(pickV), x => { pickV = +x; pickM = 0; draw(); })),
        ms.length ? el('div', { class: 'field' }, el('span', null, 'Picture'), select(ms.map((x, i) => [String(i), fmtMode(x)]), String(pickM), x => { pickM = +x; draw(); }))
          : el('div', { class: 'muted', style: 'font-size:.85em;margin:-4px 0 8px' }, `This card lists no ${W}×${H} formats — it will use its own.`),
        m && !fits(m) ? el('div', { class: 'status-bad', style: 'font-size:.9em;margin:-2px 0 8px' }, `⚠ Not ${target} fps — this would not be a fair test. Pick another card (usually “Decklink Video Capture”).`) : null,
        el('div', { class: 'field' }, el('span', null, 'Sound'), select([['-1', 'Silence'], ...dev.audio.map((x, i) => [String(i), x.name])], String(pickA), x => { pickA = +x; })),
        el('div', { class: 'field' }, el('span', null, 'Send to'), select([['yt', 'YouTube (your stream key)'], ['file', 'A test file (recordings folder)']], dest, x => { dest = x; })),
        statsEl,
        el('div', { class: 'muted', style: 'font-size:.85em;margin-top:6px' }, '“Repeated” or “dropped” going up means the card did not deliver frames evenly. Watch the stream on YouTube for hitches. Everything is written to the log.'),
        el('div', { class: 'row', style: 'margin-top:14px;gap:8px' },
          run ? el('button', { class: 'btn danger', onclick: stop }, '■ Stop test') : el('button', { class: 'btn primary', onclick: start }, '▶ Start test'),
          el('span', { class: 'grow' }), el('button', { class: 'btn', onclick: () => { if (run) { toast('Stop the test first.'); return; } closeModal(); } }, 'Close')));
    };
    draw();
    openModal('Native engine test (OBS-style)', body);
    S.nativeDevices ? S.nativeDevices().then(r => {
      dev = r || { video: [], audio: [] };
      const ssl = dev.audio.findIndex(a => /ssl/i.test(a.name)); if (ssl >= 0) pickA = ssl;
      // start on a card that really offers 1080p 59.94 — the same kind the cameras use (Blackmagic WDM) if it does, else Decklink
      const camNames = new Set(show.cameras.map(c => c.deviceLabel));
      const score = x => (hasExact(x) ? 10 : 0) + (camNames.has(x.name) ? 2 : 0) + (/^decklink video capture/i.test(x.name) ? 1 : 0) + (camOf(x) ? 1 : 0);
      dev.video.forEach((x, i) => { if (score(x) > score(dev.video[pickV])) pickV = i; });
      for (const x of dev.video) logEvent('NATIVE', `card ${x.name} #${x.n + 1}: ${(x.modes || []).length} formats · ${sum1080(x)}`);
      draw();
    }) : (dev = { video: [], audio: [] }, draw());
  }

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
    // (an output set to another frame rate than the program drops / repeats frames on purpose — not counted)
    const enc = (rt.live && rt.liveStats && !rt.live.conv ? (rt.liveStats.drop || 0) : 0) + (rt.rec && rt.recStats && !rt.rec.conv ? (rt.recStats.drop || 0) : 0);
    const cam = 0;
    return { engine: engine.stats.missed, enc, cam, total: engine.stats.missed + enc }; // camera skips are shown in the window only
  }
  function resetFrameStats() {
    engine.stats.frames = 0; engine.stats.missed = 0; engine.stats.recent = []; engine.stats.worst = 0; engine.stats.since = performance.now();
    engine.stats.camRepeat = 0; engine.stats.camSkip = 0;
    for (const so of engine.sources.values()) { so.late = 0; so.worstGap = 0; so.gapLog = []; }
    logEvent('COUNTERS', 'frame counters reset');
    for (const c of show.cameras) { const src = engine.sources.get(c.id); if (src) { src.skipBase = src.skipped || 0; src.pfBase = src.pf || 0; src.fpsNow = 0; src.countAt = performance.now(); } }
    rt.dropSeen = 0;
  }
  function openPerf() {
    if (S.logInfo && !rt.logFile) S.logInfo().then(i => { rt.logFile = i && i.file; }).catch(() => {});
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
        (() => { const L = (rt.longTasks || []).filter(x => performance.now() - x[0] < 60000), mx = L.reduce((a, x) => Math.max(a, x[1]), 0);
          return row('Program thread busy > 50 ms (last minute)', L.length ? `${L.length}× · longest ${Math.round(mx)} ms` : 'none', L.length > 2); })(),
        row('Screen updates (meters, playbars)', rt.uiMs !== undefined ? `${rt.uiMs.toFixed(1)} ms each` : '—', rt.uiMs > 4),
        row('Time to draw one frame', `${st.renderMs.toFixed(1)} ms of ${(1000 / engine.fps).toFixed(1)} ms`, st.renderMs > 1000 / engine.fps),
        el('h3', null, 'This computer'),
        rt.pc && rt.pc.cpu !== null ? [
          row(`Processor (CPU) — ${(rt.pc.cpuName || '').trim()}`, `${rt.pc.cpu}%`, rt.pc.cpu >= 90),
          rt.pc.parts ? el('div', { class: 'muted', style: 'font-size:.85em;margin:-2px 0 6px 12px' }, CPU_PARTS.filter(([k]) => (rt.pc.parts[k] || 0) >= 0.5).map(([k, , w]) => `${w} ${Math.round(rt.pc.parts[k])}%`).join(' · ')) : null,
          rt.pc.decode && DECODE_WORDS[rt.pc.decode.mode] ? row('Encoders decode the picture on', rt.pc.decode.mode === 'cuda-zc' ? 'graphics card ✓' : rt.pc.decode.mode === 'none' ? 'processor' : DECODE_WORDS[rt.pc.decode.mode].split(' (')[0]) : null,
          row('CPU temperature', rt.pc.cpuTemp !== null ? `${rt.pc.cpuTemp} °C` : 'not reported by this PC', rt.pc.cpuTemp >= 85),
          row(`Graphics (GPU)${rt.pc.gpuName ? ' — ' + rt.pc.gpuName : ''}`, rt.pc.gpu !== null ? `${rt.pc.gpu}%` : 'not available', rt.pc.gpu >= 95),
          row('GPU temperature', rt.pc.gpuTemp !== null ? `${rt.pc.gpuTemp} °C` : 'only available for NVIDIA cards', rt.pc.gpuTemp >= 85),
          row('Memory in use', `${rt.pc.mem}%`, rt.pc.mem >= 90)] : el('div', { class: 'muted' }, 'Reading…'),
        el('h3', null, 'Camera on air'),
        row('Timing', (() => { const cs = engine._clockSrc(); return cs && cs.sync ? `frame sync — every camera frame used once (queue ${cs.q ? cs.q.length : 0})` : st.locked ? 'following the camera' : cs ? 'following the screen refresh' : 'no live camera on air'; })()),
        row('Camera picture shown twice', String(st.camRepeat || 0), (st.camRepeat || 0) > 0),
        row('Camera frames skipped', String(st.camSkip || 0), (st.camSkip || 0) > 0),
        el('h3', null, 'Cameras'),
        engine.cameraStats().map(cst => row(`${(show.cameras.find(x => x.id === cst.id) || {}).name || cst.id} — late frames (last minute) · longest gap`, `${cst.late} (${cst.lastMin}) · ${Math.round(cst.worst)} ms`, cst.lastMin > 0)),
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
        rt.live && rt.liveStats ? [row('Frames sent', (rt.liveStats.frame || 0).toLocaleString()), row('Dropped by the encoder', String(rt.liveStats.drop || 0), rt.liveStats.drop > 0 && !rt.live.conv), row('Repeated to fill gaps', String(rt.liveStats.dup || 0), rt.liveStats.dup > engine.fps && !rt.live.conv), row('Encoder speed', `${(rt.liveStats.speed || 0).toFixed(2)}×`, rt.liveStats.speed && rt.liveStats.speed < 0.97)] : el('div', { class: 'muted' }, 'Not live.'),
        rt.rec && rt.recStats ? [el('h3', null, 'Recording'), row('Frames written', (rt.recStats.frame || 0).toLocaleString()), row('Dropped', String(rt.recStats.drop || 0), rt.recStats.drop > 0 && !rt.rec.conv)] : null,
        el('div', { class: 'muted', style: 'font-size:.85em;margin-top:12px' }, d.total ? 'If frames are being missed: close other programs, use a hardware encoder (Settings → Encoder), or lower the frame rate or resolution.' : 'No dropped frames. ✓'),
        el('h3', null, 'Service log'),
        el('div', { class: 'muted', style: 'font-size:.85em' }, 'Everything is written to a log file while Live Studio runs. Press F9 when you see a glitch — it marks the moment. After the service send the log file for checking.'),
        rt.logFile ? el('div', { class: 'mono', style: 'font-size:.8em;margin:4px 0;word-break:break-all' }, rt.logFile) : null,
        el('div', { class: 'row', style: 'gap:8px;margin-top:6px' }, el('button', { class: 'btn', onclick: () => { logFlush(); S.logShow && S.logShow(); } }, '📄 Show log file'), el('button', { class: 'btn', onclick: markGlitch }, '⚑ Mark a glitch (F9)'), el('button', { class: 'btn', onclick: () => { clearInterval(timer); openNativeTest(); } }, '🧪 Native engine test')),
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
    try {
      await S.saveShow(show); await S.saveSettings(settings);
      dirty.show = dirty.settings = false;
      const b = $('#btnSave');
      if (!quiet) { b.textContent = '✓ Saved'; b.classList.remove('dirty'); b.classList.add('ok'); setTimeout(() => { b.classList.remove('ok'); updateSaveBtn(); }, 1800); }
      updateSaveBtn();
      return true;
    } catch (e) { toast('Could not save: ' + e.message, 'error'); return false; }
  }
  $('#btnSave').addEventListener('click', () => saveAll());
  document.addEventListener('keydown', e => { if (e.ctrlKey && e.shiftKey && e.code === 'KeyS') { e.preventDefault(); saveAll(); } });
  // closing the window with unsaved changes: the program asks, and if you choose Save it saves here first
  if (S.onSaveRequest) S.onSaveRequest(async () => { const ok = await saveAll(true); S.saved(ok); });
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
    const E = rt.eng && rt.engStats;
    if (rt.eng) {
      // native engine: its own frame rate, and how often a camera picture was shown twice / skipped (since it started)
      if (E && E !== rt.engSeen) { rt.engSeen = E; rt.engTot = rt.engTot || { rep: 0 }; rt.engTot.rep += (E.repeat || 0) + (E.skip || 0) + (E.audioUnder || 0); }
      parts.push(rt.eng.ready && E ? `native engine ${E.ticks} fps` : '<span class="bad">native engine starting…</span>');
    } else parts.push(`engine ${engine.stats.fps} fps`);
    const P = rt.pc;
    if (P && P.cpu !== null) {
      const hot = v => v !== null && v !== undefined && v >= 85, t = v => v !== null && v !== undefined ? ` ${v}°C` : '';
      parts.push(`<span class="${P.cpu >= 90 || hot(P.cpuTemp) ? 'bad' : ''}">CPU ${P.cpu}%${t(P.cpuTemp)}</span>`);
      if (P.gpu !== null) parts.push(`<span class="${P.gpu >= 95 || hot(P.gpuTemp) ? 'bad' : ''}">GPU ${P.gpu}%${t(P.gpuTemp)}</span>`);
    }
    const drops = frameDrops();
    if (rt.eng) { const n = (rt.engTot && rt.engTot.rep) || 0; parts.push(n ? `<span class="bad">⚠ ${n} hitches</span>` : '<span class="good">0 hitches</span>'); }
    else {
      parts.push(`frame ${engine.stats.frames.toLocaleString()}`);
      parts.push(drops.total ? `<span class="bad">⚠ ${drops.total} dropped</span>` : '<span class="good">0 dropped</span>');
    }
    hl.innerHTML = parts.join(' · ');
    hl.title = 'Click for frame statistics';
    // warn once when frames start dropping while live or recording
    if (!rt.eng && (rt.live || rt.rec) && drops.total - (rt.dropSeen || 0) >= Math.max(5, engine.fps / 2) && Date.now() - (rt.dropWarnAt || 0) > 60000) { rt.dropWarnAt = Date.now(); toast(`Frames are being dropped (${drops.total} so far). Click the frame counter at the top for details.`, 'error'); }
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
  // ready-made arrangements for the Run Show page
  $('#layoutPreset').addEventListener('change', e => { const v = e.target.value; if (!v) return; settings.ui.layouts.live = layoutFrom(v); saveSettings(); setView('live'); renderGrid(); e.target.value = ''; });
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
  /* video playbars under the monitors: one for a video waiting in Preview, one for the video on air */
  const videoOf = id => { const s2 = getShot(id), mid = s2 ? mediaOf(s2)[0] : null, f = mid && rt.files.get(mid); return f && f.el && (f.el.tagName === 'VIDEO' || f.el.tagName === 'AUDIO') && isFinite(f.el.duration) && f.el.duration > 0 ? f : null; };
  const liveVideo = () => { const f = videoOf(engine.programId); return f ? f.el : null; };
  // a video in Preview that is not also on air (the same file on air is controlled by the live bar)
  const previewVideoFile = () => { const f = videoOf(rt.previewId); return f && !mediaOf(getShot(engine.programId)).includes(f.id) ? f : null; };
  function makeVideoBar(kind, getEl, buttons) {
    const range = el('input', { type: 'range', min: 0, max: 1000, step: 1, value: 0, class: 'tl-range', title: 'Drag to jump to another part of the video' });
    const now = el('span', { class: 'mono tl-t' }, '0:00'), left = el('span', { class: 'mono tl-t' }, '−0:00');
    const playBtn = el('button', { class: 'btn small', title: 'Play / pause', onclick: () => { const v = getEl(); if (!v) return; if (v.paused) { if (kind === 'pv') markManual(true); v.play().catch(() => {}); } else v.pause(); } }, '▶');
    const skip = dt => () => { const v = getEl(); if (v) v.currentTime = clamp(v.currentTime + dt, 0, Math.max(0, v.duration - 0.5)); };
    let drag = false;
    range.addEventListener('pointerdown', () => { drag = true; });
    range.addEventListener('input', () => { const v = getEl(); if (v) { const t = range.value / 1000 * v.duration; now.textContent = fmtShort(t); left.textContent = '−' + fmtShort(v.duration - t); if (kind === 'pv') v.currentTime = t; } });
    range.addEventListener('change', () => { const v = getEl(); if (v) v.currentTime = Math.min(range.value / 1000 * v.duration, Math.max(0, v.duration - 0.5)); drag = false; range.blur(); });
    const b = (label, title, fn) => el('button', { class: 'btn small', title, onclick: fn }, label);
    const btns = {
      start: b('⏮', 'Back to the beginning', () => { const v = getEl(); if (v) v.currentTime = 0; }),
      back10: b('−10 s', 'Back 10 seconds', skip(-10)), fwd10: b('+10 s', 'Forward 10 seconds', skip(10)), fwd60: b('+1 min', 'Forward 1 minute', skip(60))
    };
    const tag = el('span', { class: 'tl-tag' }, kind === 'pv' ? '🎞 PREVIEW' : '🎞 ON AIR');
    const bar = el('div', { class: `tl-bar ${kind} hidden` }, tag, playBtn, buttons.includes('start') ? btns.start : null, btns.back10, now, range, left, btns.fwd10, buttons.includes('fwd60') ? btns.fwd60 : null);
    const update = () => {
      const v = getEl();
      if (bar.classList.contains('hidden') === !!v) bar.classList.toggle('hidden', !v);
      if (!v) return;
      if (!drag) { const rv = String(Math.round(v.currentTime / v.duration * 1000)); if (range.value !== rv) range.value = rv; setText(now, fmtShort(v.currentTime)); setText(left, '−' + fmtShort(v.duration - v.currentTime)); }
      const ic = v.paused ? '▶' : '⏸'; if (playBtn.textContent !== ic) playBtn.textContent = ic;
      const tg = T(`${v.tagName === 'AUDIO' ? '♪ MUSIC' : '🎞'} ${kind === 'pv' ? 'PREVIEW' : 'ON AIR'}`); if (tag.textContent !== tg) tag.textContent = tg;
    };
    return { bar, update };
  }
  // a Preview video you started yourself keeps playing until you take it or pick another shot
  function markManual(on) { const f = previewVideoFile(); if (f) f.pvManual = on; }
  const timelineLive = makeVideoBar('live', liveVideo, ['fwd60']);
  const timelinePv = makeVideoBar('pv', () => { const f = previewVideoFile(); return f ? f.el : null; }, ['start']);
  const timeline = el('div', { class: 'tl-row' }, el('div', { class: 'tl-slot' }, timelinePv.bar), el('div', { class: 'tl-slot' }, timelineLive.bar));
  const miniLufs = el('span', { class: 'mini-lufs mono', title: 'Loudness of the stream (YouTube aims for −14 LUFS)' }, '— LUFS');
  // slim master meter beside the program screen (like a hardware switcher)
  const monMeterMain = el('canvas', { class: 'mon-meter', width: 40, height: 300 }), monMeter = monMeterMain;
  // the same kind of meter for the Preview shot, and a button to listen to it before it goes on air
  const pvMeter = el('canvas', { class: 'mon-meter', width: 40, height: 300 });
  const pvListen = el('button', { class: 'btn small pv-listen', title: 'Listen to the Preview shot on this computer before showing it. The stream does not hear this.', onclick: () => setPvListen(!rt.pvListen) }, '🎧 Listen');
  function previewMedia() { const onAir = mediaOf(getShot(engine.programId)); return mediaOf(getShot(rt.previewId)).filter(m => !onAir.includes(m)); }
  function updatePfl() {
    const p = getShot(rt.previewId);
    const media = {};
    if (p) for (const m of mediaOf(p)) media[m] = mediaLevel(p, m);
    mixer.setPreviewMix(p ? liveLevel(p) : 0, media, show.audio.media.gain, show.audio.media.mute);
    // a video in Preview only makes sound while it plays: play it while listening, rewind it afterwards
    const cue = previewMedia();
    for (const [id, f] of rt.files) {
      if (!f.el || (f.el.tagName !== 'VIDEO' && f.el.tagName !== 'AUDIO') || mediaOf(getShot(engine.programId)).includes(id)) continue;
      if (rt.pvListen && cue.includes(id)) { if (f.el.paused) f.el.play().catch(() => {}); f.cued = true; }
      else if (f.pvManual && !cue.includes(id)) { f.pvManual = false; f.cued = false; f.el.pause(); f.el.currentTime = 0; }
      else if (f.cued && !f.pvManual) { f.cued = false; f.el.pause(); f.el.currentTime = 0; }
    }
    pvListen.classList.toggle('on', !!rt.pvListen);
    pvListen.textContent = rt.pvListen ? '🎧 Listening' : '🎧 Listen';
  }
  function setPvListen(on) { rt.pvListen = !!on; mixer.resume(); mixer.setListen(on ? 'preview' : 'program'); updatePfl(); }
  const METER_PTS = [[-60, 0], [-40, 0.1], [-30, 0.2], [-20, 0.36], [-12, 0.56], [-6, 0.75], [-3, 0.87], [0, 1]];
  function meterFrac(db) {
    if (db <= -60) return 0; if (db >= 0) return 1;
    for (let i = 1; i < METER_PTS.length; i++) {
      const [d1, f1] = METER_PTS[i];
      if (db <= d1) { const [d0, f0] = METER_PTS[i - 1]; return f0 + (f1 - f0) * (db - d0) / (d1 - d0); }
    }
    return 1;
  }
  const METER_TICKS = [0, -3, -6, -9, -12, -15, -18, -24, -30, -40, -60];
  /* level meter beside a monitor: dB scale from 0 down to −60 (green / yellow above −18 / red above −6),
     peak-hold line, and the loudest recent peak as a number underneath. scaleSide = which side the numbers go */
  function drawMonMeter(A, cv = monMeterMain, scaleSide = 'left', gr = null) {
    if (!cv.isConnected) return;
    const r = cssSize(cv), k = devicePixelRatio;
    const w = Math.max(10, Math.round(r.width * k)), h = Math.max(10, Math.round(r.height * k));
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
    const g = cv.getContext('2d');
    g.clearRect(0, 0, w, h);
    const fs = Math.round(10.5 * k), top = 7 * k, foot = fs * 2.7, mh = h - top - foot;
    if (mh < 20) return;
    const y = db => top + mh * (1 - meterFrac(db));
    const labW = Math.round(fs * 2.1), gap = 4 * k;
    const bx = scaleSide === 'left' ? labW + gap : 0, bwAll = w - labW - gap;
    // with the limiter on, a third, thin bar shows how much it is turning the sound down (grows from the top)
    const bw = gr === null ? Math.max(3 * k, (bwAll - 3 * k) / 2) : Math.max(3 * k, (bwAll - 6 * k) / 2.45);
    // scale: stretched towards the top (−20 … 0 is over half the height); numbers that would overlap are left out
    g.font = `600 ${fs}px Consolas, ui-monospace, monospace`; g.textBaseline = 'middle';
    g.textAlign = scaleSide === 'left' ? 'right' : 'left';
    const tx = scaleSide === 'left' ? labW - k : bwAll + gap + k;
    let lastY = -1e9;
    for (const db of METER_TICKS) {
      const yy = Math.round(y(db));
      if (yy - lastY < fs * 1.15) continue;
      lastY = yy;
      g.fillStyle = db === 0 ? '#f87171' : db >= -18 ? '#d4d4d8' : '#8b8b94';
      g.fillText(db === 0 ? '0' : String(db), tx, Math.min(Math.max(yy, fs / 2), top + mh));
      g.fillStyle = 'rgba(255,255,255,.18)';
      g.fillRect(bx, yy, bwAll, Math.max(1, k * 0.6));
    }
    const zones = [[-60, -18, '#22c55e'], [-18, -6, '#eab308'], [-6, 0, '#ef4444']];
    [[A.peakL, A.holdL, A.clipL], [A.peakR, A.holdR, A.clipR]].forEach(([p, hd, clip], i) => {
      const x = bx + i * (bw + 3 * k);
      g.fillStyle = '#09090b'; g.fillRect(x, top, bw, mh);
      for (const [a, b2, col] of zones) {
        if (p <= a) continue;
        const y1 = y(Math.min(p, b2)), y0 = y(a);
        g.fillStyle = col; g.fillRect(x, y1, bw, y0 - y1);
      }
      if (hd > -60) { g.fillStyle = '#fff'; g.fillRect(x, y(hd) - k, bw, 2 * k); }
      g.fillStyle = clip ? '#ef4444' : '#27272a'; g.fillRect(x, 0, bw, 4 * k);
    });
    if (gr !== null) {
      const x = bx + 2 * (bw + 3 * k), gw = bwAll - 2 * (bw + 3 * k);
      g.fillStyle = '#09090b'; g.fillRect(x, top, gw, mh);
      g.fillStyle = 'rgba(255,255,255,.14)'; for (const d of [3, 6, 9]) g.fillRect(x, top + mh * d / 12, gw, Math.max(1, k * 0.6));
      if (gr > 0.1) { g.fillStyle = gr > 6 ? '#ef4444' : '#f59e0b'; g.fillRect(x, top, gw, mh * Math.min(1, gr / 12)); }
      g.font = `700 ${Math.round(fs * 0.75)}px Consolas, ui-monospace, monospace`; g.textAlign = 'right';
      g.fillStyle = gr > 0.1 ? '#fbbf24' : '#71717a';
      g.fillText('LIM', w - k, top + mh + fs * 2.1);
    }
    // readout: loudest recent peak, and L / R under the bars
    const peak = Math.max(A.holdL, A.holdR), cx = bx + (gr === null ? bwAll : 2 * bw + 3 * k) / 2;
    g.textAlign = 'center'; g.font = `700 ${fs}px Consolas, ui-monospace, monospace`;
    g.fillStyle = A.silent || peak <= -60 ? '#71717a' : peak > -1.2 ? '#f87171' : peak > -6 ? '#facc15' : '#e4e4e7';
    g.fillText(A.silent || peak <= -60 ? '−∞' : peak.toFixed(1).replace('-', '−'), cx, top + mh + fs * 0.95);
    g.font = `600 ${Math.round(fs * 0.85)}px Consolas, ui-monospace, monospace`; g.fillStyle = '#71717a';
    g.fillText('L', bx + bw / 2, top + mh + fs * 2.1); g.fillText('R', bx + bw * 1.5 + 3 * k, top + mh + fs * 2.1);
    // phase dot (program meter only): green = fine, orange = wide, red = out of phase
    if (A.corr === undefined) return;
    g.fillStyle = A.silent ? '#52525b' : A.corr < -0.2 ? '#ef4444' : A.corr < 0.2 ? '#f59e0b' : '#22c55e';
    g.beginPath(); g.arc(scaleSide === 'left' ? labW / 2 : bwAll + gap + labW / 2, top + mh + fs * 0.95, 3.5 * k, 0, 7); g.fill();
  }
  RENDER.monitors = body => {
    body.innerHTML = '';
    const pvName = el('span', { class: 'name', id: 'pvName' });
    const pgName = el('span', { class: 'name', id: 'pgName' });
    const durSel = select([[0, 'Cut'], [300, 'Fade 0.3 s'], [600, 'Smooth 0.6 s'], [1000, 'Fade 1 s'], [2000, 'Fade 2 s']], show.transition.ms, v => { show.transition.ms = +v; changed(); }, { class: 'trans-sel' });
    put(body, el('div', { class: 'mon-wrap' },
      el('div', { class: 'monitors' },
        el('div', { class: 'mon-meter-wrap pv', title: 'Preview sound — what the Preview shot will sound like on air. Numbers are dB (0 = maximum); number underneath = loudest recent peak' }, pvMeter),
        el('div', { class: 'monitor preview' }, el('div', { class: 'screen' }, previewCanvas), el('div', { class: 'monitor-label' }, el('span', { class: 'ldot green' }), el('span', { class: 'tagtxt' }, 'Preview'), pvName, el('span', { class: 'grow' }), pvListen)),
        el('div', { class: 'monitor program' }, el('div', { class: 'screen' }, engine.canvas, progInfo, progBar), el('div', { class: 'monitor-label' }, el('span', { class: 'ldot red' }), el('span', { class: 'tagtxt' }, 'Live'), pgName)),
        el('div', { class: 'mon-meter-wrap pgm', title: 'Program sound — what the stream hears. Numbers are dB (0 = maximum). Number underneath = loudest recent peak. Dot = phase (green good, red out of phase). LIM bar = how much the limiter is turning the sound down right now (orange; red above 6 dB)' }, monMeter)),
      timeline,
      el('div', { class: 'trans-bar' },
        el('button', { class: 'btn cut-btn', onclick: () => take('cut') }, 'CUT', keyChip('cut')),
        durSel,
        el('button', { class: 'btn take-btn', onclick: () => take('auto') }, 'TAKE ➜', keyChip('take')),
        el('span', { class: 'trans-gap' }),
        el('button', { class: 'btn ftb-btn', id: 'ftbBtn', onclick: () => setBlack(!engine.isBlack) }, 'FADE TO BLACK', keyChip('ftb')),
        el('button', { class: 'btn small ghost', onclick: openShortcuts, title: 'Keyboard shortcuts' }, '⌨'),
        // with the Audio panel hidden (big-monitor layout), its buttons and the loudness sit here
        curLayout().some(x => x.id === 'audio' && !x.hidden) ? null : el('div', { class: 'mini-audio' }, ...audioButtons(), miniLufs))));
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
    if (id !== rt.editingId) { engine.matteId = null; rt.pickGreen = false; }
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

  /* ================= green screen (per shot) ================= */
  const GD = window.LiveEngine.GREEN_DEF;
  function greenCfg(s) {
    if (!s.green) s.green = { on: false, bg: '', color: GD.color, strength: GD.strength, soft: GD.soft, spill: GD.spill };
    return s.green;
  }
  const hex2 = v => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, '0');
  // the average colour of a small spot of the picture shown in the framing pad (the whole source, not cropped)
  function greenSample(x, y) {
    let d; try { d = padCanvas.getContext('2d').getImageData(Math.max(0, Math.round(x) - 3), Math.max(0, Math.round(y) - 3), 7, 7).data; } catch (e) { return null; }
    let r = 0, g = 0, b = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; n++; }
    if (!n) return null;
    r /= n; g /= n; b /= n;
    const [cb, cr] = window.LiveEngine.keyCbCr('#' + hex2(r) + hex2(g) + hex2(b));
    if (Math.hypot(cb, cr) < 0.04) return null; // grey / white / black: not a screen colour
    return '#' + hex2(r) + hex2(g) + hex2(b);
  }
  // the screen's own colour, found in the picture: the middle value of all clearly green (or, failing that, blue) pixels
  function greenAuto() {
    let d; try { d = padCanvas.getContext('2d').getImageData(0, 0, padCanvas.width, padCanvas.height).data; } catch (e) { return null; }
    for (const ch of [1, 2]) {
      const R = [], G = [], B = [];
      for (let i = 0; i < d.length; i += 4) {
        const c = [d[i], d[i + 1], d[i + 2]], o = c.filter((v, k) => k !== ch);
        if (c[ch] > 40 && c[ch] > Math.max(...o) * 1.3 + 12) { R.push(c[0]); G.push(c[1]); B.push(c[2]); }
      }
      if (R.length > d.length / 4 * 0.06) {
        const med = a => a.sort((p, q) => p - q)[a.length >> 1];
        return '#' + hex2(med(R)) + hex2(med(G)) + hex2(med(B));
      }
    }
    return null;
  }
  function greenPanel(s) {
    const g = greenCfg(s), up = () => { changed(); };
    const isColor = /^#/.test(g.bg || '');
    const bgSel = select([...sourceOptions(false).filter(o => o[0] !== s.main.source), ['#color', '🎨 A plain colour']], isColor ? '#color' : (g.bg || 'black'), v => {
      g.bg = v === '#color' ? '#1e3a5f' : v; up(); refresh('editor');
    }, { class: 'grow' });
    return el('div', { style: 'margin-top:8px' },
      el('div', { class: 'field' }, el('span', null, 'Background (shows where the green was)'),
        el('div', { class: 'row', style: 'gap:6px' }, bgSel,
          isColor ? el('input', { type: 'color', value: g.bg, oninput: e => { g.bg = e.target.value; up(); } }) : null,
          el('button', { class: 'btn small', title: 'Import a picture or video for the background', onclick: async () => { const a = await addFiles(); const f = a.find(x => x.kind === 'image' || x.kind === 'video'); if (f) { g.bg = f.id; up(); refresh('editor'); } } }, 'Import…'))),
      el('div', { class: 'field' }, el('span', null, 'Colour to remove'),
        el('div', { class: 'row wrap', style: 'gap:6px;align-items:center' },
          el('span', { class: 'key-swatch', style: `background:${g.color}`, title: g.color }),
          el('button', { class: 'btn small', title: 'Find the screen colour in the picture', onclick: () => { const c = greenAuto(); if (c) { g.color = c; up(); toast(`Found the screen colour ${c}.`, 'ok'); } else toast('No green or blue screen found in the picture — use 🎯 Pick and click on the screen.', 'error'); refresh('editor'); } }, 'Auto'),
          el('button', { class: 'btn small' + (rt.pickGreen ? ' sel' : ''), title: 'Then click on the green in the picture above', onclick: () => { rt.pickGreen = !rt.pickGreen; rt.padTarget = 'main'; pad.classList.toggle('picking', rt.pickGreen); if (rt.pickGreen) toast('Now click on the green screen in the picture above.'); refresh('editor'); } }, rt.pickGreen ? '🎯 Click the picture…' : '🎯 Pick'),
          el('button', { class: 'btn small', onclick: () => { g.color = '#00ff00'; up(); refresh('editor'); } }, 'Green'),
          el('button', { class: 'btn small', onclick: () => { g.color = '#0000ff'; up(); refresh('editor'); } }, 'Blue'))),
      slider({ label: 'Strength', min: 0.1, max: 0.95, step: 0.01, value: g.strength ?? GD.strength, reset: GD.strength, fmt: v => `${Math.round(v * 100)}%`, onInput: v => { g.strength = v; up(); } }),
      slider({ label: 'Soft edges', min: 0.02, max: 0.6, step: 0.01, value: g.soft ?? GD.soft, reset: GD.soft, fmt: v => `${Math.round(v * 100)}%`, onInput: v => { g.soft = v; up(); } }),
      slider({ label: 'Green glow', min: 0.05, max: 1, step: 0.01, value: g.spill ?? GD.spill, reset: GD.spill, fmt: v => `${Math.round(v * 100)}%`, onInput: v => { g.spill = v; up(); } }),
      el('div', { class: 'row', style: 'margin-top:6px' }, check(' Show the cut-out on Preview (white = kept, black = removed)', engine.matteId === s.id, v => { engine.matteId = v ? s.id : null; if (v && rt.previewId !== s.id) setPreview(s.id); })),
      el('div', { class: 'muted', style: 'font-size:.85em;margin-top:6px' }, 'Pick the screen colour first (Auto or 🎯), then raise Strength until the green is gone everywhere and lower it if parts of the person disappear. Soft edges smooths hair; Green glow takes the green tint off edges. Light the screen evenly, with no shadows. Double-click a slider to reset it.'));
  }

  /* ================= panel: shot framing ================= */
  const padCanvas = el('canvas', { width: 320, height: 180 });
  const padBox = el('div', { class: 'frame-box' });
  const pad = el('div', { class: 'pad', title: 'Drag to move the frame · scroll to zoom · click to centre' }, padCanvas, padBox);
  function padLayer(s) { return rt.padTarget === 'pip' && s.pip.enabled ? s.pip : s.main; }
  const pipAspect = s => { const r = window.LiveEngine.pipRect(s.pip, engine.W, engine.H); return (r[2] * engine.W) / (r[3] * engine.H); };

  /* picture-in-picture: put the small picture anywhere, any size — drag it, pull its corners, or use the buttons */
  function pipPanel(s) {
    const p = s.pip, W = engine.W, H = engine.H, A = (W / H) / (16 / 9), keep = () => p.keep !== false;
    const mx = 0.03, my = 0.03 * W / H; // the margin the ready-made positions keep from the edges
    const R = () => window.LiveEngine.pipRect(p, W, H);
    if (!p.rect) { const r = R(); p.rect = { x: r[0], y: r[1], w: r[2], h: r[3] }; } // older shows: corner + size → a free position, same place
    const bg = el('canvas', { width: 320, height: 180, class: 'pip-bg' }), img = el('canvas', { width: 320, height: 180 });
    const handles = ['tl', 'tr', 'bl', 'br'].map(c => el('i', { class: `pip-h ${c}`, dataset: { c } }));
    const box = el('div', { class: 'pip-box', title: 'Drag to move · pull a corner to resize · hold Alt to place freely without snapping' }, img, ...handles);
    const area = el('div', { class: 'pip-area' }, bg, box);
    engine.layerViews.set(bg, { shot: s.id, part: 'main' });
    engine.layerViews.set(img, { shot: s.id, part: 'pip' });
    let sl = {};
    const pct = v => `${Math.round(v * 100)}%`;
    function place() {
      const r = R();
      Object.assign(box.style, { left: pct(r[0]), top: pct(r[1]), width: `${r[2] * 100}%`, height: `${r[3] * 100}%` });
      for (const [k, v] of [['w', r[2]], ['h', r[3]], ['x', r[0]], ['y', r[1]]]) {
        const o = sl[k]; if (!o) continue;
        const inp = o.querySelector('input'), val = o.querySelector('.val');
        if (document.activeElement !== inp) inp.value = v;
        val.textContent = pct(v);
      }
    }
    // keeps it inside the picture; with the 16:9 shape on, the height follows the width
    function setRect(x, y, w, h, quiet) {
      w = clamp(w, 0.05, 1); h = keep() ? w * A : h;
      if (h > 1) { h = 1; if (keep()) w = h / A; }
      h = clamp(h, 0.05, 1);
      p.rect = { x: clamp(x, 0, 1 - w), y: clamp(y, 0, 1 - h), w: +w.toFixed(4), h: +h.toFixed(4) };
      p.rect.x = +p.rect.x.toFixed(4); p.rect.y = +p.rect.y.toFixed(4);
      place(); if (!quiet) changed();
    }
    const snap = (v, cands) => { for (const c of cands) if (Math.abs(v - c) < 0.015) return c; return v; };
    let drag = null;
    box.addEventListener('pointerdown', e => {
      e.preventDefault(); box.setPointerCapture(e.pointerId);
      const r = R(), a = area.getBoundingClientRect();
      drag = { c: e.target.dataset && e.target.dataset.c, px: e.clientX, py: e.clientY, r, aw: a.width, ah: a.height };
    });
    box.addEventListener('pointermove', e => {
      if (!drag) return;
      const { r, c } = drag, dx = (e.clientX - drag.px) / drag.aw, dy = (e.clientY - drag.py) / drag.ah;
      if (!c) { // move (snaps to the edges' margin and the centre lines; Alt = no snapping)
        let x = r[0] + dx, y = r[1] + dy;
        if (!e.altKey) { x = snap(x, [mx, 1 - r[2] - mx, (1 - r[2]) / 2, 0, 1 - r[2]]); y = snap(y, [my, 1 - r[3] - my, (1 - r[3]) / 2, 0, 1 - r[3]]); }
        setRect(x, y, r[2], r[3]);
        return;
      }
      // resize from a corner; the opposite corner stays where it is
      const x1 = r[0] + r[2], y1 = r[1] + r[3];
      let w = c.includes('l') ? r[2] - dx : r[2] + dx, h = c.includes('t') ? r[3] - dy : r[3] + dy;
      if (keep()) { w = Math.max(w, h / A); h = w * A; }
      w = clamp(w, 0.05, c.includes('l') ? x1 : 1 - r[0]); h = keep() ? w * A : clamp(h, 0.05, c.includes('t') ? y1 : 1 - r[1]);
      if (keep() && h > (c.includes('t') ? y1 : 1 - r[1])) { h = c.includes('t') ? y1 : 1 - r[1]; w = h / A; }
      setRect(c.includes('l') ? x1 - w : r[0], c.includes('t') ? y1 - h : r[1], w, h);
    });
    const end = () => { if (drag) { drag = null; logEvent('SHOT', `“${s.name}” small picture at ${JSON.stringify(p.rect)}`); } };
    box.addEventListener('pointerup', end); box.addEventListener('pointercancel', end);
    // ready-made positions (keep the size)
    const spots = [['tl', '↖'], ['tc', '↑'], ['tr', '↗'], ['ml', '←'], ['mc', '●'], ['mr', '→'], ['bl', '↙'], ['bc', '↓'], ['br', '↘']];
    const goSpot = k => { const r = R(); const x = k[1] === 'l' ? mx : k[1] === 'r' ? 1 - r[2] - mx : (1 - r[2]) / 2, y = k[0] === 't' ? my : k[0] === 'b' ? 1 - r[3] - my : (1 - r[3]) / 2; setRect(x, y, r[2], r[3]); };
    const grid = el('div', { class: 'pip-grid' }, spots.map(([k, t]) => el('button', { class: 'btn small', title: 'Move it here (keeps the size)', onclick: () => goSpot(k) }, t)));
    const sizes = el('div', { class: 'row wrap', style: 'gap:4px' }, el('span', { class: 'muted', style: 'font-size:.85em' }, 'Size'),
      [[0.25, '¼'], [1 / 3, '⅓'], [0.5, '½'], [1, 'Full']].map(([v, t]) => el('button', { class: 'btn small', onclick: () => { const r = R(); const cx = r[0] + r[2] / 2, cy = r[1] + r[3] / 2; const h = keep() ? v * A : v; setRect(cx - v / 2, cy - h / 2, v, h); } }, t)));
    const r0 = R();
    sl.w = slider({ label: 'Width', min: 0.05, max: 1, step: 0.005, value: r0[2], reset: 0.3, fmt: pct, onInput: v => { const r = R(); setRect(r[0], r[1], v, r[3]); } });
    if (!keep()) sl.h = slider({ label: 'Height', min: 0.05, max: 1, step: 0.005, value: r0[3], reset: 0.3, fmt: pct, onInput: v => { const r = R(); setRect(r[0], r[1], r[2], v); } });
    sl.x = slider({ label: 'From left', min: 0, max: 1, step: 0.005, value: r0[0], reset: mx, fmt: pct, onInput: v => { const r = R(); setRect(v, r[1], r[2], r[3]); } });
    sl.y = slider({ label: 'From top', min: 0, max: 1, step: 0.005, value: r0[1], reset: my, fmt: pct, onInput: v => { const r = R(); setRect(r[0], v, r[2], r[3]); } });
    requestAnimationFrame(place);
    return el('div', { style: 'margin-top:8px' },
      el('div', { class: 'field' }, el('span', null, 'Small picture'), select(sourceOptions(false), p.source, v => { p.source = v; changed(); refresh('editor'); })),
      el('div', { class: 'field' }, el('span', null, 'Where it goes — drag it, pull a corner to resize'), area),
      el('div', { class: 'row wrap', style: 'gap:14px;margin:8px 0;align-items:flex-start' }, grid,
        el('div', { class: 'grow', style: 'min-width:220px' }, sizes, sl.w, sl.h || null, sl.x, sl.y)),
      el('div', { class: 'row wrap', style: 'gap:16px' },
        check(' Keep the 16:9 shape', keep(), v => { p.keep = v; const r = R(); setRect(r[0], r[1], r[2], v ? r[2] * A : r[3]); refresh('editor'); }),
        check(' White border', p.border !== false, v => { p.border = v; changed(); })),
      el('div', { class: 'muted', style: 'font-size:.85em;margin-top:6px' }, 'To zoom into or move the picture inside the small box, use “Frame: small picture” at the top. Double-click a slider to reset it.'));
  }
  function padGeom(s) {
    const L = padLayer(s);
    const r = pad.getBoundingClientRect();
    const sz = engine.sourceSize(L.source) || { w: 16, h: 9 };
    const sa = sz.w / sz.h, pa = r.width / r.height || 16 / 9;
    let sr;
    if (sa > pa) { const h = r.width / sa; sr = { x: 0, y: (r.height - h) / 2, w: r.width, h }; }
    else { const w = r.height * sa; sr = { x: (r.width - w) / 2, y: 0, w, h: r.height }; }
    const aspect = rt.padTarget === 'pip' && s.pip.enabled ? pipAspect(s) : engine.W / engine.H;
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
    const uv = engine.uvFor(L.source, L.frame, rt.padTarget === 'pip' && s.pip.enabled ? pipAspect(s) : engine.W / engine.H);
    L.frame.x = uv[0] + uv[2] / 2; L.frame.y = uv[1] + uv[3] / 2; // keep inside the picture
    updatePadBox(); changed();
    const z = $('#zoomVal'); if (z) z.textContent = `${L.frame.zoom.toFixed(2)}×`;
    const zi = $('#zoomInput'); if (zi && +zi.value !== L.frame.zoom) zi.value = L.frame.zoom;
  }
  let padDrag = null;
  pad.addEventListener('pointerdown', e => {
    const s = getShot(rt.editingId); if (!s) return;
    if (rt.pickGreen) { // green screen: this click picks the colour to remove
      const r = padCanvas.getBoundingClientRect(), x = (e.clientX - r.left) / r.width * padCanvas.width, y = (e.clientY - r.top) / r.height * padCanvas.height;
      const c = greenSample(x, y);
      rt.pickGreen = false; pad.classList.remove('picking');
      if (c) { greenCfg(s).color = c; changed(); toast(`Green screen colour ${c} picked.`, 'ok'); } else toast('Click on the green part of the picture.', 'error');
      refresh('editor'); return;
    }
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
        el('div', { class: 'section' }, el('h4', null, 'Music before the service'), holdMusicPicker(), mixPanel(s)),
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
        s.pip.enabled ? pipPanel(s) : null),

      el('div', { class: 'section' }, el('h4', null, 'Green screen'),
        check(' Replace the green behind the picture with a background', !!(s.green && s.green.on), v => {
          const g = greenCfg(s); g.on = v;
          if (v && !g.bg) { const pic = show.files.find(f => f.kind === 'image'); g.bg = pic ? pic.id : 'black'; }
          if (v && !g.picked) { const c = greenAuto(); if (c) g.color = c; g.picked = true; }
          if (!v && engine.matteId === s.id) engine.matteId = null;
          changed(); refresh('editor');
        }),
        s.green && s.green.on ? greenPanel(s) : null),

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

      !s.role ? el('div', { class: 'section' }, el('h4', null, 'Music under this shot'),
        el('div', { class: 'row' },
          select([['', '— no music —'], ...show.files.filter(f => f.kind === 'audio').map(f => [f.id, '♪ ' + f.name])], s.music || '', v => { s.music = v; changed(); refresh('editor'); }, { class: 'grow' }),
          el('button', { class: 'btn small', onclick: async () => { const a = await addFiles(); const m = a.find(f => f.kind === 'audio'); if (m) { s.music = m.id; changed(); refresh('editor'); } } }, 'Import…')),
        el('div', { class: 'muted', style: 'font-size:.85em;margin-top:4px' }, 'Plays from the start each time this shot goes live — e.g. a slide with background music. Tick “Loop” on the music file in Inputs to repeat it.')) : null,

      el('div', { class: 'section' }, el('h4', null, 'Sound while this shot is live'),
        select(SOUND_MODES, s.sound || 'auto', v => { s.sound = v; changed(); refreshOnAir(s); refresh('editor'); }),
        el('div', { class: 'muted', style: 'font-size:.85em;margin-top:4px' }, `Now: ${{ video: 'only the video / music', live: 'only the sound desk / cameras', both: 'video sound and sound desk together' }[soundMode(s)]}.`),
        mixPanel(s)),

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

  /* the shot's own mixer: a volume slider for each sound it uses */
  function mixPanel(s, only) {
    const m = mixOf(s), kinds = mediaOf(s).map(id => (fileById(id) || {}).kind);
    const row = (key, label) => slider({ label, min: -40, max: 10, step: 0.5, value: m[key], reset: 0,
      fmt: v => v <= -40 ? 'off' : `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`,
      onInput: v => { s.mix = Object.assign(mixOf(s), { [key]: v }); changed(); refreshOnAir(s); } });
    const rows = [
      kinds.includes('audio') && videoSoundOn(s) && (!only || only === 'music') ? row('music', '♪ Music') : null,
      kinds.includes('video') && videoSoundOn(s) && (!only || only === 'video') ? row('video', '🎞 Video sound') : null,
      liveInputsOn(s) && !holdMuted(s) && !only ? row('live', '🎚 Sound desk') : null
    ].filter(Boolean);
    if (only) return rows[0] || null;
    return el('div', { class: 'shot-mix' },
      el('div', { class: 'shot-mix-title' }, '🎛 Volume while this shot is live'),
      rows.length ? rows : el('div', { class: 'muted', style: 'font-size:.85em' }, 'No sound for this shot.'),
      el('div', { class: 'muted', style: 'font-size:.8em;margin-top:4px' }, 'Double-click a slider to go back to 0 dB. To hear it before it goes live, put the shot in Preview and press 🎧 Listen.'));
  }
  function holdMusicPicker(after) {
    const H = SV().hold, h = getShot('shot_hold');
    const apply = () => { syncRoleShots(); changed(); refreshOnAir(getShot('shot_hold')); refresh('editor'); refresh('media'); if (after) after(); };
    return el('div', null,
      el('div', { class: 'row' },
        select([['', '— no music —'], ...show.files.filter(f => f.kind === 'audio').map(f => [f.id, '♪ ' + f.name])], H.musicId || '', v => { H.musicId = v; apply(); }, { class: 'grow' }),
        el('button', { class: 'btn small', onclick: async () => { const a = await addFiles(); const m = a.find(f => f.kind === 'audio'); if (m) { H.musicId = m.id; apply(); } else if (a.length) toast('That is not a music file (MP3, WAV, M4A).', 'error'); } }, 'Import…')),
      H.musicId ? el('div', { style: 'margin:6px 0' }, check(' Repeat the music', H.musicLoop !== false, v => { H.musicLoop = v; changed(); const f = rt.files.get(H.musicId); if (f && f.el && engine.programId === 'shot_hold') f.el.loop = v; })) : null,
      el('div', { class: 'muted', style: 'font-size:.85em' }, H.mute !== false ? 'While the holding slide is up, only this music is heard (cameras / sound desk are muted).' : 'The holding slide is set to also let the cameras / sound desk through.'));
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
    // rt.webCanvas holds a small copy just for the thumbnails on screen; the full picture goes straight to the graphics card
    let c = rt.webCanvas.get(w.id);
    if (!c) { c = el('canvas', { width: 480, height: 270 }); rt.webCanvas.set(w.id, c); }
    rt.webBuf.delete(w.id);
    engine.setRawSource(w.id);
    engine.setWeb(engineWeb(w), webWanted(w.id));
    S.webOpen(w.id, { url: w.url, width: pw, height: ph, fps: w.fps, zoom: w.zoom, transparent: w.transparent, css: w.css });
  }
  function closeWeb(id) { S.webClose(id); engine.removeWeb(id); engine.removeSource(id); rt.webCanvas.delete(id); rt.webBuf.delete(id); }
  const engineWeb = w => ({ id: w.id, rect: w.rect, opacity: w.opacity, key: w.key, fadeMs: w.fadeMs });
  rt.webBuf = new Map();
  S.onWebFrame(f => {
    if (!rt.webCanvas.has(f.id)) return;
    engine.rawPatch(f.id, f);                         // to the graphics card as it is (no per-pixel work here)
    // keep the latest full-size pixels so the small on-screen thumbnail can be refreshed now and then
    let b = rt.webBuf.get(f.id);
    if (f.full || !b || b.w !== f.w || b.h !== f.h) { if (!f.full) return; b = { w: f.w, h: f.h, px: new Uint8Array(f.w * f.h * 4) }; rt.webBuf.set(f.id, b); }
    if (f.full) b.px.set(f.data);
    else { const row = f.rw * 4; for (let r = 0; r < f.rh; r++) b.px.set(f.data.subarray(r * row, r * row + row), ((f.y + r) * f.w + f.x) * 4); }
    b.dirty = true;
  });
  // thumbnails of web pages: twice a second, from a sample of the pixels (cheap)
  setInterval(() => {
    for (const [id, b] of rt.webBuf) {
      const c = rt.webCanvas.get(id);
      if (!c || !b.dirty || !b.w || !b.h || !b.px) continue;
      b.dirty = false;
      const tw = Math.min(480, b.w), th = Math.max(1, Math.round(tw * b.h / b.w));
      if (c.width !== tw || c.height !== th) { c.width = tw; c.height = th; }
      const img = new ImageData(tw, th), d = img.data, src = b.px;
      for (let y = 0; y < th; y++) {
        const sy = Math.floor(y * b.h / th) * b.w;
        for (let x = 0; x < tw; x++) {
          const si = (sy + Math.floor(x * b.w / tw)) * 4, di = (y * tw + x) * 4, a = src[si + 3];
          const k = a ? 255 / a : 0;
          d[di] = Math.min(255, src[si + 2] * k); d[di + 1] = Math.min(255, src[si + 1] * k); d[di + 2] = Math.min(255, src[si] * k); d[di + 3] = a;
        }
      }
      c.getContext('2d').putImageData(img, 0, 0);
    }
  }, 500);
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
      for (const b of quickRowOf(id)) if (b.id && b.id !== id && (engine.webVisible(b.id) || rt.webManual.has(b.id))) { rt.webManual.delete(b.id); rt.webSuppress.add(b.id); const pp = show.pics.find(x => x.id === b.id); if (pp) pp.on = false; }
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
    syncQuick();
  }

  /* ---------- quick buttons: translation direction and logo style, one press each ---------- */
  // show.quick = { tr: [{label, id}], logo: [{label, id}] } — id = a web page (translation) or a picture (logo)
  // only pictures that are clearly logos go on the logo buttons by themselves (never a donation slide etc.)
  const LOGO_NAME = /logo|лого/i, XMAS_NAME = /christ|xmas|рожд/i;
  function ensureQuick() {
    if (show.quick && show.quick.tr && show.quick.logo) {
      if (show.quick.v !== 2) {
        // 1.28.0 put the first picture on “Regular” even when it was not a logo (e.g. the donation slide) — undo that
        const used = new Set();
        for (const b of show.quick.logo) { const p2 = show.pics.find(x => x.id === b.id); if (p2 && !LOGO_NAME.test(p2.name || '') && !XMAS_NAME.test(p2.name || '') && !/easter|пасх/i.test(p2.name || '')) b.id = ''; if (b.id) used.add(b.id); }
        const fill = (b, rx) => { if (b && !b.id) { const p2 = show.pics.find(x => !used.has(x.id) && rx.test(x.name || '')); if (p2) { b.id = p2.id; used.add(p2.id); } } };
        fill(show.quick.logo[1], XMAS_NAME); fill(show.quick.logo[0], LOGO_NAME);
        show.quick.v = 2;
      }
      return show.quick;
    }
    const txt = w => `${w.name || ''} ${w.url || ''}`;
    const dir = (a, b) => new RegExp(`(^|[^a-z])${a}[^a-z]{0,5}(to[^a-z]{0,3})?${b}([^a-z]|$)`, 'i');
    const ruen = show.webs.find(w => dir('ru', 'en').test(txt(w)) || /рус.*англ/i.test(txt(w)));
    const enru = show.webs.find(w => w !== ruen && (dir('en', 'ru').test(txt(w)) || /англ.*рус/i.test(txt(w))));
    const xmas = show.pics.find(p2 => XMAS_NAME.test(p2.name || ''));
    const reg = show.pics.find(p2 => p2 !== xmas && LOGO_NAME.test(p2.name || ''));
    show.quick = { v: 2,
      tr: [{ label: 'RU → EN', id: ruen ? ruen.id : '' }, { label: 'EN → RU', id: enru ? enru.id : '' }],
      logo: [{ label: 'Regular', id: reg ? reg.id : '' }, { label: 'Christmas', id: xmas ? xmas.id : '' }]
    };
    return show.quick;
  }
  const quickExists = b => !!(b && b.id && (show.webs.some(w => w.id === b.id) || show.pics.some(p2 => p2.id === b.id)));
  function quickRowOf(id) { const q = ensureQuick(); return [q.tr, q.logo].find(r => r.some(b => b.id === id)) || []; }
  const quickIds = () => { const q = ensureQuick(); return new Set([...q.tr, ...q.logo].filter(quickExists).map(b => b.id)); };
  function syncQuick() {
    document.querySelectorAll('.qbtn[data-gid]').forEach(b => {
      const id = b.dataset.gid, on = engine.webVisible(id), armed = rt.armedGfx === id;
      b.classList.toggle('on', on); b.classList.toggle('armed', armed);
      const st = b.querySelector('.q-state'); if (st) st.textContent = armed ? (on ? 'TAKE HIDES' : 'IN PREVIEW') : on ? 'ON AIR' : '';
    });
  }
  function quickStrip() {
    const q = ensureQuick();
    const btn = b => {
      if (!quickExists(b)) return el('button', { class: 'qbtn unset', title: 'Choose what this button shows', onclick: openQuickSetup }, el('span', { class: 'q-name' }, b.label || '—'), el('span', { class: 'q-state' }, 'set up'));
      const it = () => gfxItems().find(x => x.id === b.id);
      return el('button', { class: 'qbtn', dataset: { gid: b.id },
        title: 'Click = Preview, then TAKE (Ctrl+G) · double-click = on air now (or off)',
        onclick: () => armGfx(rt.armedGfx === b.id ? null : b.id),
        ondblclick: () => { armGfx(null); const x = it(); if (x) { x.toggle(); refresh('labels'); } } },
        el('span', { class: 'q-name' }, b.label || '—'), el('span', { class: 'q-state' }));
    };
    const strip = el('div', { class: 'quick' },
      el('div', { class: 'q-group' }, el('span', { class: 'q-label' }, 'Translation'), el('div', { class: 'q-btns' }, ...q.tr.map(btn))),
      el('div', { class: 'q-group' }, el('span', { class: 'q-label' }, 'Logo'), el('div', { class: 'q-btns' }, ...q.logo.map(btn))),
      el('span', { class: 'grow' }),
      el('button', { class: 'btn small q-gear', title: 'Choose which web page / picture each button shows', onclick: openQuickSetup }, '⚙'));
    requestAnimationFrame(syncQuick);
    return strip;
  }
  function openQuickSetup() {
    const q = ensureQuick(), body = el('div');
    const row = (b, kind, list, removable) => el('div', { class: 'q-setrow' },
      el('input', { type: 'text', class: 'q-lbl', value: b.label, placeholder: 'Button name', oninput: e => { b.label = e.target.value; changed(); refresh('labels'); } }),
      select([['', kind === 'web' ? '— choose the translation page —' : '— choose the logo picture —'], ...list.map(x => [x.id, x.name || (kind === 'web' ? 'Web page' : 'Picture')])], quickExists(b) ? b.id : '', v => { b.id = v; changed(); refresh('labels'); draw(); }, { class: 'grow' }),
      quickExists(b) ? el('button', { class: 'btn small', title: 'Edit', onclick: () => (kind === 'web' ? editWeb(show.webs.find(w => w.id === b.id)) : editPic(show.pics.find(p2 => p2.id === b.id))) }, '✎ Edit') : null,
      el('button', { class: 'btn small', onclick: () => { if (kind === 'web') { const w = newWeb(); w.name = `Translation ${b.label}`; b.id = w.id; changed(); editWeb(w, true); } else { const p2 = newPic(); p2.name = `Logo — ${b.label}`; b.id = p2.id; changed(); editPic(p2, true); } } }, '+ New'),
      removable ? el('button', { class: 'btn small danger', title: 'Remove this button', onclick: () => { q.logo = q.logo.filter(x => x !== b); changed(); refresh('labels'); draw(); } }, '✕') : null);
    const draw = () => {
      body.innerHTML = '';
      put(body,
        el('h3', null, '🌐 Translation'),
        el('div', { class: 'muted', style: 'font-size:.85em;margin-bottom:6px' }, 'Each button shows one web page (the live translation captions). Only one is on at a time — pressing the other switches over.'),
        q.tr.map(b => row(b, 'web', show.webs, false)),
        el('h3', null, '🖼 Logo'),
        el('div', { class: 'muted', style: 'font-size:.85em;margin-bottom:6px' }, 'Each button shows one logo picture — e.g. the regular logo and a Christmas one. Only one is on at a time.'),
        q.logo.map((b, i) => row(b, 'pic', show.pics, i >= 2)),
        q.logo.length < 3 ? el('button', { class: 'btn small', onclick: () => { q.logo.push({ label: 'Easter', id: '' }); changed(); refresh('labels'); draw(); } }, '+ Add a third logo button') : null,
        el('div', { class: 'row', style: 'margin-top:16px' }, el('span', { class: 'grow' }), el('button', { class: 'btn primary', onclick: () => { closeModal(); refresh('labels'); } }, 'Done')));
    };
    draw();
    openModal('Quick buttons — translation & logo', body);
  }
  function editWeb(w, isNew) {
    const body = el('div');
    const view = el('canvas', { width: 480, height: 270, style: 'width:100%;aspect-ratio:16/9;border-radius:8px;display:block;background:repeating-conic-gradient(#2a2a2e 0% 25%, #1c1c1f 0% 50%) 50% / 24px 24px' });
    const reopen = debounce(() => { if (show.webs.includes(w)) openWeb(w); }, 700);
    const live = () => { engine.setWeb(engineWeb(w)); changed(); };
    let raf = 0;
    const paint = () => { if (!view.isConnected) return; const c = rt.webCanvas.get(w.id), g = view.getContext('2d'); g.clearRect(0, 0, 480, 270); g.fillStyle = 'rgba(37,99,235,.25)'; const r = w.rect; g.fillRect(r[0] * 480, r[1] * 270, r[2] * 480, r[3] * 270); if (c && c.width && c.height) g.drawImage(c, r[0] * 480, r[1] * 270, r[2] * 480, r[3] * 270); raf = requestAnimationFrame(paint); };
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
  function togglePic(id) { toggleWeb(id); const p2 = show.pics.find(x => x.id === id); if (p2) p2.on = rt.webManual.has(id); } // showing / hiding during the service is not an edit
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
    const off = el('canvas', { width: 960, height: 540 }), toff = el('canvas', { width: 320, height: 180 });
    const pctx = pv.getContext('2d'), octx = off.getContext('2d');
    let prog = 1, goingOut = false, playId = 0;
    const D = () => labelDesign(holder);
    const base = key => labelDesign({ style: holder.style })[key];
    const sampleOf = (style, design) => ({ title: sample.title || 'John Smith', subtitle: sample.subtitle === undefined ? 'Senior Pastor' : sample.subtitle, style, color: holder.color, design });
    const backdrop = (g, w, h) => {
      const gr = g.createLinearGradient(0, 0, w, h);
      gr.addColorStop(0, '#3b4a63'); gr.addColorStop(0.5, '#7b6a58'); gr.addColorStop(1, '#1f2937');
      g.globalAlpha = 1; g.fillStyle = gr; g.fillRect(0, 0, w, h);
      g.fillStyle = 'rgba(255,255,255,.10)'; g.beginPath(); g.arc(w / 2, h * 0.46, h * 0.2, 0, 7); g.fill(); g.fillRect(w * 0.344, h * 0.685, w * 0.312, h * 0.315);
    };
    const paint = () => { backdrop(pctx, 960, 540); drawLabel(octx, 960, 540, sampleOf(holder.style, holder.design), prog, goingOut); pctx.drawImage(off, 0, 0); };
    // one animation run: progress goes 0 → 1 (coming in) or 1 → 0 (going out)
    const run = (id, ms, out, frame, done) => {
      const t0 = performance.now();
      const step = () => {
        if (id() || !pv.isConnected) return;
        const t = ms ? Math.min(1, (performance.now() - t0) / ms) : 1;
        frame(out ? 1 - t : t, out);
        if (t < 1) requestAnimationFrame(step); else if (done) done();
      };
      step();
    };
    // ▶ Test: comes in, stays a moment, goes out, then shows again
    const play = () => {
      const id = ++playId, stale = () => id !== playId, d = sampleOf(holder.style, holder.design);
      const frame = (pp, out) => { prog = pp; goingOut = out; paint(); };
      frame(0, false);
      setTimeout(() => !stale() && run(stale, labelAnimMs(d, false), false, frame, () =>
        setTimeout(() => !stale() && run(stale, labelAnimMs(d, true), true, frame, () =>
          setTimeout(() => { if (!stale()) frame(1, false); }, 450)), 1300)), 200);
    };
    const thumbs = [];
    const drawThumb = (c, key, pp = 1) => {
      const g = c.getContext('2d');
      backdrop(g, c.width, c.height);
      // drawn larger than real so the design can be seen at thumbnail size
      const dz = key === holder.style ? holder.design : {}, z0 = labelDesign({ style: key, design: dz });
      drawLabel(toff.getContext('2d'), 320, 180, sampleOf(key, Object.assign({}, dz, { size: z0.size * Math.min(1.9, 2.3 / z0.size), margin: Math.min(z0.margin, 0.06) })), pp);
      g.drawImage(toff, 0, 0, c.width, c.height);
    };
    const redrawThumbs = () => thumbs.forEach(([c, key]) => drawThumb(c, key));
    const hoverPlay = (c, key) => {
      const id = (c._pid = (c._pid || 0) + 1), stale = () => id !== c._pid || !c.isConnected;
      run(stale, labelAnimMs(sampleOf(key, {}), false), false, pp => drawThumb(c, key, pp));
    };
    const set = (k, v) => { holder.design = Object.assign({}, holder.design, { [k]: v }); onChange(); paint(); };
    const body = el('div');
    const draw = () => {
      const d = D();
      body.innerHTML = ''; thumbs.length = 0;
      const color = (label, value, fn) => el('label', { class: 'inline' }, el('input', { type: 'color', value, oninput: e => fn(e.target.value) }), label);
      const looks = el('div', { class: 'look-grid' }, LABEL_STYLES.map(([key, name]) => {
        const c = el('canvas', { width: 320, height: 180 });
        thumbs.push([c, key]);
        return el('button', { class: 'look' + (holder.style === key ? ' sel' : ''), title: 'Use the “' + name + '” design (point at it to see it animate)',
          onmouseenter: () => hoverPlay(c, key),
          onclick: () => { holder.style = key; holder.design = {}; onChange(); draw(); paint(); play(); } }, c, el('span', null, name));
      }));
      const anims = el('div', { class: 'anim-grid' }, LABEL_ANIMS.map(([key, name, hint]) =>
        el('button', { class: 'btn small' + (d.anim === key ? ' sel' : ''), title: hint, onclick: e => {
          set('anim', key);
          anims.querySelectorAll('.btn').forEach(b => b.classList.remove('sel')); e.currentTarget.classList.add('sel');
          play();
        } }, name)));
      const layout = d.layout || 'stack';
      put(body,
        pv,
        el('div', { class: 'row wrap', style: 'margin:10px 0 6px' },
          el('h3', { style: 'margin:0' }, 'Design'), el('span', { class: 'muted', style: 'font-size:.85em' }, 'point at one to see it animate, click to use it'),
          el('span', { class: 'grow' }),
          el('button', { class: 'btn small primary', onclick: play }, '▶ Test in & out')),
        looks,
        el('h3', null, 'How it comes in'),
        anims,
        el('div', { class: 'grid2', style: 'margin-top:8px' },
          el('div', { class: 'field' }, el('span', null, 'Speed'), select([[0, 'Instant — no animation'], [150, 'Fast'], [300, 'Normal'], [450, 'Relaxed'], [600, 'Smooth'], [1000, 'Slow'], [2000, 'Very slow']], d.fadeMs, v => { set('fadeMs', +v); play(); })),
          el('div', { class: 'field' }, el('span', null, 'How it leaves'), select([['reverse', 'The same way, backwards'], ['fade', 'Just fade out']], d.animOut, v => { set('animOut', v); play(); }))),
        el('div', { class: 'grid2', style: 'margin-top:6px' },
          el('div', null,
            el('h3', null, 'Text'),
            el('div', { class: 'field' }, el('span', null, 'Font'), select(['Segoe UI', 'Arial', 'Calibri', 'Verdana', 'Trebuchet MS', 'Bahnschrift', 'Georgia', 'Times New Roman', 'Impact', 'Consolas'].map(f => [f, f]), d.font, v => set('font', v))),
            slider({ label: 'Size', min: 0.5, max: 2.5, step: 0.05, value: d.size, reset: base('size'), fmt: v => `${Math.round(v * 100)}%`, onInput: v => set('size', v) }),
            el('div', { class: 'row wrap', style: 'gap:16px;margin:8px 0' },
              check(' Bold', d.bold, v => set('bold', v)), check(' Italic', d.italic, v => set('italic', v)), check(' ALL CAPS', d.upper, v => set('upper', v)), check(' Shadow', d.shadow, v => set('shadow', v))),
            el('div', { class: 'row wrap', style: 'gap:16px' },
              color('Main text', d.textColor, v => set('textColor', v)), color('Second line', d.subColor, v => set('subColor', v))),
            el('h4', { style: 'margin:12px 0 4px' }, 'Second line'),
            slider({ label: 'Size', min: 0.6, max: 1.5, step: 0.02, value: d.subSize, reset: base('subSize'), fmt: v => `${Math.round(v * 100)}%`, onInput: v => set('subSize', v) }),
            slider({ label: 'Letter spacing', min: 0, max: 10, step: 0.5, value: d.subSpacing, reset: base('subSpacing'), fmt: v => v ? `${v}` : 'normal', onInput: v => set('subSpacing', v) }),
            el('div', { class: 'row wrap', style: 'gap:16px;margin:6px 0' },
              check(' CAPS', d.subUpper, v => set('subUpper', v)), check(' In accent colour', d.subAccent, v => set('subAccent', v)))),
          el('div', null,
            el('h3', null, 'Shape'),
            el('div', { class: 'field' }, el('span', null, 'Layout'), select([['stack', 'A box for each line'], ['panel', 'One panel'], ['tag', 'Small tag above the name'], ['split', 'Side by side, one line'], ['band', 'Full-width band']], layout, v => { set('layout', v); draw(); paint(); })),
            layout === 'stack' ? el('div', { class: 'field' }, el('span', null, 'Second line box'), select([['auto', 'Automatic'], ['accent', 'Accent colour'], ['box', 'Same as the name box'], ['none', 'No box']], d.subBox, v => set('subBox', v))) : null,
            layout === 'panel' ? el('div', { style: 'margin:4px 0 8px' }, check(' Fade the panel out to the side', d.fadeEdge, v => set('fadeEdge', v))) : null,
            el('div', { class: 'row wrap', style: 'gap:16px;margin:6px 0 8px' },
              color('Box colour', d.bgColor, v => set('bgColor', v)),
              color('Accent colour', holder.color || '#2563eb', v => { holder.color = v; onChange(); paint(); redrawThumbs(); })),
            slider({ label: 'Box opacity', min: 0, max: 1, step: 0.02, value: d.bgOpacity, reset: base('bgOpacity'), fmt: v => v < 0.02 ? 'no box' : `${Math.round(v * 100)}%`, onInput: v => set('bgOpacity', v) }),
            slider({ label: 'Round corners', min: 0, max: 60, step: 1, value: d.radius, reset: base('radius'), fmt: v => v >= 60 ? 'full' : `${v}`, onInput: v => set('radius', v) }),
            slider({ label: 'Slant', min: 0, max: 20, step: 1, value: d.skew, reset: base('skew'), fmt: v => v ? `${v}°` : 'none', onInput: v => set('skew', v) }),
            el('div', { class: 'field' }, el('span', null, 'Accent'), select([['left', layout === 'split' ? 'Dot at the start' : 'Bar on the side'], ['under', 'Line underneath'], ['top', 'Line on top'], ['none', 'None']], d.bar, v => set('bar', v))),
            slider({ label: 'Accent thickness', min: 2, max: 30, step: 1, value: d.barWidth, reset: base('barWidth'), fmt: v => `${v}`, onInput: v => set('barWidth', v) }),
            el('h3', null, 'Position on screen'),
            el('div', { class: 'pos-grid' }, ['tl', 'tc', 'tr', 'ml', 'mc', 'mr', 'bl', 'bc', 'br'].map(p => el('button', { class: 'btn' + (d.position === p ? ' sel' : ''), title: p, onclick: () => { set('position', p); draw(); } }, d.position === p ? '●' : ''))),
            slider({ label: 'From edge', min: 0.02, max: 0.25, step: 0.005, value: d.margin, reset: base('margin'), fmt: v => `${Math.round(v * 100)}%`, onInput: v => set('margin', v) }))),
        el('div', { class: 'row', style: 'margin-top:14px' },
          el('button', { class: 'btn small', onclick: () => { holder.design = {}; onChange(); draw(); paint(); } }, 'Reset this design'),
          el('button', { class: 'btn small', onclick: () => {
            const look = { style: holder.style, color: holder.color, design: clone(holder.design || {}) };
            show.labels.forEach(L => { Object.assign(L, clone(look)); engine.setLabel(L); });
            Object.assign(show.speakerStyle, clone(look)); restyleSpeaker();
            toast('This look is now used for all labels and speaker names.', 'ok');
          } }, 'Use this look for all labels and speakers'),
          el('span', { class: 'grow' }),
          el('button', { class: 'btn primary', onclick: () => { closeModal(); refresh('labels'); refresh('speakers'); } }, 'Done')));
      redrawThumbs();
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
    const KIND = { pic: 0, web: 1, label: 2 }; // slides / pictures first: they are what is put up mid-service
    const rank = it => { const i = ord.indexOf(it.id); return i < 0 ? 1e6 + KIND[it.kind] * 1e4 : i; };
    return items.map((it, i) => [rank(it), i, it]).sort((x, y) => x[0] - y[0] || x[1] - y[1]).map(x => x[2]);
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
  function addGfx() {
    const newTitle = () => {
      const last = show.labels[show.labels.length - 1] || show.speakerStyle;
      const L = { id: uid('lbl'), title: 'New title', subtitle: '', style: last.style || 'lower', color: last.color || settings.ui.accent, design: clone(last.design || {}), autoHide: 0 };
      show.labels.push(L); engine.setLabel(L, false); changed(); refresh('labels'); editLabel(L);
    };
    openModal('Add to Titles & Graphics', el('div', { class: 'add-choices' },
      el('button', { class: 'btn big', onclick: () => { closeModal(); newTitle(); } }, 'T  Title / caption'),
      el('button', { class: 'btn big', onclick: () => { closeModal(); editPic(newPic(), true); } }, '🖼  Picture (logo)'),
      el('button', { class: 'btn big', onclick: () => { closeModal(); editWeb(newWeb(), true); } }, '🌐  Web page (translation…)'),
      el('button', { class: 'btn big', onclick: () => { closeModal(); openQuickSetup(); } }, '⚙  Quick buttons (translation & logo)')));
  }
  RENDER.labels = body => {
    body.innerHTML = '';
    body.classList.add('gfx-body');
    const row = el('div', { class: 'tile-row' });
    const inQuick = quickIds();
    const items = gfxItems().filter(it => !inQuick.has(it.id)); // translation & logos are on the quick buttons
    for (const it of items) {
      const on = it.on();
      const ds = { gid: it.id }; ds[it.kind === 'label' ? 'label' : it.kind] = it.id;
      // a button with a small picture of the graphic and its name (the Preview shows it full size when cued)
      const thumb = el('canvas', { width: 192, height: 108, class: 'chip-thumb' });
      drawGfxThumb(thumb, it);
      const tile = el('div', { class: `gtile chip ${it.kind}` + (on ? ' on' : '') + (rt.armedGfx === it.id ? ' armed' : ''), dataset: ds, draggable: 'true',
        title: on ? 'On air · click to cue hiding it, then TAKE (Ctrl+G) · double-click to hide right away · drag to reorder' : 'Click to put it in Preview, then TAKE (Ctrl+G) · double-click to show right away · drag to reorder',
        onclick: () => armGfx(rt.armedGfx === it.id ? null : it.id),
        ondblclick: () => { armGfx(null); it.toggle(); refresh('labels'); } },
        el('div', { class: 'g-cap' }, thumb, el('span', { class: 'g-title' }, it.name), keyChip(it.key)),
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
    row.append(el('div', { class: 'gtile add', title: 'Add a title, picture or web page', onclick: addGfx }, '＋'));
    // mouse wheel scrolls the row sideways when it is longer than the panel
    row.addEventListener('wheel', e => { if (row.scrollWidth > row.clientWidth && Math.abs(e.deltaY) > Math.abs(e.deltaX)) { row.scrollLeft += e.deltaY; e.preventDefault(); } }, { passive: false });
    put(body, quickStrip(), row);
  };
  setInterval(() => { document.querySelectorAll('.gtile.web, .gtile.pic').forEach(t => { const c = t.querySelector('canvas'); if (t._gfx && c && c.isConnected) drawGfxThumb(c, t._gfx); }); }, 2000);
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
    const b = [en.mode === 'slide' ? (en.slideImg ? `show “${vid(en.slideImg)}”${en.musicId ? ` with “${vid(en.musicId)}”` : ''}` : null) : en.videoId ? `play “${vid(en.videoId)}”` : null, en.then === 'hold' ? 'back to holding screen' : 'fade to black', en.stopRec ? 'stop recording' : null, en.endStream ? `end stream after ${en.endAfter} s` : null].filter(Boolean);
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
    if (rt.service === 'closing') {
      const c = roleShot('close'), m = c && mediaOf(c)[0] && rt.files.get(mediaOf(c)[0]);
      n.firstChild.textContent = SV().end.mode === 'slide' ? 'CLOSING SLIDE' : 'CLOSING VIDEO';
      const left = rt.closeEndAt ? (rt.closeEndAt - Date.now()) / 1000 : m && m.el && !m.el.loop ? m.el.duration - m.el.currentTime : null;
      if (left !== null) n.append(el('span', { class: 'mono muted' }, ` −${fmtShort(Math.max(0, left))}`));
      n.append(el('span', { class: 'muted', style: 'font-size:.85em' }, ' · press END SERVICE again to finish now'));
    }
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
    const auds = () => show.files.filter(f => f.kind === 'audio');
    const filePick = (cfg, key, kind, none) => el('div', { class: 'row' },
      select([['', none], ...(kind === 'image' ? imgs() : auds()).map(f => [f.id, (kind === 'image' ? '🖼 ' : '♪ ') + f.name])], cfg[key], v => { cfg[key] = v; done(); draw(); }, { class: 'grow' }),
      el('button', { class: 'btn small', onclick: async () => { const a = await addFiles(); const v = a.find(f => f.kind === kind); if (v) { cfg[key] = v.id; done(); draw(); } else if (a.length) toast(kind === 'image' ? 'That is not a picture.' : 'That is not a music file (MP3, WAV, M4A).', 'error'); } }, 'Import…'));
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

        el('h4', { style: 'margin:12px 0 4px' }, '♪ Music before the service (while the holding slide is up)'),
        holdMusicPicker(() => draw()),
        H.musicId ? mixPanel(getShot('shot_hold'), 'music') : null,

        el('h3', null, '▶ When I press START SERVICE'),
        el('div', { class: 'row wrap', style: 'gap:18px;margin-bottom:10px' },
          check(' Go live on YouTube (if not live yet)', st.goLive, v => { st.goLive = v; done(); }),
          check(' Start recording', st.record, v => { st.record = v; done(); })),
        el('div', { class: 'field' }, el('span', null, 'Play this video first'), videoPick(st, 'videoId'), st.videoId ? fileStatus(st.videoId) : null),
        roleShot('open') ? mixPanel(roleShot('open'), 'video') : null,
        el('div', { class: 'grid2' },
          el('div', { class: 'field' }, el('span', null, st.videoId ? 'Then fade into' : 'Fade into'), select(camShots.length ? camShots : [['', '— add a camera —']], st.cameraShot, v => { st.cameraShot = v; done(); })),
          el('div', { class: 'field' }, el('span', null, 'Fade length'), select([[500, '0.5 second'], [1000, '1 second'], [2000, '2 seconds'], [3000, '3 seconds'], [5000, '5 seconds']], st.fadeMs, v => { st.fadeMs = +v; done(); }))),
        check(' Start the YouTube event automatically once YouTube is receiving the stream', st.ytLive, v => { st.ytLive = v; done(); }),

        el('h3', null, '■ When I press END SERVICE'),
        el('div', { class: 'field' }, el('span', null, 'First show'), select([['video', 'A closing video'], ['slide', 'A slide with music']], en.mode || 'video', v => { en.mode = v; done(); draw(); })),
        (en.mode || 'video') === 'video'
          ? el('div', null, el('div', { class: 'field' }, el('span', null, 'Play this video'), videoPick(en, 'videoId'), en.videoId ? fileStatus(en.videoId) : null),
            roleShot('close') ? mixPanel(roleShot('close'), 'video') : null)
          : el('div', null,
            el('div', { class: 'grid2' },
              el('div', { class: 'field' }, el('span', null, 'Slide (a picture)'), filePick(en, 'slideImg', 'image', '— choose a picture —'), en.slideImg ? fileStatus(en.slideImg) : null),
              el('div', { class: 'field' }, el('span', null, 'Music'), filePick(en, 'musicId', 'audio', '— no music —'), en.musicId ? fileStatus(en.musicId) : null)),
            en.musicId && roleShot('close') ? mixPanel(roleShot('close'), 'music') : null,
            en.musicId
              ? el('div', { class: 'row wrap', style: 'gap:18px;margin-bottom:8px' }, check(' Keep the music going (repeat) until I press END SERVICE again', en.musicLoop, v => { en.musicLoop = v; done(); }))
              : null,
            !en.musicId || en.musicLoop
              ? el('div', { class: 'field' }, el('span', null, en.musicLoop ? 'Or finish by itself after' : 'Show the slide for'), select([[30, '30 seconds'], [60, '1 minute'], [120, '2 minutes'], [300, '5 minutes'], [600, '10 minutes'], [1800, '30 minutes'], [36000, 'Until I press END SERVICE again']], en.slideSecs || 60, v => { en.slideSecs = +v; done(); }))
              : el('div', { class: 'muted', style: 'font-size:.85em;margin-bottom:8px' }, 'The slide stays up while the music plays, then the service finishes. Press END SERVICE again to finish sooner.')),
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
      if (!quiet) saveSettings(); // re-selecting the saved event when the program starts is not a change
      rt.yt.event = ev; show.ytEventId = ev.id; if (!quiet) changed();
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
    if (p && rt.armedGfx) armGfx(null);
    rt.armedSpk = p ? id : null;
    engine.setPreviewLabel(p ? speakerLabel(p) : null);
    document.querySelectorAll('.spk[data-spk]').forEach(t => t.classList.toggle('armed', t.dataset.spk === rt.armedSpk));
    const tb = document.querySelector('.take-btn'); if (tb) tb.classList.toggle('armed', !!(rt.armedSpk || rt.armedGfx));
    renderTally();
  }
  /* titles & graphics: click = into Preview (shown over the live shot), TAKE / Ctrl+G = on air, double-click = now */
  function armGfx(id) {
    const it = id && gfxItems().find(x => x.id === id);
    if (it && rt.armedSpk) armSpeaker(null);
    rt.armedGfx = it ? id : null;
    if (!it) { engine.setPreviewCue(null); if (!rt.armedSpk) engine.setPreviewLabel(null); }
    else {
      const on = it.on();
      // already on air → Preview shows the live shot without it (TAKE hides it)
      if (it.kind === 'label') { engine.setPreviewCue(on ? { hide: id } : null); engine.setPreviewLabel(on ? null : it.o); }
      else { engine.setPreviewLabel(null); engine.setPreviewCue(on ? { hide: id } : { webId: id }); }
    }
    document.querySelectorAll('.gtile[data-gid]').forEach(t => t.classList.toggle('armed', t.dataset.gid === rt.armedGfx));
    syncQuick();
    const tb = document.querySelector('.take-btn'); if (tb) tb.classList.toggle('armed', !!(rt.armedSpk || rt.armedGfx));
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
  const lufsBox = el('div', { class: 'lufs mono', title: 'Click for the AUTO level settings', style: 'cursor:pointer', onclick: () => openDynamics('auto') });
  /* the audio buttons: in the Audio panel, and (when that panel is hidden) under the monitors */
  function audioButtons() {
    const m = show.audio.master;
    const tog = (label, key, title, fn) => { const b = el('button', { class: 'tbtn' + (m[key] ? ' on' : ''), dataset: { akey: key }, title, onclick: () => { m[key] = !m[key]; fn(); changed(); syncAudioButtons(); } }, label); return b; };
    const names = show.audio.inputs.map(a => a.name).join(', ');
    return [
      tog('🎧', 'monitor', 'Listen on this computer (headphones / speakers)', () => mixer.setMaster(m)),
      tog('MONO', 'mono', 'Listen in mono to check phase — only your headphones, not the stream', () => mixer.setMono(!!m.mono)),
      tog('LIMIT', 'limiter', 'YouTube-safe limiter: keeps peaks at or below the Out ceiling (set in DYN). Turns orange and shows how many dB it is turning the sound down while it works (red above 6 dB = too much — lower the level)', () => mixer.setMaster(m)),
      el('button', { class: 'tbtn' + (dynCfg().comp.on ? ' on' : ''), dataset: { akey: 'dyn' }, title: 'Compressor & limiter: threshold, ratio, attack, release, knee, out gain, ceiling', onclick: () => openDynamics() }, 'DYN'),
      el('button', { class: 'tbtn' + (vstOnCount() ? ' on' : ''), dataset: { akey: 'fx' }, title: 'Plug-ins (VST3, e.g. Waves) on the master — inserts before the compressor and limiter', onclick: () => openDynamics('fx') }, vstBtnText()),
      (() => { const b = tog(autoLabel(), 'auto', 'Auto level: slowly turns the overall volume up or down to sit at the target loudness (YouTube: −14 LUFS). Right-click for its settings — target, speed, range…', () => {}); b.addEventListener('contextmenu', e => { e.preventDefault(); openDynamics('auto'); }); return b; })(),
      el('button', { class: 'tbtn', title: 'Sound card, volumes, mute, sync test, output', onclick: openMixer }, names ? '🎚 Mixer' : '🔌 Connect sound card')];
  }
  function syncAudioButtons() {
    const m = show.audio.master;
    document.querySelectorAll('.tbtn[data-akey]').forEach(b => b.classList.toggle('on', b.dataset.akey === 'dyn' ? !!dynCfg().comp.on : b.dataset.akey === 'fx' ? vstOnCount() > 0 : !!m[b.dataset.akey]));
    document.querySelectorAll('.tbtn[data-akey="auto"]').forEach(b => { const t = T(autoLabel()); if (b.textContent !== t) b.textContent = t; });
    document.querySelectorAll('.tbtn[data-akey="fx"]').forEach(b => { const t = T(vstBtnText()); if (b.textContent !== t) b.textContent = t; b.classList.toggle('bad', [...VSTR.slots.values()].some(v => v.broken || v.err)); });
  }
  RENDER.audio = body => {
    body.innerHTML = '';
    const m = show.audio.master;
    const [bMon, bMono, bLim, bDyn, bFx, bAuto, bMix] = audioButtons();
    put(body, el('div', { class: 'aud2' },
      el('div', { class: 'master-top' },
        masterCanvas,
        el('div', { class: 'master-side' },
          el('div', { class: 'mlabel' }, 'Stereo / phase'), corrCanvas,
          el('div', { class: 'corr-scale' }, el('span', null, '−1 out of phase'), el('span', null, '0'), el('span', null, '+1 mono')),
          gonio, lufsBox)),
      el('div', { class: 'aud-tools' }, bMon, bMono, bLim, bDyn, bFx, bAuto, el('span', { class: 'grow' }), bMix)));
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
      el('h3', null, 'Program playback (e.g. SSL 2 → TC Electronic meter)'),
      el('div', { class: 'field' }, el('span', null, 'Play the program on'),
        select([['', 'Off'], ...outChoices()],
          settings.playbackOut && settings.playbackOut.label ? settings.playbackOut.label + '|' + (settings.playbackOut.idx || 0) : '',
          async v => { if (!v) settings.playbackOut = null; else { const i = v.lastIndexOf('|'); settings.playbackOut = { label: v.slice(0, i), idx: +v.slice(i + 1) }; } saveSettings(); await applyPlayback(); openMixer(); })),
      rt.playNote ? el('div', { class: 'status-bad', style: 'font-size:.85em;margin-bottom:6px' }, rt.playNote) : null,
      slider({ label: 'Playback level', min: -40, max: 6, step: 0.5, value: settings.playbackGain ?? 0, reset: 0, fmt: v => `${v.toFixed(1)} dB`, onInput: v => { settings.playbackGain = v; mixer.setPlaybackLevel(v); saveSettings(); } }),
      el('div', { class: 'muted', style: 'font-size:.85em' }, 'Like Wirecast’s “Audio Playback”: the finished program sound (after the limiter) plays here all the time, whatever you do with 🎧 or Listen. Keep it at 0 dB so the meter reads the same as YouTube. The stream and the recording are not affected.'),
      el('h3', null, 'Headphones / monitor output'),
      el('div', { class: 'field' }, el('span', null, 'Send the sound to'),
        select([['', 'Windows default output'], ...outChoices()],
          settings.monitorOut && settings.monitorOut.label ? settings.monitorOut.label + '|' + (settings.monitorOut.idx || 0) : '',
          async v => { if (!v) settings.monitorOut = null; else { const i = v.lastIndexOf('|'); settings.monitorOut = { label: v.slice(0, i), idx: +v.slice(i + 1) }; } saveSettings(); await applyOutput(); openMixer(); })),
      rt.outNote ? el('div', { class: 'status-bad', style: 'font-size:.85em;margin-bottom:6px' }, rt.outNote) : null,
      el('div', { class: 'row wrap', style: 'gap:16px;margin:4px 0' },
        check(' Send the program sound there all the time (same as 🎧)', !!show.audio.master.monitor, v => { show.audio.master.monitor = v; mixer.setMaster(show.audio.master); changed(); refresh('audio'); })),
      slider({ label: 'Output level', min: -40, max: 0, step: 0.5, value: show.audio.master.monitorGain ?? -6, reset: -6, fmt: v => `${v.toFixed(1)} dB`, onInput: v => { show.audio.master.monitorGain = v; mixer.setMaster(show.audio.master); changed(); } }),
      el('div', { class: 'muted', style: 'font-size:.85em' }, 'Your headphones. 🎧 (program) and Listen (Preview) go here. Pick a different device than Program playback, so listening to the Preview never reaches the meter.'),
      settings.playbackOut && settings.monitorOut && settings.playbackOut.label === settings.monitorOut.label && (settings.playbackOut.idx || 0) === (settings.monitorOut.idx || 0)
        ? el('div', { class: 'status-bad', style: 'font-size:.85em;margin-top:4px' }, 'Headphones and Program playback are the same device — choose your headphones here.') : null,
      el('h3', null, 'Master volume'),
      el('div', { class: 'ch master-ch' }, el('span', { class: 'ch-mute ghost' }, ''), el('div', { class: 'ch-name' }, 'MASTER'), mFader, mDb, el('span')),
      el('div', { class: 'muted', style: 'font-size:.85em;margin-top:8px' }, 'Normally leave these at 0 and mix on your sound desk. LIMIT keeps peaks under the Out ceiling (DYN); AUTO holds the overall loudness at the target (right-click AUTO for its settings).'),
      el('div', { class: 'row', style: 'margin-top:14px' }, el('span', { class: 'grow' }), el('button', { class: 'btn primary', onclick: () => closeModal() }, 'Done')));
    openModal('Audio mixer & sound card', body);
  }
  /* ---------- VST3 plug-ins on the Master (inserts) ----------
     They run in their own program (ls-vst). The sound runs a fixed 50 ms (+ the plug-ins' own delay) behind, so a
     late answer never makes a gap; a crashed plug-in host means the sound simply goes on untouched. */
  const VSTR = { started: false, ready: false, missing: false, slots: new Map(), stats: null, portOK: false, list: null, scanning: null, prog: null, redraw: null, lateAt: 0, editT: new Map(), loggedDry: 0 };
  const VST_BASE_MS = 50;
  const vstIns = () => { const m = show.audio.master; if (!Array.isArray(m.inserts)) m.inserts = []; return m.inserts; };
  const vstActive = () => vstIns().length > 0 && !VSTR.missing;
  const vstOnCount = () => vstIns().filter(x => !x.bypass).length;
  const vstBtnText = () => { const n = vstIns().length, on = vstOnCount(); return n ? `FX ${on}${on !== n ? '/' + n : ''}` : 'FX'; };
  const b64of = u8 => { let s2 = ''; for (let i = 0; i < u8.length; i += 0x8000) s2 += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s2); };
  const bytesOf = b => { const s2 = atob(b); const u = new Uint8Array(s2.length); for (let i = 0; i < s2.length; i++) u[i] = s2.charCodeAt(i); return u; };
  // total delay of the master sound (samples): 50 ms for the round trip + every loaded plug-in's own delay (bypassed ones too, so bypass never moves the timing)
  function vstD() {
    const sr = mixer.ctx.sampleRate; let lat = 0;
    for (const x of vstIns()) { const st = VSTR.slots.get(x.id); if (st && st.ok) lat += st.lat || 0; }
    return Math.round(sr * VST_BASE_MS / 1000) + lat;
  }
  const vstMs = () => mixer.insertD ? Math.round(mixer.insertD / mixer.ctx.sampleRate * 1000) : 0;
  function vstApplyD() {
    const on = vstActive(), before = mixer.insertD || 0;
    mixer.setInserts(on, on ? vstD() : 0);
    mixer.setDelayComp(rt.eng ? 0 : vstMs()); // classic engine: the inputs' sound delay is shortened instead
    if ((mixer.insertD || 0) !== before) {
      logEvent('PLUGINS', `master sound delay ${vstMs()} ms`);
      if (rt.eng && ((rt.live && rt.live.viaEngine) || (rt.rec && rt.rec.viaEngine))) toast('The plug-in delay changed — sound/picture sync is corrected the next time you go live or record.', '');
    }
  }
  function vstLoad(x) {
    VSTR.slots.set(x.id, { loading: true, ok: false, lat: (VSTR.slots.get(x.id) || {}).lat || 0 });
    S.vstCmd(['load', x.id, x.path, x.cid], x.state ? bytesOf(x.state) : null);
    if (x.bypass) S.vstCmd(['bypass', x.id, '1']);
  }
  const vstOrder = () => S.vstCmd(['order', ...vstIns().map(x => x.id)]);
  async function vstSync() {
    if (!S.vstStart) return;
    const ins = vstIns();
    if (!ins.length) {
      if (VSTR.started) { VSTR.started = false; VSTR.ready = false; VSTR.slots.clear(); await S.vstStop(); logEvent('PLUGINS', 'no plug-ins on the master — plug-in host stopped'); }
      vstApplyD(); vstRedraw(); return;
    }
    if (!VSTR.started) {
      VSTR.started = true;
      const r = await S.vstStart({ rate: mixer.ctx.sampleRate });
      if (!r || r.error) { VSTR.started = false; VSTR.missing = true; toast(`Plug-ins: ${r ? r.error : 'no answer'}`, 'error'); vstApplyD(); vstRedraw(); return; }
      VSTR.missing = false;
      await vstAudioPath();
      if (r.ready) { VSTR.ready = true; for (const x of ins) vstLoad(x); vstOrder(); }
      logEvent('PLUGINS', `plug-in host started · ${ins.map(x => x.name).join(' → ')}`);
    } else if (VSTR.ready) {
      // load what is new, unload what is gone, then the order
      const want = new Set(ins.map(x => x.id));
      for (const id of [...VSTR.slots.keys()]) if (!want.has(id)) { S.vstCmd(['unload', id]); VSTR.slots.delete(id); }
      for (const x of ins) if (!VSTR.slots.has(x.id)) vstLoad(x);
      vstOrder();
    }
    vstApplyD(); vstRedraw();
  }
  // the sound thread ↔ plug-in host line (straight to the main process; through the window if that does not answer)
  async function vstAudioPath() {
    await mixer.enableInserts(d => {
      if (d.pcm !== undefined) { S.vstAudio(d.seq, d.pcm); return; } // relayed through the window
      if (d.portOk) { if (!VSTR.portOK) logEvent('PLUGINS', 'sound goes straight from the sound thread to the plug-ins'); VSTR.portOK = true; return; }
      if (d.stats) vstStats(d.stats);
    });
    if (VSTR.portSet) return;
    VSTR.portSet = true;
    if (!S.isApp && !S.vstPortSink) return;
    const ch = new MessageChannel();
    if (S.isApp) window.postMessage('ls-vst-port', '*', [ch.port2]); else S.vstPortSink(ch.port2); // (the browser stand-in for tests)
    mixer.insertPort(ch.port1);
    setTimeout(() => { if (!VSTR.portOK) { mixer.insertPort(null); logEvent('PLUGINS', 'sound goes to the plug-ins through the window (the direct line did not answer)'); } }, 3000);
  }
  function vstStats(st) {
    VSTR.stats = st;
    // untouched sound played while the plug-ins were running = they answered too late (or went away)
    const dryMs = Math.round(st.dry / mixer.ctx.sampleRate * 1000);
    if (VSTR.ready && dryMs > 20) VSTR.loggedDry += dryMs;
    const now = performance.now();
    if (VSTR.loggedDry && now - VSTR.lateAt > 10000) { VSTR.lateAt = now; logEvent('PLUGINS', `plug-ins answered late: ${VSTR.loggedDry} ms played without them (the sound did not stop)`); VSTR.loggedDry = 0; }
    if (VSTR.redrawStatus) VSTR.redrawStatus();
  }
  function vstRedraw() { if (VSTR.redraw) VSTR.redraw(); syncAudioButtons(); }
  // a plug-in's settings are kept in the show (fetched 2 s after you stop turning its knobs, and when its window closes)
  function vstWantState(id) {
    clearTimeout(VSTR.editT.get(id));
    VSTR.editT.set(id, setTimeout(() => { VSTR.editT.delete(id); S.vstCmd(['get-state', id]); }, 2000));
  }
  if (S.onVst) S.onVst((f, payload) => {
    const ins = vstIns(), x = ins.find(i => i.id === f[1]), st = VSTR.slots.get(f[1]);
    switch (f[0]) {
      case 'ready':
        VSTR.ready = true; VSTR.slots.clear();
        logEvent('PLUGINS', `plug-in host ready (${f[1] || ''})`);
        for (const i of ins) vstLoad(i);
        vstOrder(); vstApplyD();
        break;
      case 'loaded':
        if (!x) break;
        if (f[2] === '1') {
          VSTR.slots.set(x.id, { ok: true, lat: +f[3] || 0, name: f[4], nIn: +f[5], nOut: +f[6] });
          if (f[4] && f[4] !== x.name) x.name = f[4];
          logEvent('PLUGINS', `loaded ${x.name}${+f[3] ? ` · own delay ${(+f[3] / mixer.ctx.sampleRate * 1000).toFixed(1)} ms` : ''}${+f[5] === 1 ? ' · mono' : ''}`);
        } else {
          VSTR.slots.set(x.id, { ok: false, err: f[3] || 'could not be loaded', lat: 0 });
          logEvent('PLUGINS', `${x.name} could not be loaded: ${f[3]}`);
          toast(`Plug-in “${x.name}” could not be loaded: ${f[3]}`, 'error');
        }
        vstApplyD(); vstRedraw();
        break;
      case 'latency':
        if (f[1] !== '*' && st) { st.lat = +f[2] || 0; vstApplyD(); vstRedraw(); }
        break;
      case 'state':
        if (x && payload) { const b = b64of(payload); if (b !== x.state) { x.state = b; changed(); } }
        break;
      case 'edited':
        if (x) vstWantState(x.id);
        break;
      case 'editor':
        if (st) st.editor = f[2] === 'open';
        if (f[2] === 'none' && x) toast(`“${x.name}” has no window of its own.`, '');
        vstRedraw();
        break;
      case 'broken':
        if (st) st.broken = true;
        if (x) { logEvent('PLUGINS', `${x.name} crashed while processing — it is skipped now (the sound goes on)`); toast(`Plug-in “${x.name}” crashed and is skipped now — the sound goes on without it. Remove it or reload the show.`, 'error'); }
        vstRedraw();
        break;
      case 'log': logEvent('PLUGINS', f.slice(1).join(' ')); break;
      case 'host-exit':
        VSTR.ready = false;
        for (const v of VSTR.slots.values()) { v.ok = false; v.loading = true; }
        if (VSTR.started) { logEvent('PLUGINS', `plug-in host stopped (code ${f[1]}) — restarting; the sound goes on without the plug-ins meanwhile`); toast('The plug-in host stopped — restarting it. The sound goes on meanwhile.', 'error'); }
        vstRedraw();
        break;
    }
  });
  if (S.onVstAudio) S.onVstAudio(d => mixer.insertReply(d));
  if (S.onVstScan) S.onVstScan(p => { VSTR.prog = p; if (VSTR.redrawStatus) VSTR.redrawStatus(); });
  async function vstScan(force) {
    if (!S.vstScan) return null;
    if (!VSTR.scanning) VSTR.scanning = S.vstScan(force, settings.vstFolders || []).then(r => {
      VSTR.prog = null;
      if (r && !r.error) { VSTR.list = r; logEvent('PLUGINS', `found ${r.plugins.length} plug-ins in ${r.modules} files${r.problems.length ? ` · ${r.problems.length} could not be opened: ${r.problems.slice(0, 5).join('; ')}` : ''}`); }
      else toast(`Plug-in scan: ${r ? r.error : 'no answer'}`, 'error');
      return r;
    }).finally(() => { VSTR.scanning = null; });
    return VSTR.scanning;
  }
  // effects only (instruments are hidden), sorted by maker then name
  const vstEffects = () => (VSTR.list ? VSTR.list.plugins : []).filter(p2 => !/Instrument/i.test(p2.sub) || /Fx/i.test(p2.sub))
    .sort((a, b) => (a.vendor || '').localeCompare(b.vendor || '') || a.name.localeCompare(b.name));
  function vstPage() {
    const wrap = el('div', { class: 'vst-page' });
    const status = el('div', { class: 'vst-status' }), slotsBox = el('div', { class: 'vst-slots' }), pickBox = el('div');
    let picking = false, q = '';
    const drawStatus = () => {
      status.innerHTML = '';
      const st = VSTR.stats, ins = vstIns();
      let line;
      if (!S.vstStart) line = el('span', { class: 'muted' }, 'Plug-ins work in the Live Studio app on Windows.');
      else if (VSTR.missing) line = el('span', { class: 'status-bad' }, 'The plug-in host is missing from this installation — update Live Studio.');
      else if (!ins.length) line = el('span', { class: 'muted' }, 'No plug-ins on the master. The sound goes straight through, with no delay.');
      else if (!VSTR.ready) line = el('span', { class: 'status-bad' }, 'Plug-in host starting… (the sound goes on untouched meanwhile)');
      else {
        const dry = st ? Math.round(st.dry / mixer.ctx.sampleRate * 1000) : 0;
        line = el('span', { class: dry > 20 ? 'status-bad' : 'status-ok' },
          `● Running · sound ${vstMs()} ms behind${vstMs() > VST_BASE_MS ? ` (${vstMs() - VST_BASE_MS} ms of it from the plug-ins)` : ''} · ${rt.eng ? 'picture delayed to match' : 'inputs’ sound delay shortened to match'}`,
          dry > 20 ? ` · ${dry} ms late in the last second` : '');
      }
      put(status, line, VSTR.prog ? el('div', { class: 'muted' }, `Looking for plug-ins… ${VSTR.prog.i}/${VSTR.prog.n} ${VSTR.prog.module}`) : null);
    };
    const drawSlots = () => {
      slotsBox.innerHTML = '';
      const ins = vstIns();
      ins.forEach((x, i) => {
        const st = VSTR.slots.get(x.id) || {};
        const state = st.broken ? el('span', { class: 'status-bad' }, 'crashed — skipped') : st.err ? el('span', { class: 'status-bad' }, st.err) : st.loading || (!st.ok && VSTR.started) ? el('span', { class: 'muted' }, 'loading…') : st.lat ? el('span', { class: 'muted' }, `delay ${(st.lat / mixer.ctx.sampleRate * 1000).toFixed(1)} ms`) : null;
        put(slotsBox, el('div', { class: 'vst-slot' + (x.bypass ? ' off' : '') + (st.broken || st.err ? ' bad' : '') },
          el('span', { class: 'vst-num mono' }, String(i + 1)),
          el('button', { class: 'btn vst-pwr' + (x.bypass ? '' : ' on'), title: x.bypass ? 'Bypassed — click to turn it on' : 'On — click to bypass', onclick: () => { x.bypass = !x.bypass; S.vstCmd(['bypass', x.id, x.bypass ? '1' : '0']); changed(); logEvent('PLUGINS', `${x.name} ${x.bypass ? 'bypassed' : 'on'}`); drawSlots(); syncAudioButtons(); } }, '⏻'),
          el('div', { class: 'vst-name' }, el('b', null, x.name), el('small', null, x.vendor || ''), state),
          el('button', { class: 'btn', disabled: !st.ok, title: 'Open the plug-in’s own window', onclick: () => S.vstCmd(['edit', x.id]) }, st.editor ? 'Window open' : 'Edit…'),
          el('button', { class: 'btn small', disabled: i === 0, title: 'Move up (earlier in the chain)', onclick: () => { ins.splice(i - 1, 0, ins.splice(i, 1)[0]); vstOrder(); changed(); drawSlots(); } }, '▲'),
          el('button', { class: 'btn small', disabled: i === ins.length - 1, title: 'Move down (later in the chain)', onclick: () => { ins.splice(i + 1, 0, ins.splice(i, 1)[0]); vstOrder(); changed(); drawSlots(); } }, '▼'),
          el('button', { class: 'btn small danger', title: 'Remove from the master', onclick: () => { S.vstCmd(['close-edit', x.id]); ins.splice(i, 1); changed(); logEvent('PLUGINS', `removed ${x.name}`); vstSync(); } }, '✕')));
      });
      document.querySelectorAll('.fx-dot').forEach(d2 => d2.classList.toggle('on', vstOnCount() > 0));
      if (ins.length < 8) put(slotsBox, el('button', { class: 'btn primary vst-add', onclick: () => { picking = !picking; drawPick(); if (picking && !VSTR.list) vstScan(false).then(drawPick); } }, picking ? 'Close the list' : '+ Add plug-in…'));
      drawStatus();
    };
    const drawPick = () => {
      pickBox.innerHTML = '';
      if (!picking) return;
      const search = el('input', { type: 'text', placeholder: 'Search (name or maker, e.g. L2, Waves, EQ)', value: q, style: 'flex:1' });
      const list = el('div', { class: 'vst-list' });
      const fill = () => {
        list.innerHTML = '';
        const words = q.toLowerCase().split(/\s+/).filter(Boolean);
        const all = vstEffects(), found = all.filter(p2 => words.every(w => `${p2.name} ${p2.vendor} ${p2.sub}`.toLowerCase().includes(w)));
        if (VSTR.scanning && !VSTR.list) { put(list, el('div', { class: 'muted' }, 'Looking for plug-ins… (the first time can take a minute — Waves especially)')); return; }
        if (!all.length) { put(list, el('div', { class: 'muted' }, 'No VST3 plug-ins found. They live in C:\\Program Files\\Common Files\\VST3 — install them there (Waves: through Waves Central) and click “Look again”.')); return; }
        for (const p2 of found.slice(0, 300)) put(list, el('button', { class: 'vst-item', onclick: () => {
          const x = { id: uid('fx'), path: p2.path, cid: p2.cid, name: p2.name, vendor: p2.vendor, bypass: false, state: null };
          vstIns().push(x); changed(); picking = false; q = '';
          logEvent('PLUGINS', `added ${p2.name} (${p2.vendor})`);
          vstSync(); drawPick(); drawSlots();
        } }, el('b', null, p2.name), el('small', null, `${p2.vendor}${p2.sub ? ' · ' + p2.sub.replace(/\|/g, ', ') : ''}`)));
        if (!found.length) put(list, el('div', { class: 'muted' }, 'Nothing matches.'));
      };
      search.addEventListener('input', () => { q = search.value; fill(); });
      put(pickBox, el('div', { class: 'vst-pick' },
        el('div', { class: 'row', style: 'gap:8px;margin-bottom:8px' }, search,
          el('button', { class: 'btn', disabled: !!VSTR.scanning, onclick: () => { vstScan(true).then(drawPick); drawPick(); } }, VSTR.scanning ? 'Looking…' : '↻ Look again'),
          el('button', { class: 'btn', title: 'Add a folder with VST3 plug-ins (besides the standard one)', onclick: async () => { const d = await S.vstPickFolder(); if (!d) return; settings.vstFolders = [...new Set([...(settings.vstFolders || []), d])]; saveSettings(); vstScan(false).then(drawPick); drawPick(); } }, '+ Folder…')),
        list,
        VSTR.list && VSTR.list.problems.length ? el('div', { class: 'muted', style: 'font-size:.82em;margin-top:6px' }, `${VSTR.list.problems.length} file(s) could not be opened: ${VSTR.list.problems.slice(0, 3).join('; ')}`) : null));
      fill();
      setTimeout(() => search.focus(), 0);
    };
    VSTR.redraw = () => { if (wrap.isConnected) drawSlots(); else VSTR.redraw = null; };
    VSTR.redrawStatus = () => { if (wrap.isConnected) drawStatus(); else VSTR.redrawStatus = null; };
    drawSlots();
    return put(wrap, status, slotsBox, pickBox,
      el('div', { class: 'muted', style: 'font-size:.82em;margin-top:12px' }, 'VST3 plug-ins (e.g. Waves) on the program sound, top to bottom: after the master fader, before Live Studio’s compressor and limiter (keep LIMITER on as the last safety). They run in a separate program — if one crashes, the stream goes on without it. With plug-ins the sound runs about 50 ms behind; the picture is delayed to match. Settings made in a plug-in’s window are saved with the show.'));
  }
  /* ---------- master dynamics: compressor + limiter (like a console's DYN screen) ---------- */
  const COMP_PRESETS = [
    ['Speech — gentle', { threshold: -24, ratio: 2.5, attack: 10, release: 150, knee: 6, makeup: 3 }],
    ['Worship / music — light', { threshold: -20, ratio: 2, attack: 20, release: 250, knee: 8, makeup: 2 }],
    ['Even it out — stronger', { threshold: -28, ratio: 4, attack: 5, release: 120, knee: 4, makeup: 6 }],
    ['Console style (−26 dB, 3:1)', { threshold: -26, ratio: 3, attack: 1, release: 144, knee: 2, makeup: 4 }]];
  const RATIOS = [1, 1.1, 1.3, 1.5, 1.7, 2, 2.5, 3, 3.5, 4, 5, 6, 8, 10, 20];
  /* AUTO (auto level): its settings live with the show (Audio → right-click AUTO, or DYN → AUTO LEVEL) */
  const AUTO_DEF = { target: -14, window: 'S', reaction: 8, up: 0.8, down: 0.8, maxUp: 12, maxDown: 12, dead: 0, gate: -45 };
  const AUTO_BEHAVIOUR = [
    ['Gentle (default)', { window: 'S', reaction: 8, up: 0.8, down: 0.8, dead: 0 }],
    ['Music — slow, keeps the dynamics', { window: 'L', reaction: 20, up: 0.4, down: 0.6, dead: 1 }],
    ['Speech — quicker between speakers', { window: 'S', reaction: 3, up: 1.5, down: 3, dead: 0.5 }]
  ];
  function autoCfg() {
    const m = show.audio.master, c = m.autoCfg || (m.autoCfg = {});
    for (const k in AUTO_DEF) if (typeof c[k] !== typeof AUTO_DEF[k]) c[k] = AUTO_DEF[k];
    return c;
  }
  const minus = v => (v < 0 ? '−' : '') + Math.abs(v);
  const autoLabel = () => `AUTO ${minus(autoCfg().target)}`;
  function dynCfg() {
    const m = show.audio.master;
    // fill in missing values on the SAME objects (an open DYN window keeps editing them)
    const fill = (o, def) => { for (const k in def) if (o[k] === undefined) o[k] = def[k]; return o; };
    m.dyn = m.dyn || {};
    m.dyn.comp = fill(m.dyn.comp || {}, { on: false, threshold: -24, ratio: 3, attack: 10, release: 150, knee: 2, makeup: 0 });
    m.dyn.lim = fill(m.dyn.lim || {}, { ceiling: -1, release: 100, arc: true, bits: 24, dither: 'type1', shaping: 'normal' });
    if (m.dyn.lim.threshold === undefined) m.dyn.lim.threshold = m.dyn.lim.ceiling;
    return m.dyn;
  }
  function openDynamics(tab0) {
    if (tab0) rt.dynTab = tab0;
    const d = dynCfg(), c = d.comp, l = d.lim, m = show.audio.master;
    const apply = () => { mixer.setMaster(m); changed(); };
    const graph = el('canvas', { width: 600, height: 600, class: 'dyn-graph' });
    const meters = el('canvas', { width: 240, height: 600, class: 'dyn-meters' });
    const body = el('div');
    const L2H = 380, L2P = 12; // fader / meter height and padding (css px) — the faders and meters share one scale
    const mk = w => { const cv = el('canvas', { class: 'l2-meter', style: `width:${w}px;height:${L2H + 2 * L2P}px` }); cv.width = Math.round(w * devicePixelRatio); cv.height = Math.round((L2H + 2 * L2P) * devicePixelRatio); return cv; };
    const L2 = { cIn: mk(92), cOut: mk(92), cAtt: mk(66), hold: { inL: -90, inR: -90, outL: -90, outR: -90, att: 0 }, lv: { inL: -90, inR: -90, outL: -90, outR: -90, att: 0 } };
    let picked = null; // the saved preset last loaded (so it can be updated or deleted)
    const mine = () => settings.dynPresets || (settings.dynPresets = []);
    const draw = () => {
      body.innerHTML = '';
      const nameIn = el('input', { type: 'text', placeholder: 'Name for a new preset (e.g. Sunday sermon)', value: picked !== null && mine()[picked] ? mine()[picked].name : '', style: 'flex:1;min-width:120px' });
      const presetRow = el('div', { class: 'row wrap', style: 'gap:6px;margin:-2px 0 10px' }, nameIn,
        el('button', { class: 'btn small', onclick: () => {
          const n = nameIn.value.trim(); if (!n) { toast('Type a name for the preset first.', 'error'); return; }
          const L = mine(), i = L.findIndex(x => x.name === n), pr = { name: n, comp: clone(c), lim: clone(l), limiter: !!m.limiter };
          if (i >= 0) L[i] = pr; else L.push(pr);
          picked = i >= 0 ? i : L.length - 1; saveSettings(); toast(`Preset “${n}” saved.`, 'ok'); draw();
        } }, '★ Save as preset'),
        picked !== null && mine()[picked] ? el('button', { class: 'btn small danger', onclick: () => { const n = mine()[picked].name; settings.dynPresets.splice(picked, 1); picked = null; saveSettings(); toast(`Preset “${n}” deleted.`); draw(); } }, 'Delete “' + mine()[picked].name + '”') : null);
      const btnOn = (on, label, fn) => el('button', { class: 'btn dyn-on' + (on ? ' on' : ''), onclick: fn }, on ? `${label} ON` : `${label} OFF`);
      const ri = Math.max(0, RATIOS.findIndex(r => r >= c.ratio - 1e-6));
      const tab = rt.dynTab || 'comp';
      const presetSel = select([['', 'Presets…'], ...mine().map((p2, i) => ['u' + i, '★ ' + p2.name]), ...COMP_PRESETS.map((p2, i) => ['b' + i, p2[0]])], '', v => {
        if (!v) return;
        if (v[0] === 'u') { const pr = mine()[+v.slice(1)]; Object.assign(c, clone(pr.comp)); Object.assign(l, clone(pr.lim)); m.limiter = pr.limiter !== false; picked = +v.slice(1); }
        else { Object.assign(c, COMP_PRESETS[+v.slice(1)][1], { on: true }); picked = null; }
        apply(); draw(); syncAudioButtons();
      });
      const tabs = el('div', { class: 'dyn-tabs' },
        el('button', { class: 'btn dyn-tab' + (tab === 'comp' ? ' sel' : ''), onclick: () => { rt.dynTab = 'comp'; draw(); } }, 'COMPRESSOR', el('span', { class: 'dot' + (c.on ? ' on' : '') })),
        el('button', { class: 'btn dyn-tab' + (tab === 'lim' ? ' sel' : ''), onclick: () => { rt.dynTab = 'lim'; draw(); } }, 'LIMITER', el('span', { class: 'dot' + (m.limiter ? ' on' : '') })),
        el('button', { class: 'btn dyn-tab' + (tab === 'fx' ? ' sel' : ''), title: 'VST3 plug-ins on the master (inserts)', onclick: () => { rt.dynTab = 'fx'; draw(); } }, 'PLUG-INS', el('span', { class: 'dot fx-dot' + (vstOnCount() ? ' on' : '') })),
        el('button', { class: 'btn dyn-tab' + (tab === 'auto' ? ' sel' : ''), title: 'AUTO: automatic level toward the target loudness', onclick: () => { rt.dynTab = 'auto'; draw(); } }, 'AUTO LEVEL', el('span', { class: 'dot' + (m.auto ? ' on' : '') })),
        el('span', { class: 'grow' }), tab === 'fx' || tab === 'auto' ? null : presetSel);
      // AUTO LEVEL: target, how it measures, how fast and how far it may move — and a graph of the last minute
      const autoPage = () => {
        const C = autoCfg();
        const set = (k, v) => { C[k] = v; if (k === 'maxUp' || k === 'maxDown') { rt.autoDb = clamp(rt.autoDb || 0, -C.maxDown, C.maxUp); mixer.setAuto(rt.autoDb); } changed(); syncAudioButtons(); drawAutoGraph(rt.autoGraph); };
        const seg = (opts, cur, fn) => el('div', { class: 'seg' }, opts.map(([v, t, tip]) => el('button', { class: 'btn small' + (cur === v ? ' sel' : ''), title: tip || null, onclick: () => fn(v) }, t)));
        const lrow = (label, ctl) => el('div', { class: 'row', style: 'gap:10px;align-items:center;margin:6px 0' }, el('span', { class: 'lbl', style: 'width:calc(165px * var(--scale));flex:none;font-weight:600' }, label), ctl);
        const cv = el('canvas', { class: 'auto-graph', width: 1400, height: 330 }); rt.autoGraph = cv;
        // (the words in their own spans, so the interface language can change while this is open)
        const iNow = el('span'), iAuto = el('span'), iSt = el('span');
        const info = el('div', { class: 'auto-info mono' }, el('span', null, 'Now'), ': ', iNow, ' LUFS · ', el('span', null, 'auto'), ' ', iAuto, ' dB · ', iSt);
        rt.autoInfo = () => {
          const st = { off: 'off', frozen: 'frozen — holding its level', quiet: 'quiet — holding (below the gate)', ok: 'on target — holding', up: 'turning up', down: 'turning down' }[rt.autoState || 'off'];
          const l = rt.autoNow;
          setText(iNow, l === undefined || l <= -60 ? '—' : l.toFixed(1)); setText(iAuto, `${(rt.autoDb || 0) >= 0 ? '+' : ''}${(rt.autoDb || 0).toFixed(1)}`); setText(iSt, st);
        };
        rt.autoInfo();
        setTimeout(() => drawAutoGraph(cv), 0);
        const beh = AUTO_BEHAVIOUR.findIndex(([, b]) => Object.keys(b).every(k => C[k] === b[k]));
        return el('div', { class: 'auto-page' },
          el('div', { class: 'row wrap', style: 'gap:8px;margin-bottom:8px;align-items:center' },
            btnOn(!!m.auto, 'AUTO', () => { m.auto = !m.auto; changed(); draw(); refresh('audio'); syncAudioButtons(); }),
            el('button', { class: 'btn' + (rt.autoHold ? ' on dyn-on' : ''), title: 'Hold the level where it is now (e.g. during a quiet prayer) — press again to let AUTO work', onclick: () => { rt.autoHold = !rt.autoHold; logEvent('AUDIO', `auto level ${rt.autoHold ? 'frozen' : 'released'}`); draw(); } }, rt.autoHold ? '❄ FROZEN' : '❄ Freeze'),
            el('button', { class: 'btn', title: 'Back to 0 dB now', onclick: () => { rt.autoDb = 0; mixer.setAuto(0); rt.autoInfo(); } }, 'Reset to 0 dB'),
            el('span', { class: 'grow' }),
            select([...(beh < 0 ? [['', 'Behaviour: custom']] : []), ...AUTO_BEHAVIOUR.map(([n], i) => [i, n])], beh < 0 ? '' : beh, v => { if (v === '') return; Object.assign(C, AUTO_BEHAVIOUR[+v][1]); changed(); draw(); })),
          info, cv,
          el('div', { class: 'auto-legend' }, el('span', { style: 'color:#4ade80' }, '━ loudness'), el('span', { style: 'color:#60a5fa' }, '┅ target'), el('span', { style: 'color:#71717a' }, '┅ gate'), el('span', { style: 'color:#f59e0b' }, '━ AUTO gain (right scale)')),
          el('div', { class: 'dyn-wrap' },
            el('div', { class: 'dyn-col' },
              el('div', { class: 'auto-h' }, 'Target & measuring'),
              slider({ label: 'Target loudness', min: -30, max: -9, step: 0.5, value: C.target, reset: -14, fmt: v => `${minus(v)} LUFS`, onInput: v => set('target', v) }),
              lrow('Quick targets', seg([[-14, 'YouTube −14', 'YouTube, Spotify'], [-16, 'Apple −16', 'Apple Music / Podcasts'], [-23, 'Broadcast −23', 'EBU R128 television / radio']], C.target, v => { set('target', v); draw(); })),
              lrow('Measure over', seg([['M', 'Momentary 0.4 s', 'Reacts to every word — can pump'], ['S', 'Short 3 s', 'Like the Loudness meter (default)'], ['L', 'Long 10 s', 'The last 10 s, pauses left out — steadiest']], C.window, v => { set('window', v); draw(); })),
              slider({ label: 'Leave alone within', min: 0, max: 4, step: 0.5, value: C.dead, reset: 0, fmt: v => `±${v.toFixed(1)} LU`, onInput: v => set('dead', v) }),
              slider({ label: 'Ignore sound quieter than', min: -70, max: -20, step: 1, value: C.gate, reset: -45, fmt: v => `${minus(v)} LUFS`, onInput: v => set('gate', v) })),
            el('div', { class: 'dyn-col' },
              el('div', { class: 'auto-h' }, 'Speed & range'),
              slider({ label: 'Reaction time', min: 1, max: 60, step: 1, value: C.reaction, reset: 8, fmt: v => `${v} s`, onInput: v => set('reaction', v) }),
              slider({ label: 'Fastest turn up', min: 0.1, max: 6, step: 0.1, value: C.up, reset: 0.8, fmt: v => `${v.toFixed(1)} dB/s`, onInput: v => set('up', v) }),
              slider({ label: 'Fastest turn down', min: 0.1, max: 6, step: 0.1, value: C.down, reset: 0.8, fmt: v => `${v.toFixed(1)} dB/s`, onInput: v => set('down', v) }),
              slider({ label: 'Most it may boost', min: 0, max: 24, step: 0.5, value: C.maxUp, reset: 12, fmt: v => `+${v.toFixed(1)} dB`, onInput: v => set('maxUp', v) }),
              slider({ label: 'Most it may cut', min: 0, max: 24, step: 0.5, value: C.maxDown, reset: 12, fmt: v => `−${v.toFixed(1)} dB`, onInput: v => set('maxDown', v) }))),
          el('div', { class: 'muted', style: 'font-size:.82em;margin-top:8px' }, 'AUTO moves the whole mix slowly toward the target. Reaction time = how long it takes to fix most of a difference; the dB/s limits stop sudden jumps (a faster turn down than up catches loud moments without pumping quiet ones). “Leave alone within” stops it from chasing small changes; below “Ignore sound quieter than” (pauses, silence) it holds its level. It sits before the plug-ins, compressor and limiter. Right-click AUTO or click the Loudness box to open this page. Double-click a slider to reset it.'));
      };
      const compPage = () => el('div', { class: 'dyn-col' },
        el('div', { class: 'row', style: 'gap:8px;margin-bottom:10px' }, btnOn(c.on, 'COMPRESSOR', () => { c.on = !c.on; apply(); draw(); syncAudioButtons(); })),
        slider({ label: 'Threshold', min: -60, max: 0, step: 0.5, value: c.threshold, reset: -24, fmt: v => `${v.toFixed(1)} dB`, onInput: v => { c.threshold = v; apply(); } }),
        slider({ label: 'Ratio', min: 0, max: RATIOS.length - 1, step: 1, value: ri, reset: RATIOS.indexOf(3), fmt: v => `${RATIOS[v]}:1`, onInput: v => { c.ratio = RATIOS[v]; apply(); } }),
        slider({ label: 'Attack', min: 0, max: 120, step: 1, value: c.attack, reset: 10, fmt: v => `${v} ms`, onInput: v => { c.attack = v; apply(); } }),
        slider({ label: 'Release', min: 10, max: 1000, step: 1, value: c.release, reset: 150, fmt: v => `${v} ms`, onInput: v => { c.release = v; apply(); } }),
        slider({ label: 'Out gain', min: 0, max: 18, step: 0.5, value: c.makeup, reset: 0, fmt: v => `${v.toFixed(1)} dB`, onInput: v => { c.makeup = v; apply(); } }),
        el('div', { class: 'row', style: 'gap:10px;align-items:center;margin:6px 0' }, el('span', { class: 'lbl', style: 'width:calc(110px * var(--scale));font-weight:600' }, 'Knee'),
          el('div', { class: 'seg' }, [['HARD', 0], ['1', 2], ['2', 4], ['3', 6], ['4', 8], ['5', 10]].map(([t, k]) => el('button', { class: 'btn small' + (c.knee === k ? ' sel' : ''), onclick: () => { c.knee = k; apply(); draw(); } }, t)))),
        el('div', { class: 'muted', style: 'font-size:.82em;margin-top:10px' }, 'The compressor evens out the level before the limiter. It works on what the stream and recording hear, after the mixer. Double-click a slider to reset it.'));
      // the limiter page, laid out like an L2: input meters + Threshold, Out Ceiling + output meters, Atten, Release + ARC
      const limPage = () => {
        const thr = vfader({ min: -30, max: 0, value: l.threshold, reset: l.ceiling, fmt: v => v.toFixed(1), onInput: v => { l.threshold = v; apply(); } });
        const ceil = vfader({ min: -30, max: 0, value: l.ceiling, reset: -1, fmt: v => v.toFixed(1), onInput: v => { l.ceiling = v; apply(); } });
        const rel = vfader({ min: 0.01, max: 1000, log: true, value: l.release, reset: 100, round: v => v < 10 ? Math.round(v * 100) / 100 : v < 100 ? Math.round(v * 10) / 10 : Math.round(v), fmt: v => v.toFixed(v < 10 ? 2 : v < 100 ? 1 : 0), onInput: v => { l.release = v; apply(); } });
        const pk = k => el('button', { class: 'l2-pk mono', 'data-pk': k, title: 'Highest level — click to reset', onclick: () => { L2.hold[k] = k === 'att' ? 0 : -90; } }, '—');
        const sec = (name, peaks, row, foot) => el('div', { class: 'l2-sec' }, el('div', { class: 'l2-name' }, name), el('div', { class: 'l2-peaks' }, ...peaks), el('div', { class: 'l2-row' }, ...row), el('div', { class: 'l2-foot' }, ...foot));
        return el('div', { class: 'l2' + (m.limiter ? '' : ' off') },
          el('div', { class: 'l2-head' },
            btnOn(!!m.limiter, 'LIMITER', () => { m.limiter = !m.limiter; apply(); draw(); refresh('audio'); syncAudioButtons(); }),
            el('span', { class: 'l2-title' }, 'Peak limiter'), el('span', { class: 'grow' }),
            el('span', { class: 'l2-gain mono', title: 'How much the level is pushed up (ceiling − threshold)' }, `+${Math.max(0, l.ceiling - l.threshold).toFixed(1)} dB`)),
          el('div', { class: 'l2-body' },
            sec('Threshold', [pk('inL'), pk('inR')], [L2.cIn, thr.track], [thr.box, el('span', { class: 'l2-unit' }, 'dB')]),
            sec('Out Ceiling', [pk('outL'), pk('outR')], [ceil.track, L2.cOut], [ceil.box, el('span', { class: 'l2-unit' }, 'dB')]),
            sec('Atten', [pk('att')], [L2.cAtt], [el('span', { class: 'l2-unit' }, 'dB')]),
            sec('Release', [], [rel.track], [rel.box, el('span', { class: 'l2-unit' }, 'ms'),
              el('button', { class: 'btn l2-arc' + (l.arc ? ' on' : ''), title: 'ARC — automatic release: follows the music, longer when the limiter works all the time so it does not pump', onclick: () => { l.arc = !l.arc; apply(); draw(); } }, 'ARC')]),
            el('div', { class: 'l2-idr' },
              el('div', { class: 'l2-name' }, 'IDR'),
              el('div', { class: 'l2-idr-cols' },
                ...[['Quantize', 'bits', [[24, '24 bit'], [22, '22'], [20, '20'], [16, '16'], [12, '12'], [8, '8']]],
                  ['Dither', 'dither', [['none', 'None'], ['type1', 'Type 1'], ['type2', 'Type 2']]],
                  ['Shaping', 'shaping', [['none', 'None'], ['moderate', 'Moderate'], ['normal', 'Normal'], ['ultra', 'Ultra']]]].map(([name, key, opts]) =>
                  el('div', { class: 'l2-idr-col' }, el('div', { class: 'l2-sub' }, name),
                    ...opts.map(([v, t]) => el('button', { class: 'btn small l2-opt' + (l[key] === v ? ' sel' : ''), onclick: () => { l[key] = v; apply(); draw(); } }, t))))))),
          el('div', { class: 'l2-help' }, 'Works like an L2: lower the Threshold to make it louder — the level goes up by (ceiling − threshold) and a look-ahead brickwall stops every peak at the Out Ceiling. ARC makes the release follow the music. IDR rounds the output to the bits you choose (for YouTube 24 bit is right). Drag a fader (Shift = fine), mouse wheel, double-click to reset, or type in the box.'));
      };
      put(body,
        tabs,
        tab === 'fx' || tab === 'auto' ? null : presetRow,
        tab === 'auto' ? autoPage() : tab === 'fx' ? vstPage() : tab === 'lim' ? limPage() : el('div', { class: 'dyn-wrap' }, compPage(), el('div', { class: 'dyn-col dyn-vis' }, graph, meters)),
        el('div', { class: 'row', style: 'margin-top:12px' }, el('span', { class: 'grow' }), el('button', { class: 'btn primary', onclick: () => { closeModal(); refresh('audio'); if (VSTR.ready) for (const x of vstIns()) if ((VSTR.slots.get(x.id) || {}).ok) S.vstCmd(['get-state', x.id]); } }, 'Done')));
    };
    // live picture: the curve, where the sound is on it right now, and In / GR / Out meters
    const hist = { in: -90, comp: 0, lim: 0, out: -90 };
    const tick = () => {
      if (!body.isConnected) return;
      requestAnimationFrame(tick);
      if (!graph.isConnected) return; // limiter page open
      const now = performance.now(); if (now - (tick.at || 0) < 33) return; tick.at = now;
      const M = mixer.dynMeters(), A = rt.MA || { peakL: -90, peakR: -90 };
      hist.in = Math.max(M.in, hist.in - 1.5); hist.comp = Math.min(M.comp, hist.comp + 0.6); hist.lim = Math.min(M.lim, hist.lim + 0.6); hist.out = Math.max(Math.max(A.peakL, A.peakR), hist.out - 1.5);
      const g = graph.getContext('2d'), W = graph.width, H = graph.height, pad = 46, S = W - pad - 14;
      const X = db => pad + (db + 60) / 60 * S, Y = db => 14 + (1 - (db + 60) / 60) * S;
      g.clearRect(0, 0, W, H); g.fillStyle = '#0a0a0c'; g.fillRect(pad, 14, S, S);
      g.font = '18px Consolas, monospace'; g.fillStyle = '#8d8d96'; g.textAlign = 'right'; g.textBaseline = 'middle';
      for (let db = -60; db <= 0; db += 6) {
        g.fillStyle = '#26262b'; g.fillRect(X(db), 14, 1, S); g.fillRect(pad, Y(db), S, 1);
        if (db % 12 === 0) { g.fillStyle = '#8d8d96'; g.fillText(String(db), pad - 6, Y(db)); g.textAlign = 'center'; g.fillText(String(db), X(db), 14 + S + 18); g.textAlign = 'right'; }
      }
      const out = x => { let y = c.on ? compCurve(x, c.threshold, c.ratio, c.knee) + c.makeup : x; if (m.limiter) y = Math.min(y + Math.max(0, l.ceiling - l.threshold), l.ceiling); return y; };
      g.strokeStyle = '#3f3f46'; g.setLineDash([6, 6]); g.beginPath(); g.moveTo(X(-60), Y(-60)); g.lineTo(X(0), Y(0)); g.stroke(); g.setLineDash([]);
      if (c.on) { g.strokeStyle = 'rgba(234,179,8,.5)'; g.beginPath(); g.moveTo(X(c.threshold), 14); g.lineTo(X(c.threshold), 14 + S); g.stroke(); }
      if (m.limiter) { g.strokeStyle = 'rgba(239,68,68,.6)'; g.setLineDash([4, 4]); g.beginPath(); g.moveTo(pad, Y(l.ceiling)); g.lineTo(pad + S, Y(l.ceiling)); g.stroke(); g.setLineDash([]); }
      g.strokeStyle = '#4ade80'; g.lineWidth = 4; g.beginPath();
      for (let x = -60; x <= 0; x += 0.5) { const y = Math.max(-60, Math.min(0, out(x))); if (x === -60) g.moveTo(X(x), Y(y)); else g.lineTo(X(x), Y(y)); }
      g.stroke(); g.lineWidth = 1;
      if (hist.in > -60) { const xi = Math.min(0, hist.in), yo = Math.max(-60, Math.min(0, out(xi))); g.fillStyle = '#fff'; g.beginPath(); g.arc(X(xi), Y(yo), 9, 0, 7); g.fill(); }
      // meters: In · comp GR · limiter GR · Out
      const mg = meters.getContext('2d'), mw = meters.width, mh = meters.height, top = 14, bh = mh - 110, bw = 40;
      mg.clearRect(0, 0, mw, mh);
      const col = (i, label, v, gr) => {
        const x = 8 + i * (bw + 16);
        mg.fillStyle = '#0a0a0c'; mg.fillRect(x, top, bw, bh);
        if (gr) { const f = Math.min(1, -v / (label === 'LIM' ? 30 : 20)); mg.fillStyle = '#f59e0b'; mg.fillRect(x, top, bw, bh * f); }
        else { const f = Math.max(0, (v + 60) / 60); mg.fillStyle = v > -6 ? '#ef4444' : v > -18 ? '#eab308' : '#22c55e'; mg.fillRect(x, top + bh * (1 - f), bw, bh * f); }
        mg.fillStyle = '#d4d4d8'; mg.font = '700 28px Inter, Segoe UI, sans-serif'; mg.textAlign = 'center'; mg.fillText(label, x + bw / 2, top + bh + 36);
        mg.font = '600 24px Consolas, monospace'; mg.fillStyle = '#a1a1aa'; mg.fillText(gr ? (v < -0.05 ? v.toFixed(1) : '0') : (v <= -60 ? '−∞' : v.toFixed(0)), x + bw / 2, top + bh + 76);
      };
      col(0, 'In', hist.in, false); col(1, 'GR', hist.comp, true); col(2, 'LIM', hist.lim, true); col(3, 'Out', hist.out, false);
    };
    // L2-style meters: 0 dB at the top, −30 at the bottom, same scale as the faders next to them
    const drawL2 = () => {
      const k = devicePixelRatio, y = db => (L2P + L2H * Math.min(1, Math.max(0, -db / 30))) * k;
      const lvl = (cv, a, b, scaleLeft) => {
        const g = cv.getContext('2d'), W = cv.width, H = cv.height; g.clearRect(0, 0, W, H);
        const sw = 30 * k, bw = 22 * k, gap = 6 * k, x0 = scaleLeft ? sw : 4 * k;
        g.font = `600 ${12 * k}px Consolas, monospace`; g.textBaseline = 'middle'; g.textAlign = scaleLeft ? 'right' : 'left';
        for (let d = 0; d >= -30; d -= 3) { g.fillStyle = '#9fb0c2'; g.fillText(String(-d === 0 ? 0 : d), scaleLeft ? sw - 5 * k : x0 + 2 * bw + gap + 5 * k, y(d)); }
        [a, b].forEach((v, i) => {
          const x = x0 + i * (bw + gap);
          g.fillStyle = '#0b0f14'; g.fillRect(x, y(0), bw, y(-30) - y(0));
          g.fillStyle = '#1c2530'; for (let d = -3; d > -30; d -= 3) g.fillRect(x, y(d), bw, 1);
          if (v > -30) {
            const grd = g.createLinearGradient(0, y(-30), 0, y(0)); grd.addColorStop(0, '#16a34a'); grd.addColorStop(0.6, '#4ade80'); grd.addColorStop(0.8, '#facc15'); grd.addColorStop(0.95, '#ef4444');
            g.fillStyle = grd; g.fillRect(x, y(v), bw, y(-30) - y(v));
          }
        });
      };
      lvl(L2.cIn, L2.lv.inL, L2.lv.inR, true);
      lvl(L2.cOut, L2.lv.outL, L2.lv.outR, false);
      // attenuation: grows down from the top, 0 … 30 dB
      const g = L2.cAtt.getContext('2d'), W = L2.cAtt.width; g.clearRect(0, 0, W, L2.cAtt.height);
      const bw = 26 * k, x = 4 * k, ya = d => (L2P + L2H * Math.min(1, d / 30)) * k;
      g.fillStyle = '#0b0f14'; g.fillRect(x, ya(0), bw, ya(30) - ya(0));
      g.fillStyle = '#1c2530'; for (let d = 3; d < 30; d += 3) g.fillRect(x, ya(d), bw, 1);
      if (L2.lv.att > 0.05) { g.fillStyle = '#f59e0b'; g.fillRect(x, ya(0), bw, ya(L2.lv.att) - ya(0)); }
      g.font = `600 ${12 * k}px Consolas, monospace`; g.textBaseline = 'middle'; g.textAlign = 'left'; g.fillStyle = '#9fb0c2';
      for (let d = 0; d <= 30; d += 3) g.fillText(String(d), x + bw + 5 * k, ya(d));
      // highest levels, in the boxes over the meters
      for (const b of body.querySelectorAll('.l2-pk')) {
        const key = b.dataset.pk, v = L2.hold[key];
        b.textContent = key === 'att' ? (v > 0.05 ? v.toFixed(1) : '0.0') : (v <= -60 ? '−∞' : v.toFixed(1));
        b.classList.toggle('hot', key === 'outL' || key === 'outR' ? v > l.ceiling + 0.05 : key === 'att' ? v > 6 : false);
      }
    };
    const tickL2 = () => {
      if (!body.isConnected) return;
      requestAnimationFrame(tickL2);
      const now = performance.now(); if (now - (tickL2.at || 0) < 33) return; tickL2.at = now;
      if (!body.querySelector('.l2')) return;
      const [iL, iR] = mixer.limInput(), A = rt.MA || { peakL: -90, peakR: -90 }, att = m.limiter ? -mixer.dynMeters().lim : 0;
      const fall = (key, v) => { L2.lv[key] = Math.max(v, L2.lv[key] - 1.2); if (v > L2.hold[key]) L2.hold[key] = v; };
      fall('inL', iL); fall('inR', iR); fall('outL', A.peakL); fall('outR', A.peakR);
      L2.lv.att = Math.max(att, L2.lv.att - 0.8); if (att > L2.hold.att) L2.hold.att = att;
      drawL2();
    };
    draw();
    openModal('Master — compressor, limiter & plug-ins', body);
    requestAnimationFrame(tickL2);
    requestAnimationFrame(tick);
  }
  function drawMaster(A) {
    if (!masterCanvas.isConnected) return;
    const fit = (c) => { const r = cssSize(c); const w = Math.max(10, Math.round(r.width * devicePixelRatio)), h = Math.max(10, Math.round(r.height * devicePixelRatio)); if (c.width !== w || c.height !== h) { c.width = w; c.height = h; } return c.getContext('2d'); };
    let g = fit(masterCanvas); const W = masterCanvas.width, H = masterCanvas.height, k = devicePixelRatio;
    g.clearRect(0, 0, W, H);
    const top = 20 * k, bot = 20 * k, mh = H - top - bot;
    const y = db => top + mh * (1 - meterFrac(db));
    const scaleW = 24 * k, gap = 5 * k, bw = (W - scaleW - gap * 3) / 2;
    g.font = `${10 * k}px Inter, Segoe UI, sans-serif`; g.textAlign = 'right'; g.textBaseline = 'middle';
    let lastY = -1e9;
    for (const d of METER_TICKS) { const yy = y(d); if (yy - lastY < 11 * k) continue; lastY = yy; g.fillStyle = d >= -6 ? '#d4d4d8' : '#8d8d96'; g.fillText(String(d), scaleW - 4 * k, yy); g.fillStyle = '#2a2a2f'; g.fillRect(scaleW, yy, W - scaleW, 1); }
    const bar = (i, peak, rms, hold, clip, label) => {
      const x = scaleW + gap + i * (bw + gap);
      g.fillStyle = '#0a0a0c'; g.fillRect(x, top, bw, mh);
      const grad = g.createLinearGradient(0, top + mh, 0, top);
      grad.addColorStop(0, '#15803d'); grad.addColorStop(meterFrac(-18), '#22c55e'); grad.addColorStop(meterFrac(-12), '#eab308'); grad.addColorStop(meterFrac(-6), '#f97316'); grad.addColorStop(meterFrac(-2), '#ef4444');
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
    // loudness against the target (YouTube's −14 LUFS unless changed in the AUTO settings)
    const lu = v => v <= -60 ? '—' : v.toFixed(1), tg = autoCfg().target, yt = tg === -14;
    const d = A.lufsS - tg;
    const cls = A.lufsS <= -60 ? '' : d > 2 ? 'bad' : d < -4 ? 'low' : 'ok';
    const hint = A.lufsS <= -60 ? 'no sound' : yt ? (d > 2 ? `${d.toFixed(0)} dB louder than YouTube’s level — it will be turned down` : d < -4 ? `${(-d).toFixed(0)} dB quieter than YouTube’s level` : 'matches YouTube ✓')
      : (d > 2 ? `${d.toFixed(0)} dB louder than the target` : d < -4 ? `${(-d).toFixed(0)} dB quieter than the target` : 'matches the target ✓');
    lufsBox.innerHTML = `<div><span class="mlabel">Loudness</span><span class="hint">target ${minus(tg)}</span></div><div class="big ${cls}">${lu(A.lufsS)} <small>LUFS</small></div><div class="hint" style="margin:0">${hint}${rt.autoDb ? ` · auto ${rt.autoDb > 0 ? '+' : ''}${rt.autoDb.toFixed(1)} dB` : ''}${rt.autoHold && show.audio.master.auto ? ' · frozen' : ''}</div>`;
  }
  /* AUTO: slow automatic level toward the target loudness (only while there is sound). Every half second:
       measure (Momentary 0.4 s / Short 3 s / Long 10 s gated) → if louder than the gate and outside the dead band,
       move by (error ÷ reaction time) — never faster than the up / down speed, never beyond the boost / cut range.
     The last minute is kept for the graph in DYN → AUTO LEVEL. */
  const autoMeasure = (C, A) => C.window === 'M' ? A.lufsM : C.window === 'L' ? (A.lufsL ?? A.lufsS) : A.lufsS;
  setInterval(() => {
    const m = show.audio.master, C = autoCfg(), A = rt.MA;
    const l = A ? autoMeasure(C, A) : -70;
    let state = 'off';
    if (!m.auto || !A) { if (rt.autoDb) { rt.autoDb = 0; mixer.setAuto(0); } }
    else if (rt.autoHold) state = 'frozen';
    else if (l < C.gate) state = 'quiet';
    else {
      const err = C.target - l;
      if (Math.abs(err) <= C.dead) state = 'ok';
      else {
        const e = err - Math.sign(err) * C.dead;
        const step = clamp(e * 0.5 / Math.max(0.5, C.reaction), -C.down * 0.5, C.up * 0.5);
        rt.autoDb = clamp((rt.autoDb || 0) + step, -C.maxDown, C.maxUp);
        mixer.setAuto(rt.autoDb);
        state = step > 0 ? 'up' : 'down';
      }
    }
    rt.autoState = state; rt.autoNow = l;
    const H = rt.autoHist || (rt.autoHist = []);
    H.push({ l, g: rt.autoDb || 0, on: !!m.auto }); if (H.length > 120) H.shift();
    drawAutoGraph(rt.autoGraph);
    if (rt.autoInfo && rt.autoInfo.isConnected) rt.autoInfo();
  }, 500);
  // the last minute: loudness (green; grey when quieter than the gate), the target and its dead band, AUTO's gain (orange)
  function drawAutoGraph(cv) {
    if (!cv || !cv.isConnected) return;
    const C = autoCfg(), H0 = rt.autoHist || [], g = cv.getContext('2d'), W = cv.width, Hh = cv.height;
    const pl = 86, pr = 86, top = 18, bot = 40, gw = W - pl - pr, gh = Hh - top - bot;
    const lo = Math.min(-40, C.target - 16), hi = Math.max(-4, C.target + 8), rng = Math.max(6, C.maxUp, C.maxDown);
    const Y = v => top + (1 - (clamp(v, lo, hi) - lo) / (hi - lo)) * gh, YG = v => top + (1 - (v + rng) / (2 * rng)) * gh, X = i => pl + gw * (1 - (H0.length - 1 - i) / 119);
    g.clearRect(0, 0, W, Hh); g.fillStyle = '#0a0a0c'; g.fillRect(pl, top, gw, gh);
    g.font = '20px Consolas, monospace'; g.textBaseline = 'middle';
    for (let v = Math.ceil(lo / 6) * 6; v <= hi; v += 6) { g.fillStyle = '#1f1f24'; g.fillRect(pl, Y(v), gw, 1); g.fillStyle = '#8d8d96'; g.textAlign = 'right'; g.fillText(minus(v), pl - 10, Y(v)); }
    g.fillStyle = '#f59e0b'; g.textAlign = 'left';
    for (const v of [rng, rng / 2, 0, -rng / 2, -rng]) g.fillText((v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(Math.round(v)), pl + gw + 10, YG(v));
    g.fillStyle = '#8d8d96'; g.textAlign = 'center'; g.textBaseline = 'alphabetic';
    g.fillText('LUFS', pl / 2, Hh - 10); g.fillText(T('−60 s'), pl + 30, Hh - 10); g.fillText(T('now'), pl + gw - 20, Hh - 10); g.fillStyle = '#f59e0b'; g.fillText(T('dB'), pl + gw + pr / 2, Hh - 10);
    if (C.dead > 0) { g.fillStyle = 'rgba(96,165,250,.13)'; g.fillRect(pl, Y(C.target + C.dead), gw, Y(C.target - C.dead) - Y(C.target + C.dead)); }
    g.strokeStyle = '#60a5fa'; g.lineWidth = 2; g.setLineDash([10, 8]); g.beginPath(); g.moveTo(pl, Y(C.target)); g.lineTo(pl + gw, Y(C.target)); g.stroke();
    if (C.gate > lo) { g.strokeStyle = '#52525b'; g.beginPath(); g.moveTo(pl, Y(C.gate)); g.lineTo(pl + gw, Y(C.gate)); g.stroke(); }
    g.setLineDash([]);
    g.strokeStyle = 'rgba(245,158,11,.35)'; g.lineWidth = 1; g.beginPath(); g.moveTo(pl, YG(0)); g.lineTo(pl + gw, YG(0)); g.stroke();
    g.lineWidth = 3;
    for (let i = 1; i < H0.length; i++) { const a = H0[i - 1], b = H0[i]; if (a.l <= -60 || b.l <= -60) continue; g.strokeStyle = b.l < C.gate ? '#52525b' : '#4ade80'; g.beginPath(); g.moveTo(X(i - 1), Y(a.l)); g.lineTo(X(i), Y(b.l)); g.stroke(); }
    g.strokeStyle = '#f59e0b'; g.beginPath(); H0.forEach((b, i) => { const y = YG(clamp(b.g, -rng, rng)); if (i) g.lineTo(X(i), y); else g.moveTo(X(i), y); }); g.stroke();
    g.lineWidth = 1;
  }

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
          if (g) { a.deviceId = g.id; rememberDevice(a, 'audio'); }
        }
        openAudioInput(a, true, attempt + 1);
      }, attempt < 5 ? 2000 : 6000));
      refresh('audio');
    }
  }
  function tickMeters() {
    // meters, scope and playbars refresh 30 times a second: smooth to the eye, and it leaves the
    // program thread free for the video (which runs at the full frame rate)
    const tNow = performance.now();
    if (tNow - (rt.uiAt || 0) < 30) { requestAnimationFrame(tickMeters); return; }
    rt.uiAt = tNow;
    const lv = mixer.levels();
    const MA = mixer.masterAnalysis(); rt.MA = MA;
    // how hard the limiter / compressor are working, held for a moment so it can be read
    const gm = mixer.grNow(), m0 = show.audio.master;
    const hold = (key, v) => { const H = rt.grHold || (rt.grHold = {}), o = H[key] || (H[key] = { v: 0, at: 0, t: tNow }); const dt = (tNow - o.t) / 1000; o.t = tNow; if (v >= o.v) { o.v = v; o.at = tNow; } else if (tNow - o.at > 900) o.v = Math.max(v, o.v - 12 * dt); return o.v; }; // peak held ~1 s, then falls 12 dB/s
    const lim = m0.limiter ? hold('lim', Math.max(0, -gm.lim)) : 0, cmp = dynCfg().comp.on ? hold('comp', Math.max(0, -gm.comp)) : 0;
    drawMaster(MA); drawMonMeter(MA, monMeterMain, 'left', m0.limiter ? lim : null);
    for (const b of document.querySelectorAll('.tbtn[data-akey="limiter"]')) {
      const t = T(m0.limiter && lim >= 0.3 ? `LIMIT −${lim.toFixed(1)}` : 'LIMIT');
      if (b.textContent !== t) b.textContent = t;
      b.classList.toggle('working', m0.limiter && lim >= 0.3); b.classList.toggle('hard', m0.limiter && lim > 6);
    }
    for (const b of document.querySelectorAll('.tbtn[data-akey="dyn"]')) {
      const t = T(cmp >= 0.3 ? `DYN −${cmp.toFixed(1)}` : 'DYN');
      if (b.textContent !== t) b.textContent = t;
      b.classList.toggle('working', cmp >= 0.3);
    }
    if (miniLufs.isConnected) { const v = MA.lufsS, d = v - autoCfg().target; setText(miniLufs, v <= -60 ? '— LUFS' : `${v.toFixed(1)} LUFS`); const cls = 'mini-lufs mono' + (v <= -60 ? '' : d > 2 ? ' bad' : d < -4 ? ' low' : ' ok'); if (miniLufs.className !== cls) miniLufs.className = cls; } drawMonMeter(mixer.previewAnalysis(), pvMeter, 'right');
    for (const [id, m] of rt.meters) {
      const db = lv[id];
      if (db === undefined) continue;
      const cp = `inset(0 ${(100 - clamp((db + 60) / 72, 0, 1) * 100).toFixed(1)}% 0 0)`; if (m.cp !== cp) { m.cp = cp; m.i.style.clipPath = cp; } // same scale as the fader (−60 … +12 dB); colours stay fixed to the scale
    }
    // media progress on program monitor
    const s = getShot(engine.programId);
    const mid = s ? mediaOf(s)[0] : null;
    const f = mid && rt.files.get(mid);
    if (f && f.el && f.el.duration && !f.el.loop) {
      if (progInfo.classList.contains('hidden')) { progInfo.classList.remove('hidden'); progBar.classList.remove('hidden'); }
      setText(progInfo, `−${fmtShort(f.el.duration - f.el.currentTime)}`);
      const wd = `${((f.el.currentTime / f.el.duration) * 100).toFixed(1)}%`; if (progBar.firstChild.style.width !== wd) progBar.firstChild.style.width = wd;
    } else if (!progInfo.classList.contains('hidden')) { progInfo.classList.add('hidden'); progBar.classList.add('hidden'); }
    timelineLive.update(); timelinePv.update();
    const tlHide = timelineLive.bar.classList.contains('hidden') && timelinePv.bar.classList.contains('hidden');
    if (timeline.classList.contains('hidden') !== tlHide) timeline.classList.toggle('hidden', tlHide);
    const spent = performance.now() - tNow; rt.uiMs = rt.uiMs === undefined ? spent : rt.uiMs * 0.95 + spent * 0.05;
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
          el('div', { class: 'row wrap', style: 'margin-top:6px;gap:6px' },
            select(devOpts, cam.deviceId, v => { cam.deviceId = v; delete cam.fps; rememberDevice(cam, 'video'); changed(); openCamera(cam); }, { class: 'grow' }),
            select([['720', '720p'], ['1080', '1080p'], ['2160', '4K']], cam.res || '1080', v => { cam.res = v; changed(); openCamera(cam); }),
            select([['', 'Auto fps'], ['23.98', '23.98'], ['24', '24'], ['25', '25'], ['29.97', '29.97'], ['30', '30'], ['50', '50'], ['59.94', '59.94'], ['60', '60']], cam.fps || '', v => { cam.fps = v; changed(); openCamera(cam); }, { title: 'Must match the signal your camera sends' }),
            select([['auto', 'p / i: automatic'], ['p', 'Progressive (p)'], ['i', 'Interlaced (1080i)']], cam.signal || 'auto', v => { cam.signal = v; NAT.force.delete(cam.id); NAT.tried.delete(cam.id); changed(); logEvent('CAMERA', `${cam.name}: signal ${v}`); openCamera(cam); refresh('inputs'); }, { title: 'Progressive (1080p) or interlaced (1080i) signal from the camera. Interlaced is deinterlaced back to full motion. Automatic recognises it by itself with the native engine.' })),
          NAT.on && NAT.devices ? el('div', { class: 'row', style: 'margin-top:6px' }, el('span', { class: 'muted', style: 'font-size:.85em;white-space:nowrap' }, 'Card (native engine)'),
            select([['', 'Automatic'], ...NAT.devices.video.map(v => [`${v.name}|${v.n}`, `${v.name} — card ${v.n + 1}${natExact(v, false, cam).length ? '' : (settings.output.fps || 59.94) > 30 && natExact(v, false, cam, (settings.output.fps || 59.94) / 2).length ? ' (1080i only)' : ` (no ${settings.output.fps} fps)`}`])],
              cam.native ? `${cam.native.name}|${cam.native.n}` : '', v => { const i = v.lastIndexOf('|'); cam.native = v ? { name: v.slice(0, i), n: +v.slice(i + 1) } : null; changed(); NAT.cams.delete(cam.id); natOpenCamera(cam); }, { class: 'grow' })) : null,
          el('div', { style: 'font-size:.85em;margin-top:5px' }, el('span', { dataset: { camStatus: cam.id } })))));
    }
    put(body, el('div', { class: 'row', style: 'margin-bottom:14px' },
      el('button', { class: 'btn', onclick: addCamera }, '+ Add camera'),
      el('button', { class: 'btn ghost small', onclick: async () => { await refreshDevices(); refresh('inputs'); toast(`Found ${rt.devices.video.length} video and ${rt.devices.audio.length} audio devices.`); } }, '↻ Rescan devices')));

    put(body, el('div', { class: 'section' }, el('h4', null, 'Video, picture & music files')));
    if (!show.files.length) put(body, el('div', { class: 'empty' }, 'Add intro/ending videos, background loops or logos.'));
    for (const f of show.files) {
      const st = rt.files.get(f.id) || { ok: false, text: '' };
      put(body, el('div', { class: 'input-card' }, f.kind === 'audio' ? el('div', { class: 'music-tile' }, '♪') : viewFor(f.id),
        el('div', null,
          el('div', { class: 'row' }, el('input', { type: 'text', class: 'grow', value: f.name, oninput: e => { f.name = e.target.value; changed(); } }),
            el('button', { class: 'btn small danger', title: 'Remove file', onclick: () => removeFile(f) }, '✕')),
          fileStatus(f.id),
          f.kind !== 'image' ? el('div', { style: 'margin-top:5px' }, check(' Loop', f.loop, v => { f.loop = v; const m = rt.files.get(f.id); if (m && m.el) m.el.loop = v; changed(); })) : null,
          !st.ok ? el('button', { class: 'btn small', style: 'margin-top:5px', onclick: () => loadFile(f) }, 'Try again') : null)));
    }
    put(body, el('button', { class: 'btn', onclick: addFiles }, '+ Add video / picture / music'));
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
    let outWarnDraw = () => {};
    const keyInput = el('input', { type: 'password', value: y.key, placeholder: 'Paste your stream key', class: 'grow', autocomplete: 'off', oninput: e => { y.key = e.target.value.trim(); saveSettings(); } });
    const customRow = el('div', { class: 'field' + (y.server === 'custom' ? '' : ' hidden') }, el('span', null, 'Server address (RTMP/RTMPS)'), el('input', { type: 'text', value: y.custom, placeholder: 'rtmps://…', oninput: e => { y.custom = e.target.value; saveSettings(); } }));
    const version = await S.version();
    const ffv = el('span', { class: 'muted', style: 'font-size:.85em;margin-left:10px' });
    if (S.ffmpegVersion) S.ffmpegVersion().then(v => { ffv.textContent = `· encoder engine FFmpeg ${v}`; }).catch(() => {});
    const updStatus = el('span', { class: 'muted', id: 'updStatus' });
    // what 4K / 1440p needs, said right under the choices
    const outWarn = el('div', { style: 'margin:-2px 0 8px' });
    outWarnDraw = () => {
      outWarn.innerHTML = '';
      if (!bigOut()) return;
      const lines = [];
      if (o.engine !== 'native') lines.push(['status-bad', 'The classic engine sends 1080p — choose “Native” under Picture engine for 4K / 1440p.']);
      if (o.encoder === 'x264') lines.push(['status-bad', '4K / 1440p needs a graphics-card encoder (NVIDIA NVENC) — the processor cannot encode it in time.']);
      lines.push(['muted', `${o.height >= 2160 ? '4K at 60 fps: YouTube recommends about 35,000 kbps' : '1440p at 60 fps: YouTube recommends about 24,000 kbps'} — your internet upload should be about 1.5× that. The 1080p cameras are scaled up; titles, pictures and web pages are drawn at full size. Recording at this size makes large files.`]);
      for (const [c, t] of lines) put(outWarn, el('div', { class: c, style: 'font-size:.85em;margin-top:4px' }, t));
    };
    outWarnDraw();
    const resChange = v => {
      const [w, h] = v.split('x').map(Number);
      if (live) { toast('Stop streaming/recording before changing video output settings.', 'error'); return; }
      o.width = w; changeOut('height', h);
      const want = h >= 2160 ? 35000 : h >= 1440 ? 24000 : 0;
      if (want && (o.bitrate || 0) < want * 0.6) toast(`The stream is set to ${o.bitrate} kbps — for ${h >= 2160 ? '4K' : '1440p'} YouTube recommends ${want.toLocaleString('en-US')} kbps.`, '', { label: `Use ${want.toLocaleString('en-US')} kbps`, fn: () => { o.bitrate = want; o.audioBitrate = Math.max(o.audioBitrate || 160, 192); saveSettings(); openSettings('out'); } });
      logEvent('SETTINGS', `output ${w}×${h}`);
    };
    const changeOut = (k, v) => {
      if (live) { toast('Stop streaming/recording before changing video output settings.', 'error'); return; }
      o[k] = v; saveSettings(); outWarnDraw();
      if (k === 'width' || k === 'height' || k === 'fps') {
        engine.setSize(uiW(), uiH()); engine.setFps(o.fps);
        engine.setSource('bars', makeBars(uiW(), uiH()), 'image');
        previewCanvas.height = Math.round(previewCanvas.width * o.height / o.width);
        if (NAT.on) { clearTimeout(rt.natRestart); rt.natRestart = setTimeout(() => switchEngine('native'), 600); }
      }
    };
    /* picture + sound bitrate with ready-made and your own presets, separately for live and recording */
    const QUAL = {
      live: { v: 'bitrate', a: 'audioBitrate', vr: [1000, 51000], ar: [64, 384], builtin: [['Wirecast “Pilgrim Live Services”', 10000, 192, { on: true, encoder: 'x264', w: 1920, h: 1080, fps: 60, speed: 'superfast', profile: 'main', gop: 120, cbr: false, aligned: false, x264: '--bframes 0', channels: 2, rate: 48000, timecode: false }], ['YouTube 4K 60 fps', 35000, 192], ['YouTube 1440p 60 fps', 24000, 192], ['YouTube 1080p 60 fps', 12000, 192], ['YouTube 1080p 30 fps', 8000, 160], ['YouTube 720p', 5000, 128], ['Slow internet', 3000, 128]] },
      rec: { v: 'recordBitrate', a: 'recordAudioBitrate', vr: [1000, 100000], ar: [96, 512], builtin: [['Wirecast “Default Record Pavel”', 4500, 192, { on: true, encoder: 'x264', w: 1920, h: 1080, fps: 60, speed: 'superfast', profile: 'baseline', gop: 60, cbr: false, aligned: false, x264: '', channels: 2, rate: 48000, timecode: false }], ['4K (for editing)', 80000, 320], ['Standard', 20000, 256], ['High (for editing)', 40000, 320], ['Small files', 10000, 192], ['Very small (like Wirecast)', 3600, 160]] }
    };
    /* Live stream / Recording → Encoder settings: the same choices as Wirecast's encoder presets */
    function advBlock(kind, redraw) {
      const K = ADV_KEY[kind], Q = QUAL[kind], isRec = kind === 'rec';
      const R = o[K] || (o[K] = REC_DEF());
      const save = () => { saveSettings(); redraw(); };
      const enc = R.encoder || o.encoder || 'x264', encName = { x264: 'x264 (software)', nvenc: 'NVIDIA H.264', qsv: 'Intel H.264', amf: 'AMD H.264' };
      const progW = rt.eng ? o.width : uiW(), progH = rt.eng ? o.height : uiH();
      const num = (val, ph, on, attrs) => el('input', Object.assign({ type: 'number', value: val || '', placeholder: String(ph), disabled: live || null, style: 'width:120px', onchange: e => on(Math.max(0, Math.round(+e.target.value) || 0)) }, attrs || {}));
      const row = (label, ...ctl) => [el('span', { class: 'rec-adv-l' }, label), el('div', { class: 'row', style: 'gap:8px' }, ...ctl)];
      const body = R.on ? el('div', { class: 'rec-adv' },
        ...row('Encoder', select([['', `Same as Video output — ${encName[o.encoder] || o.encoder}`], ['x264', 'x264 (software)'], ['nvenc', 'NVIDIA H.264 (NVENC)'], ['qsv', 'Intel H.264 (Quick Sync)'], ['amf', 'AMD H.264 (AMF)']], R.encoder || '', v => { R.encoder = v; R.speed = ''; save(); }, { disabled: live || null })),
        ...row('Width', num(R.w, progW, v => { R.w = v & ~1; if (!v) R.h = 0; save(); }), el('span', { class: 'muted', style: 'font-size:.85em' }, 'empty = the program size')),
        ...row('Height', num(R.h, progH, v => { R.h = v & ~1; if (!v) R.w = 0; save(); })),
        ...row('Frames per second', select([[0, `Same as the program (${o.fps})`], [60, '60'], [59.94, '59.94'], [50, '50'], [30, '30'], [29.97, '29.97'], [25, '25'], [24, '24']], R.fps || 0, v => { R.fps = +v; save(); }, { disabled: live || null })),
        ...row('Average bit rate', num(o[Q.v], isRec ? 20000 : 8000, v => { o[Q.v] = clamp(v || (isRec ? 20000 : 8000), Q.vr[0], Q.vr[1]); save(); }, { step: 100 }), el('span', null, 'kbits/sec')),
        ...row('Quality', select(SPEEDS[enc] || SPEEDS.x264, R.speed && (SPEEDS[enc] || []).some(x => x[0] === R.speed) ? R.speed : SPEED_DEF[enc], v => { R.speed = v; save(); }, { disabled: live || null })),
        ...(enc === 'x264' ? row('x264 command line options', el('input', { type: 'text', value: R.x264 || '', placeholder: 'e.g. --bframes 0', disabled: live || null, class: 'grow', onchange: e => { R.x264 = e.target.value.trim(); save(); } })) : []),
        ...row('Profile', select([['baseline', 'Baseline'], ['main', 'Main'], ['high', 'High']], R.profile || 'high', v => { R.profile = v; save(); }, { disabled: live || null })),
        ...row('Key frame every', num(R.gop, Math.round((R.fps || o.fps || 30) * (isRec ? 1 : 2)), v => { R.gop = v; save(); }), el('span', null, 'frames')),
        !isRec && R.gop > 4 * (R.fps || o.fps || 30) ? el('div', { class: 'status-bad', style: 'grid-column:1/-1;font-size:.85em' }, `YouTube needs a key frame at least every 4 seconds (${Math.floor(4 * (R.fps || o.fps || 30))} frames or fewer).`) : null,
        ...(isRec ? [el('span'), check(' Timecode (the time of day, for editing)', R.timecode, v => { R.timecode = v; save(); })] : []),
        el('span'), check(' Strict constant bitrate', R.cbr, v => { R.cbr = v; save(); }),
        el('span'), check(' Keyframe aligned', R.aligned, v => { R.aligned = v; save(); }),
        el('div', { class: 'rec-adv-h' }, 'Audio (AAC)'),
        ...row('Channels', select([[2, 'Stereo'], [1, 'Mono']], R.channels === 1 ? 1 : 2, v => { R.channels = +v; save(); }, { disabled: live || null })),
        ...row('Target bit rate', select([96, 128, 160, 192, 256, 320].map(v => [v, String(v)]).concat([96, 128, 160, 192, 256, 320].includes(o[Q.a] || (isRec ? 256 : 160)) ? [] : [[o[Q.a], String(o[Q.a])]]), o[Q.a] || (isRec ? 256 : 160), v => { o[Q.a] = +v; save(); }, { disabled: live || null }), el('span', null, 'kbits/sec')),
        ...row('Sample rate', select([[48000, '48.000 kHz'], [44100, '44.100 kHz']], R.rate === 44100 ? 44100 : 48000, v => { R.rate = +v; save(); }, { disabled: live || null })),
        enc === 'x264' && (R.w > 1920 || (!R.w && progH > 1080)) ? el('div', { class: 'status-bad', style: 'grid-column:1/-1;font-size:.85em' }, isRec ? 'x264 cannot record 4K / 1440p in time — choose NVIDIA H.264.' : 'x264 cannot stream 4K / 1440p in time — choose NVIDIA H.264.') : null,
        rt.eng || !isRec ? null : el('div', { class: 'muted', style: 'grid-column:1/-1;font-size:.85em' }, 'With the classic engine the recording is encoded once more with these settings (instead of being copied).'))
        : el('div', { class: 'muted', style: 'font-size:.85em' }, isRec ? 'Off: recordings use the encoder from Video output and the bitrates above.' : 'Off: the stream uses the encoder from Video output and the bitrates above.');
      return el('div', { class: 'section', style: 'margin-top:4px' },
        el('h4', null, isRec ? 'Recording encoder settings' : 'Stream encoder settings'),
        check(isRec ? ' Use my own encoder settings for recordings (like Wirecast’s encoder presets)' : ' Use my own encoder settings for the live stream (like Wirecast’s encoder presets)', R.on, v => { R.on = v; save(); }),
        body);
    }
    function qualityBlock(kind) {
      const Q = QUAL[kind], wrap = el('div');
      s.presets = s.presets || { live: [], rec: [] };
      const draw = () => {
        const mine = s.presets[kind] || (s.presets[kind] = []);
        const all = [...Q.builtin.map(b => ({ name: b[0], v: b[1], a: b[2], adv: b[3] })), ...mine.map(m => ({ ...m, mine: true }))];
        // (a preset can hold the whole encoder setup; then it only matches when those settings are on and the same)
        const K = ADV_KEY[kind], advOn = !!(o[K] && o[K].on), sameAdv = x => JSON.stringify(Object.assign(REC_DEF(), x, { on: true })) === JSON.stringify(Object.assign(REC_DEF(), o[K], { on: true }));
        const cur = all.findIndex(x => x.v === o[Q.v] && x.a === o[Q.a] && (x.adv ? advOn && sameAdv(x.adv) : !advOn));
        const set = (v, a, adv) => {
          o[Q.v] = clamp(Math.round(v) || Q.vr[0], Q.vr[0], Q.vr[1]); o[Q.a] = clamp(Math.round(a) || Q.ar[0], Q.ar[0], Q.ar[1]);
          if (adv !== undefined) o[K] = adv ? Object.assign(REC_DEF(), clone(adv), { on: true }) : Object.assign(o[K] || REC_DEF(), { on: false });
          saveSettings(); draw();
        };
        const nameIn = el('input', { type: 'text', placeholder: 'Name for a new preset', style: 'flex:1;min-width:120px' });
        wrap.innerHTML = '';
        put(wrap,
          el('div', { class: 'grid2' },
            el('div', { class: 'field' }, el('span', null, 'Preset'), select([...all.map((x, i) => [i, `${x.mine ? '★ ' : ''}${x.name} — ${x.v.toLocaleString()} / ${x.a} kbps`]), ...(cur < 0 ? [[-1, 'Custom (not saved)']] : [])], cur, v => { const x = all[+v]; if (x) set(x.v, x.a, x.adv || null); })),
            el('div', { class: 'row', style: 'gap:10px;align-items:flex-end' },
              el('div', { class: 'field grow' }, el('span', null, 'Picture (kbps)'), el('input', { type: 'number', min: Q.vr[0], max: Q.vr[1], step: 100, value: o[Q.v], disabled: live || null, onchange: e => set(+e.target.value, o[Q.a]) })),
              el('div', { class: 'field grow' }, el('span', null, 'Sound (kbps)'), el('input', { type: 'number', min: Q.ar[0], max: Q.ar[1], step: 1, value: o[Q.a], disabled: live || null, onchange: e => set(o[Q.v], +e.target.value) })))),
          el('div', { class: 'row wrap', style: 'gap:8px;margin:-4px 0 10px' }, nameIn,
            el('button', { class: 'btn small', onclick: () => { const n = nameIn.value.trim(); if (!n) { toast('Type a name for the preset first.', 'error'); return; } const i = mine.findIndex(m => m.name === n); const pr = { name: n, v: o[Q.v], a: o[Q.a] }; if (o[K] && o[K].on) pr.adv = clone(o[K]); if (i >= 0) mine[i] = pr; else mine.push(pr); saveSettings(); draw(); toast(`Preset “${n}” saved.`); } }, '★ Save these numbers as a preset'),
            cur >= 0 && all[cur].mine ? el('button', { class: 'btn small danger', onclick: () => { s.presets[kind] = mine.filter(m => m.name !== all[cur].name); saveSettings(); draw(); } }, 'Delete this preset') : null),
          advBlock(kind, draw));
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
      el('div', { class: 'field' }, el('span', null, 'Stream key'), el('div', { class: 'row' }, keyInput, el('button', { class: 'btn small', onclick: e => { keyInput.type = keyInput.type === 'password' ? 'text' : 'password'; e.target.textContent = keyInput.type === 'password' ? 'Show' : 'Hide'; } }, 'Show'), el('button', { class: 'btn small primary', onclick: () => { saveSettings(); closeModal(); openStreamTest(); } }, '▶ Test this key'))),
      el('div', { class: 'muted', style: 'font-size:.85em' }, 'Find it in YouTube Studio → Create → Go live → Stream → “Stream key”. Keep it private — it is stored encrypted on this computer.'),

      el('h3', { id: 'set-out' }, 'Video output'),
      live ? el('div', { class: 'status-bad', style: 'margin-bottom:8px' }, 'Locked while live or recording.') : null,
      el('div', { class: 'grid2' },
        el('div', { class: 'field' }, el('span', null, 'Resolution'), select([['3840x2160', '4K (3840×2160) — native engine'], ['2560x1440', '1440p (2560×1440) — native engine'], ['1920x1080', '1080p (1920×1080)'], ['1280x720', '720p (1280×720)']], `${o.width}x${o.height}`, resChange)),
        el('div', { class: 'field' }, el('span', null, 'Frame rate'), select([[25, '25 fps'], [29.97, '29.97 fps (29.97 cameras)'], [30, '30 fps'], [50, '50 fps'], [59.94, '59.94 fps (59.94 cameras — Blackmagic)'], [60, '60 fps']], o.fps, v => changeOut('fps', +v))),
        el('div', { class: 'field' }, el('span', null, 'Encoder'), select([['x264', 'Software (works on every PC)'], ['nvenc', 'NVIDIA graphics card (NVENC)'], ['qsv', 'Intel graphics (Quick Sync)'], ['amf', 'AMD graphics card (AMF)']], o.encoder, v => changeOut('encoder', v))),
        el('div', { class: 'field' }, el('span', null, 'Picture engine'), select([['classic', 'Classic (inside the window)'], ['native', 'Native — OBS-style (test)']], o.engine || 'classic', v => {
          if (live) { toast('Stop streaming/recording before switching the picture engine.', 'error'); return; }
          o.engine = v; saveSettings(); outWarnDraw(); switchEngine(v); toast(v === 'native' ? 'Native engine: the cameras now go straight to it (a few seconds)…' : 'Classic engine', 'ok');
        })),
        (o.engine || 'classic') === 'native' ? el('div', { class: 'field' }, el('span', null, 'Sound/picture sync (native)'), el('div', { class: 'row' },
          el('input', { type: 'number', min: 0, max: 500, step: 10, value: o.videoDelayMs ?? 20, style: 'width:90px', onchange: e => { o.videoDelayMs = Math.max(0, Math.min(500, Math.round(+e.target.value || 0))); saveSettings(); } }),
          el('span', { class: 'muted' }, 'ms the picture waits for the sound (if lips move before you hear the words, raise it; starts with the next stream/recording)'))) : null),
      outWarn,
      el('div', { class: 'muted', style: 'font-size:.85em' }, 'Tip: use a hardware encoder if your PC has one — it leaves the processor free. Set the frame rate to exactly what the cameras send (Blackmagic at 59.94 → 59.94).'),
      rt.encFallback && rt.encFallback.for === o.encoder ? el('div', { class: 'status-bad', style: 'font-size:.9em;margin-top:6px' }, rt.encFallback.level >= 2 ? `This encoder would not start, so the software encoder is being used until the program is restarted. Updating the graphics card driver usually fixes it. Reported: ${rt.encFallback.detail || 'no details'}` : 'This encoder refused the tuned settings; plain settings are being used.') : null,
      el('h3', null, 'Live stream quality'),
      qualityBlock('live'),
      el('div', { class: 'muted', style: 'font-size:.85em' }, 'YouTube suggests 4,500–9,000 kbps for 1080p at 30 fps, about 12,000 for 1080p at 60 fps, 24,000 for 1440p at 60 fps and 35,000 for 4K at 60 fps. Your upload speed should be about 1.5× the picture bitrate.'),

      el('h3', null, 'Recording'),
      el('div', { class: 'field' }, el('span', null, 'Save recordings to'), el('div', { class: 'row' }, el('input', { type: 'text', class: 'grow', value: s.recordDir, readonly: true, id: 'recDir' }),
        el('button', { class: 'btn small', onclick: async () => { const p = await S.pickFolder(); if (p) { s.recordDir = p; $('#recDir').value = p; saveSettings(); } } }, 'Change…'),
        el('button', { class: 'btn small', onclick: () => S.openFolder(s.recordDir) }, 'Open'))),
      el('div', { class: 'grid2' },
        el('div', { class: 'field' }, check(' Also start recording when I press GO LIVE (normally recording starts with START SERVICE)', s.autoRecord, v => { s.autoRecord = v; saveSettings(); }))),
      el('h4', { style: 'margin:6px 0' }, 'Recording quality'),
      qualityBlock('rec'),

      el('h3', null, 'Switching'),
      el('div', { class: 'grid2' },
        el('div', null, slider({ label: 'Frame move speed', min: 0.02, max: 0.5, step: 0.01, value: s.moveSpeed, reset: 0.12, fmt: v => v < 0.08 ? 'slow' : v < 0.2 ? 'medium' : 'fast', onInput: v => { s.moveSpeed = v; engine.moveSpeed = v; saveSettings(); } })),
        el('div', null, check(' Fade to black also fades the audio', s.ftbAudio, v => { s.ftbAudio = v; saveSettings(); }))),

      el('h3', null, 'Interface'),
      el('div', { class: 'field' }, el('span', null, 'Language'),
        el('div', { class: 'row', style: 'gap:10px' },
          select(window.I18N ? window.I18N.languages : [['en', 'English']], s.lang || 'en', v => { s.lang = v; saveSettings(); setLanguage(v); logEvent('SETTINGS', `language ${v}`); }, { translate: 'no' }),
          el('span', { class: 'muted', style: 'font-size:.85em' }, 'The language of the interface. Names you typed stay as they are.'))),
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
      el('div', { class: 'row' }, el('span', null, `Live Studio ${version}`), ffv, el('span', { class: 'grow' }), updStatus,
        el('button', { class: 'btn small', onclick: async () => {
          rt.upd = { status: 'checking' }; updRender();
          const r = await S.checkUpdates();
          if (r.status === 'dev') rt.upd = { status: 'note', message: 'Updates work in the installed app.' };
          else if (r.status === 'error') rt.upd = { status: 'error', message: r.message };
          updRender();
        } }, 'Check for updates')),
      el('div', { class: 'field', style: 'margin-top:8px' }, el('span', null, 'Updates'),
        select([['ask', 'Tell me about a new version — I decide when to install it'], ['off', 'Never look by itself — only when I press “Check for updates”'], ['auto', 'Automatic — download and install by itself']], s.updates || 'ask', v => {
          s.updates = v; saveSettings(); logEvent('SETTINGS', `updates: ${v}`);
          toast(v === 'auto' ? 'Updates: automatic.' : v === 'off' ? 'Updates: only when you press “Check for updates”.' : 'Updates: you will be told about a new version; nothing installs until you choose.', 'ok');
        }))
    );
    openModal('Settings', body);
    updRender();
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
  const installNow = () => { if (rt.live || rt.rec) return toast('Finish streaming/recording first, then restart to update.', 'error'); S.installUpdate(); };
  // a new version was found and the user chose to get it (Updates: ask / off)
  const downloadNow = async () => {
    if (rt.live || rt.rec) return toast('Finish streaming/recording first, then download the update.', 'error');
    const r = S.downloadUpdate ? await S.downloadUpdate() : { status: 'dev' };
    if (r && r.status === 'error') toast(`The update could not be downloaded: ${r.message}`, 'error');
  };
  // the same status is shown in the top bar and beside "Check for updates" in Settings
  function updRender() {
    const n = $('#updStatus'), u = rt.upd;
    if (!n) return;
    n.innerHTML = ''; n.className = 'muted';
    if (!u) return;
    if (u.status === 'checking') n.textContent = 'Checking for updates…';
    else if (u.status === 'current') { n.textContent = '✓ You have the newest version.'; n.className = 'status-ok'; }
    else if (u.status === 'available') { n.append(`Update ${u.version || ''} is available. `, el('button', { class: 'btn small primary', onclick: downloadNow }, 'Download & install')); }
    else if (u.status === 'downloading') n.textContent = `Update ${u.version || ''} found — downloading${u.percent !== undefined ? ` ${u.percent}%` : '…'}`;
    else if (u.status === 'ready') { n.className = 'status-ok'; n.append(`✓ Update ${u.version || ''} is downloaded. `, el('button', { class: 'btn small primary', onclick: installNow }, 'Restart & update now')); }
    else if (u.status === 'error') { n.textContent = `Update check failed: ${u.message}`; n.className = 'status-bad'; }
    else if (u.message) n.textContent = u.message;
  }
  S.onUpdate(u => {
    const bar = $('#updateBar');
    rt.upd = Object.assign({}, u.status === 'downloading' && rt.upd && rt.upd.status === 'downloading' ? rt.upd : null, u);
    if (u.status === 'ready') {
      bar.innerHTML = '';
      bar.append(el('span', null, `Update ${u.version} is ready.`), el('button', { class: 'btn small primary', onclick: installNow }, 'Restart & update'),
        settings.updates === 'auto' ? el('span', { class: 'muted' }, 'It will also install automatically next time you close the app.') : el('button', { class: 'btn small', onclick: () => bar.classList.add('hidden') }, 'Later'));
      bar.classList.remove('hidden');
    } else if (u.status === 'available') {
      bar.innerHTML = '';
      bar.append(el('span', null, `Update ${u.version} is available.`), el('button', { class: 'btn small primary', onclick: downloadNow }, 'Download & install'), el('button', { class: 'btn small', onclick: () => bar.classList.add('hidden') }, 'Later'));
      bar.classList.remove('hidden');
    } else if (u.status === 'downloading') {
      bar.innerHTML = ''; bar.append(el('span', null, `Downloading update ${rt.upd.version || ''}… ${rt.upd.percent !== undefined ? rt.upd.percent + '%' : ''}`)); bar.classList.remove('hidden');
    } else if (u.status === 'error' && !bar.querySelector('button')) bar.classList.add('hidden');
    updRender();
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
    if (!show.firstRunDone) { await firstRun(); await S.saveShow(show); await S.saveSettings(settings); }
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
    if (settings.output.engine === 'native') await natStart();
    vstSync().catch(e => logEvent('PLUGINS', 'could not start: ' + e.message));
    await Promise.all([
      ...show.cameras.map(c => openCamera(c)),
      ...show.files.map(f => loadFile(f)),
      ...show.webs.map(w => openWeb(w)),
      (async () => { for (const p2 of show.pics) if (p2.on) rt.webManual.add(p2.id); })()
    ]);
    // sound cards after the cameras: a capture card can refuse audio while its video is still starting
    await refreshDevices(); resolveDevices();
    applyOutput(true);
    applyPlayback(true);
    await Promise.all(show.audio.inputs.map(a => openAudioInput(a, true)));
    refreshAll();
    if (engine.programId === 'shot_hold') refreshOnAir(getShot('shot_hold')); // music before the service starts with the holding slide
    updatePfl();
    setTimeout(resetFrameStats, 8000); // starting up (opening cards, loading videos) is not counted as dropped frames
  }

  applyUI();
  await refreshDevices();
  engine.start();
  requestAnimationFrame(tickMeters);
  await bootShow();
  booting = false; dirty.show = dirty.settings = false; updateSaveBtn();
  renderHeader();
  checkWake();
  if (S.pcStats) { const poll = () => S.pcStats().then(p2 => { rt.pc = p2; }).catch(() => {}); poll(); setInterval(poll, 3000); }
  setTimeout(resetFrameStats, 4000); // don't count the start-up hiccups
  ytInit().catch(e => console.warn('youtube', e));
  /* ================= service log =================
     A plain text file for every session in Documents\Live Studio\Logs, to send for troubleshooting:
     a status line every second while live / recording / in a service (every 10 s otherwise), every event, and a
     summary every 10 minutes. Lines starting with "!" had a problem in that second. F9 adds a mark ("I saw a glitch"). */
  function startServiceLog() {
    if (!LOG.on) return;
    const o = settings.output, nameOf = id => { const sh = id && getShot(id); return sh ? sh.name : (id || '—'); };
    const camName = id => { const c = show.cameras.find(x => x.id === id); return c ? c.name : id; };
    S.version().then(v => S.ffmpegVersion().then(fv => logEvent('START', `Live Studio ${v} · FFmpeg ${fv || '?'} · output ${o.width}×${o.height} at ${o.fps} fps · encoder ${o.encoder} · stream ${o.bitrate} kbps / audio ${o.audioBitrate || 160} · recording ${o.recordBitrate} kbps · picture engine ${o.engine === 'native' ? 'NATIVE (OBS-style)' : 'classic'} · screen ${screen.width}×${screen.height} @${devicePixelRatio}×`)).catch(() => {})).catch(() => {});
    for (const c of show.cameras) { const st = rt.camStatus.get(c.id) || {}; logEvent('CAMERA', `${c.name}: ${c.deviceLabel || 'device'} · wanted ${c.res || 1080}p ${c.fps || 'auto'} · ${st.text || ''} · ${engine.sources.get(c.id) && engine.sources.get(c.id).sync ? 'frame sync on' : 'frame sync off (screen-refresh timing)'}`); }
    for (const a of show.audio.inputs) logEvent('AUDIO', `input ${a.name || a.id}: ${a.deviceLabel || a.label || ''}`);
    logEvent('AUDIO', `headphones: ${settings.monitorOut && settings.monitorOut.label || 'Windows default'} · program playback: ${settings.playbackOut && settings.playbackOut.label || 'off'} · limiter ${show.audio.master.limiter ? 'on' : 'off'} · compressor ${show.audio.master.dyn && show.audio.master.dyn.comp && show.audio.master.dyn.comp.on ? 'on' : 'off'} · plug-ins: ${vstIns().map(x => x.name + (x.bypass ? ' (bypassed)' : '')).join(' → ') || 'none'}${vstIns().length ? ` (${vstMs()} ms)` : ''}`);
    // the screen's refresh rate (the program used to follow it; it matters for smooth video)
    { const ts = []; const f = t => { ts.push(t); if (ts.length < 301) requestAnimationFrame(f); else {
        const d = ts.slice(1).map((x, i) => x - ts[i]), med = [...d].sort((a, b) => a - b)[150];
        let n = 0, sumT = 0; for (const x of d) { const k = Math.round(x / med); if (k >= 1 && k <= 3) { n += k; sumT += x; } }
        const hz = 1000 * n / sumT; rt.screenHz = hz;
        logEvent('DISPLAY', `screen refresh ${hz.toFixed(3)} Hz${hz < engine.fps - 0.02 ? ` — LOWER than the output ${engine.fps} fps: set the screen to 60 Hz in Windows display settings` : ''}`);
      } }; requestAnimationFrame(f); }
    setTimeout(() => { if (rt.pc) logEvent('PC', `${(rt.pc.cpuName || '').trim()} · ${rt.pc.cores} threads · ${rt.pc.gpuName || 'GPU ?'}`); }, 4000);

    // events: what changed, checked 10 times a second
    const last = { prog: null, pv: null, live: false, rec: false, recon: false, service: null, black: 0, webs: new Map(), labels: new Map() };
    setInterval(() => {
      const prog = engine.trans ? engine.trans.to : engine.programId;
      if (prog !== last.prog) { logEvent('PROGRAM', `${nameOf(prog)}${engine.trans ? ` (fade ${engine.trans.dur} ms)` : ' (cut)'}`); last.prog = prog; }
      if (engine.previewId !== last.pv) { logEvent('PREVIEW', nameOf(engine.previewId)); last.pv = engine.previewId; }
      if (!!rt.live !== last.live) { logEvent('LIVE', rt.live ? 'stream started' : 'stream ended'); last.live = !!rt.live; }
      if (!!rt.reconnecting !== last.recon) { logEvent('LIVE', rt.reconnecting ? 'reconnecting…' : 'connected'); last.recon = !!rt.reconnecting; }
      if (!!rt.rec !== last.rec) { logEvent('REC', rt.rec ? 'recording started' : 'recording stopped'); last.rec = !!rt.rec; }
      if (rt.service !== last.service) { logEvent('SERVICE', String(rt.service)); last.service = rt.service; }
      if (engine.black.to !== last.black) { logEvent('BLACK', engine.black.to ? 'fade to black' : 'back from black'); last.black = engine.black.to; }
      for (const [id, w] of engine.webs) { const on = w.target > 0; if (last.webs.get(id) !== on) { if (last.webs.has(id) || on) { const x = show.webs.find(q => q.id === id) || show.pics.find(q => q.id === id); logEvent('GRAPHIC', `${x ? x.name || x.url || id : id} ${on ? 'on' : 'off'}`); } last.webs.set(id, on); } }
      for (const [id, L] of engine.labels) { const on = L.target > 0; if (last.labels.get(id) !== on) { if (last.labels.has(id) || on) logEvent('CAPTION', `${(L.data && (L.data.title || L.data.text)) || id} ${on ? 'shown' : 'hidden'}`); last.labels.set(id, on); } }
    }, 100);
    document.addEventListener('visibilitychange', () => logEvent('WINDOW', document.hidden ? 'hidden / minimised' : 'visible'));
    window.addEventListener('blur', () => logEvent('WINDOW', 'another program was clicked'));
    window.addEventListener('focus', () => logEvent('WINDOW', 'Live Studio clicked again'));
    window.addEventListener('error', e => logEvent('ERROR', `${e.message} @ ${(e.filename || '').split('/').pop()}:${e.lineno}`));
    window.addEventListener('unhandledrejection', e => logEvent('ERROR', `unhandled: ${e.reason && (e.reason.message || e.reason)}`));
    window.addEventListener('beforeunload', () => { logEvent('CLOSE', 'Live Studio closing'); logFlush(); });

    // status line every second (every 10 s when nothing is running)
    const prev = { missed: engine.stats.missed, rep: 0, skip: 0, ld: 0, lr: 0, rd: 0, rr: 0, late: new Map(), at: 0, liveId: null, recId: null };
    const sum = { start: Date.now(), missed: 0, rep: 0, skip: 0, camLate: 0, dup: 0, drop: 0, busy: 0, busyMax: 0, worstGap: 0, cpuT: 0, gpuT: 0, cpu: 0, bad: 0, cpuSum: 0, cpuN: 0, parts: {}, natRep: 0, natSkip: 0, natLate: 0, natGap: 0, natMix: 0 };
    let n = 0, decodeSeen = null;
    setInterval(() => {
      n++;
      const dm = rt.pc && rt.pc.decode && rt.pc.decode.mode;
      if (dm && dm !== 'checking' && dm !== decodeSeen) { decodeSeen = dm; logEvent('DECODE', `encoders decode the picture on the ${DECODE_WORDS[dm] || dm}${rt.pc.decode.tried ? ` · tried: ${rt.pc.decode.tried.join('; ')}` : ''}${rt.pc.decode.note ? ` · ${rt.pc.decode.note}` : ''}`); }
      const st = engine.stats, active = rt.live || rt.rec || (rt.service && rt.service !== 'hold');
      const busy = rt.longWin || []; rt.longWin = [];
      const cams = engine.cameraStats(true);
      if (!active && n % 10) return;
      const flags = [];
      const missed = Math.max(0, st.missed - prev.missed); prev.missed = st.missed; // (counters can be reset in the frame monitor)
      const rep = Math.max(0, (st.camRepeat || 0) - prev.rep), skip = Math.max(0, (st.camSkip || 0) - prev.skip); prev.rep = st.camRepeat || 0; prev.skip = st.camSkip || 0;
      if (missed > 0) flags.push('miss'); if (rep > 0 || skip > 0) flags.push('cam');
      const cs = engine._clockSrc(), mode = cs && cs.sync ? `sync q${cs.q ? cs.q.length : 0}` : st.locked ? 'cam-lock' : 'refresh';
      let line = `out ${st.fps}fps miss ${missed} draw ${st.renderMs.toFixed(1)}ms ui ${(rt.uiMs || 0).toFixed(1)}ms` + (busy.length ? ` busy ${busy.length}×${Math.round(Math.max(...busy))}ms` : '');
      line += ` | air "${nameOf(engine.trans ? engine.trans.to : engine.programId)}" ${mode} rep ${rep} skip ${skip}`;
      for (const c of cams) {
        const late = Math.max(0, c.late - (prev.late.get(c.id) || 0)); prev.late.set(c.id, c.late);
        if (late > 0) flags.push('camlate');
        line += ` | ${camName(c.id)} ${c.alive ? c.fps.toFixed(2) : 'NO SIGNAL'} gap ${Math.round(c.win)}${late ? ` late ${late}` : ''}`;
        sum.camLate += Math.max(0, late); sum.worstGap = Math.max(sum.worstGap, c.win);
      }
      const L = rt.live && rt.liveStats, R = rt.rec && rt.recStats;
      if (rt.live && rt.live.id !== prev.liveId) { prev.liveId = rt.live.id; prev.ld = 0; prev.lr = 0; }
      if (rt.rec && rt.rec.id !== prev.recId) { prev.recId = rt.rec.id; prev.rd = 0; prev.rr = 0; }
      if (L) {
        const dd = (L.dup || 0) - prev.ld, dr = (L.drop || 0) - prev.lr; prev.ld = L.dup || 0; prev.lr = L.drop || 0;
        if ((dd > 0 || dr > 0) && !rt.live.conv) flags.push('yt'); if (L.speed && L.speed < 0.97) flags.push('slow');
        if (!rt.live.conv) { sum.dup += Math.max(0, dd); sum.drop += Math.max(0, dr); }
        line += ` | yt ${Math.round(L.fps || 0)}fps ${((L.bitrate || 0) / 1000).toFixed(1)}Mb dup ${dd} drop ${dr} x${(L.speed || 0).toFixed(2)} buf ${Math.round((L.backlog || 0) / 1024)}K`;
      } else if (rt.live) line += ' | yt starting';
      if (R) { const dd = (R.dup || 0) - prev.rd, dr = (R.drop || 0) - prev.rr; prev.rd = R.dup || 0; prev.rr = R.drop || 0; if ((dd > 0 || dr > 0) && !rt.rec.conv) flags.push('rec'); line += ` | rec ${Math.round(R.fps || 0)}fps dup ${dd} drop ${dr} x${(R.speed || 0).toFixed(2)}`; }
      // native engine: what IT did this second (frames made, camera frame shown twice / skipped, sound waiting)
      const E = rt.eng && rt.engStats;
      if (rt.eng && !rt.eng.ready) line += ' | native STARTING';
      else if (E && !E.used) {
        E.used = true;
        const drops = Object.values(E.outputs || {}).reduce((a, o2) => a + (o2.dropped || 0), 0), dropNew = drops - (prev.natDrops || 0); prev.natDrops = drops;
        line += ` | native ${E.ticks}f rep ${E.repeat} skip ${E.skip}${E.late ? ` late ${E.late} (${E.maxLateMs}ms)` : ''}${E.resync ? ' STALL' : ''} mix ${E.renderMs}/${E.renderMaxMs}ms sound ${E.audioMs}ms ${E.audioPpm}ppm${E.audioUnder ? ` GAP ${E.audioUnder}` : ''}${dropNew > 0 ? ` enc-drop ${dropNew}` : ''}`;
        for (const [id, c] of Object.entries(E.cams || {})) line += ` ${camName(id)} ${c.ok ? `${c.fps} (uneven ${c.jitMs ?? '?'}ms${c.late ? `, ${c.late} too late` : ''})` : 'NO SIGNAL'}`;
        for (const [id, v] of Object.entries(E.videos || {})) if (v.playing && v.repeats) line += ` video-rep ${v.repeats}`;
        if (E.repeat || E.skip) flags.push('native'); if (E.late || E.resync) flags.push('late'); if (E.audioUnder) flags.push('sound'); if (dropNew > 0) flags.push('enc');
        sum.natRep += E.repeat; sum.natSkip += E.skip; sum.natLate += E.late; sum.natGap += E.audioUnder || 0; sum.natMix = Math.max(sum.natMix, E.renderMaxMs || 0);
      } else if (rt.eng) line += ' | native (no news)';
      const pc = rt.pc;
      if (pc) {
        line += ` | cpu ${pc.cpu}%${pc.parts ? ` (${cpuPartsShort(pc.parts)})` : ''}${pc.cpuTemp !== null ? ` ${pc.cpuTemp}°` : ''} gpu ${pc.gpu !== null ? pc.gpu + '%' : '?'}${pc.gpuTemp !== null ? ` ${pc.gpuTemp}°` : ''} mem ${pc.mem}%`;
        sum.cpu = Math.max(sum.cpu, pc.cpu || 0); sum.cpuT = Math.max(sum.cpuT, pc.cpuTemp || 0); sum.gpuT = Math.max(sum.gpuT, pc.gpuTemp || 0);
        if (pc.cpu !== null) { sum.cpuSum += pc.cpu; sum.cpuN++; if (pc.parts) for (const [k, v] of Object.entries(pc.parts)) sum.parts[k] = (sum.parts[k] || 0) + v; }
      }
      if (performance.memory) line += ` heap ${Math.round(performance.memory.usedJSHeapSize / 1048576)}M`;
      if (rt.MA) line += ` | ${rt.MA.lufsS <= -60 ? '—' : rt.MA.lufsS.toFixed(1)} LUFS${show.audio.master.auto ? ` auto ${(rt.autoDb || 0) >= 0 ? '+' : ''}${(rt.autoDb || 0).toFixed(1)}${rt.autoState && rt.autoState !== 'off' ? ' ' + rt.autoState : ''}` : ''}`;
      if (busy.length) flags.push('busy');
      sum.missed += Math.max(0, missed); sum.rep += Math.max(0, rep); sum.skip += Math.max(0, skip); sum.busy += busy.length; sum.busyMax = Math.max(sum.busyMax, ...busy, 0); if (flags.length) sum.bad++;
      if (LOG.on) LOG.buf.push(`${logTime()}${flags.length ? ' !' : '  '} ${(rt.live ? 'LIVE ' : '') + (rt.rec ? 'REC ' : '')}${line}${flags.length ? '  [' + flags.join(',') + ']' : ''}`);
      if (Date.now() - sum.start >= 600000) {
        logEvent('SUMMARY', `last 10 min: ${sum.bad} seconds with a problem · frames missed ${sum.missed} · camera repeated ${sum.rep} / skipped ${sum.skip} · camera late ${sum.camLate} (longest gap ${Math.round(sum.worstGap)} ms) · YouTube repeated ${sum.dup} / dropped ${sum.drop} · busy moments ${sum.busy} (longest ${Math.round(sum.busyMax)} ms) · max CPU ${sum.cpu}% ${sum.cpuT}° · max GPU ${sum.gpuT}°`);
        if (sum.cpuN) { const avg = {}; for (const [k, v] of Object.entries(sum.parts)) avg[k] = v / sum.cpuN; logEvent('SUMMARY', `average CPU ${Math.round(sum.cpuSum / sum.cpuN)}% = ${cpuPartsShort(avg) || '?'}`); }
        if (rt.eng) logEvent('SUMMARY', `native engine: camera frame shown twice ${sum.natRep} / skipped ${sum.natSkip} · late frames ${sum.natLate} · sound gaps ${sum.natGap} · slowest mix ${sum.natMix} ms`);
        Object.assign(sum, { start: Date.now(), missed: 0, rep: 0, skip: 0, camLate: 0, dup: 0, drop: 0, busy: 0, busyMax: 0, worstGap: 0, cpuT: 0, gpuT: 0, cpu: 0, bad: 0, cpuSum: 0, cpuN: 0, parts: {}, natRep: 0, natSkip: 0, natLate: 0, natGap: 0, natMix: 0 });
      }
    }, 1000);
  }
  // F9: “I just saw a glitch” — puts a mark in the log so that moment can be found
  function markGlitch() { logEvent('MARK', '>>> F9 pressed: glitch seen on screen / YouTube <<<'); logFlush(); toast('Marked in the log ✓ (F9)', 'ok'); }
  document.addEventListener('keydown', e => { if (e.key === 'F9') { e.preventDefault(); markGlitch(); } });
  startServiceLog();
  window.__live = { Feed, engine, mixer, get show() { return show; }, settings, rt, take, takeShot, setPreview, startService, endService, showHold, toggleLabel, setBlack, toggleWeb, markGlitch, logFlush, switchEngine, NAT, goLive, togglePic, VSTR, vstSync, openDynamics, openSettings, openServiceEdit, openHoldDesigner, openMixer, openShortcuts, openYouTube, setLanguage };
})();
