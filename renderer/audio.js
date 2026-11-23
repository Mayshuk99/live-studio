/* Live Studio — audio mixer
 * Mic / line inputs (e.g. SSL 2, SSL 2+, SSL 12), camera audio and video-file audio,
 * mixed into one stereo bus that goes to the stream and recording.
 */
(function () {
  'use strict';

  const dbToGain = db => (db <= -60 ? 0 : Math.pow(10, db / 20));

  // compressor curve: output level (dB) for an input peak level x (dB)
  function compCurve(x, T, R, K) {
    if (x <= T) return x;
    if (K > 0 && x <= T + K) return x + (1 / R - 1) * (x - T) * (x - T) / (2 * K);
    return T + K * (1 + 1 / R) / 2 + (x - T - K) / R;
  }
  class Mixer {
    constructor() {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC({ latencyHint: 'interactive', sampleRate: 48000 });
      const ctx = this.ctx;
      this.masterIn = ctx.createGain();
      this.masterFader = ctx.createGain();
      this.limiter = ctx.createDynamicsCompressor();
      Object.assign(this.limiter, {});
      this.limiter.threshold.value = -3;
      this.limiter.knee.value = 0;
      this.limiter.ratio.value = 20;
      this.limiter.attack.value = 0.002;
      this.limiter.release.value = 0.12;
      this.masterOut = ctx.createGain(); // fade-to-black for audio
      this.masterIn.connect(this.masterFader);
      // YouTube-safe output: auto-level stage, limiter, then a hard ceiling at -1 dBFS so the stream can never clip
      this.auto = ctx.createGain();
      this.ceil = ctx.createWaveShaper();
      this.ceil.oversample = 'none';
      // compressor (with your own make-up gain) and limiter gain correction — see setDynamics
      this.comp = ctx.createDynamicsCompressor();
      this.makeup = ctx.createGain();
      this.comp.connect(this.makeup);
      this.limGain = ctx.createGain();
      this.limDrive = ctx.createGain();          // limiter threshold: how far the level is pushed up into the ceiling (like an L2)
      this.limDrive.connect(this.limiter);
      // level going into the limiter (for its input meters, next to the Threshold fader)
      this.limIn = ctx.createGain();
      const ls = ctx.createChannelSplitter(2);
      this.limIn.connect(ls);
      this.lInL = ctx.createAnalyser(); this.lInR = ctx.createAnalyser(); this.lInL.fftSize = this.lInR.fftSize = 1024;
      ls.connect(this.lInL, 0); ls.connect(this.lInR, 1);
      this.limiter.connect(this.limGain);
      this.limGain.connect(this.ceil);
      // level going into the dynamics (for the In meter)
      this.dynSplit = ctx.createChannelSplitter(2);
      this.dInL = ctx.createAnalyser(); this.dInR = ctx.createAnalyser(); this.dInL.fftSize = this.dInR.fftSize = 1024;
      this.dynSplit.connect(this.dInL, 0); this.dynSplit.connect(this.dInR, 1);
      this._db = new Float32Array(1024);
      this.masterFader.connect(this.auto);
      this.ceil.connect(this.masterOut);
      this.compOn = false; this.limiterOn = true;
      this.l2 = null; this._l2gr = 0;
      this.setDynamics({});
      this._wire();
      // the L2-style look-ahead limiter runs on the audio thread; until it has loaded (or if it cannot load) the
      // browser's own limiter above is used
      this.l2Ready = ctx.audioWorklet ? ctx.audioWorklet.addModule('l2-worklet.js').then(() => {
        const n = new AudioWorkletNode(ctx, 'l2-limiter', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers', processorOptions: this._l2p || {} });
        n.port.onmessage = e => { this._l2gr = e.data.gr; this._l2pk = Math.max(this._l2pk || 0, e.data.gr); this._l2at = performance.now(); };
        n.connect(this.masterOut);
        this.l2 = n;
        if (this._l2p) n.port.postMessage(this._l2p);
        this._arc({ arc: false, release: 100 });
        this._wire();
        return true;
      }).catch(e => { console.warn('L2 limiter not available — using the built-in limiter', e); return false; }) : Promise.resolve(false);
      this.dest = ctx.createMediaStreamDestination();
      this.dest.channelCount = 2;
      this.masterOut.connect(this.dest);
      // headphone / speaker monitoring, with an optional mono check
      this.monitor = ctx.createGain();
      this.monitor.gain.value = 0;
      this.monoSum = ctx.createGain(); this.monoSum.channelCount = 1; this.monoSum.channelCountMode = 'explicit'; this.monoSum.channelInterpretation = 'speakers';
      this.monoOn = false;
      this.masterOut.connect(this.monitor);
      this.monitor.connect(ctx.destination);
      // program playback: the finished program sound sent to a second device all the time (like Wirecast's
      // “Audio Playback”, e.g. the SSL 2 feeding a loudness meter), separate from the headphones above
      this.playGain = ctx.createGain(); this.playGain.gain.value = 0;
      this.playDest = ctx.createMediaStreamDestination(); this.playDest.channelCount = 2;
      this.masterOut.connect(this.playGain); this.playGain.connect(this.playDest);
      this.playEl = null; this.playDev = null;
      // master meters (L / R), plus K-weighted copies for loudness (LUFS)
      const split = ctx.createChannelSplitter(2);
      this.masterOut.connect(split);
      this.mL = ctx.createAnalyser(); this.mR = ctx.createAnalyser();
      this.mL.fftSize = this.mR.fftSize = 2048;
      split.connect(this.mL, 0); split.connect(this.mR, 1);
      const kw = ch => {
        const shelf = ctx.createBiquadFilter(); shelf.type = 'highshelf'; shelf.frequency.value = 1681; shelf.gain.value = 4;
        const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 38; hp.Q.value = 0.5;
        const an = ctx.createAnalyser(); an.fftSize = 2048;
        split.connect(shelf, ch); shelf.connect(hp); hp.connect(an);
        return an;
      };
      this.kL = kw(0); this.kR = kw(1);
      this._bL = new Float32Array(2048); this._bR = new Float32Array(2048); this._kL = new Float32Array(2048); this._kR = new Float32Array(2048);
      this._ms = []; // recent loudness blocks for short-term LUFS
      this.hold = { L: -90, R: -90, tL: 0, tR: 0 };
      this.clip = { L: 0, R: 0 };
      this.corr = 1;

      // preview ("listen before showing") bus: what the Preview shot would sound like, with its own meter
      // and its own path to the headphones. It never reaches the stream or the recording.
      this.pfl = ctx.createGain();
      this.pflMedia = ctx.createGain();
      this.pflMedia.connect(this.pfl);
      this.pflMon = ctx.createGain(); this.pflMon.gain.value = 0;
      this.pfl.connect(this.pflMon); this.pflMon.connect(ctx.destination);
      { const sp = ctx.createChannelSplitter(2); this.pfl.connect(sp);
        this.pL = ctx.createAnalyser(); this.pR = ctx.createAnalyser(); this.pL.fftSize = this.pR.fftSize = 2048;
        sp.connect(this.pL, 0); sp.connect(this.pR, 1); }
      this._pb = new Float32Array(2048);
      this.pHold = { L: -90, R: -90, tL: 0, tR: 0 };
      this.pPeak = { L: -90, R: -90 };
      this.listen = 'program'; this._mon = 0;

      // live inputs (capture card, sound desk) go through their own bus so a video shot can play with only its own sound
      this.liveBus = ctx.createGain();
      this.liveBus.connect(this.masterIn);
      this.strips = new Map();
      this.devices = new Map(); // deviceId -> { stream, node, splitter, users }
      this.mediaEls = new Map(); // sourceId -> { node, gain }
      this.media = this._strip('media', this.ctx.createGain(), { gain: 0 });
      this._buf = new Float32Array(1024);
      this.peaks = new Map();
    }

    resume() { if (this.ctx.state !== 'running') return this.ctx.resume(); }
    get suspended() { return this.ctx.state !== 'running'; }
    stream() { return this.dest.stream; }

    setLimiter(on) {
      if (this.limiterOn === !!on && this._wired) return;
      this.limiterOn = !!on;
      this._wire();
    }
    // auto-level → [compressor → make-up] → [limiter → hard ceiling] → master out
    _wire() {
      try { this.auto.disconnect(); } catch (e) { /* */ }
      try { this.makeup.disconnect(); } catch (e) { /* */ }
      try { this.limIn.disconnect(this.limDrive); } catch (e) { /* */ }
      try { this.limIn.disconnect(this.masterOut); } catch (e) { /* */ }
      if (this.l2) try { this.limIn.disconnect(this.l2); } catch (e) { /* */ }
      this.auto.connect(this.dynSplit);
      let last = this.auto;
      if (this.compOn) { last.connect(this.comp); last = this.makeup; }
      last.connect(this.limIn);
      this.limIn.connect(this.limiterOn ? (this.l2 || this.limDrive) : this.masterOut);
      this._wired = true;
    }
    /* master dynamics. Times in ms, levels in dB, knee in dB.
       The browser's compressor adds its own automatic make-up gain (0.6 × the reduction it would apply at full
       level); it is cancelled here so the Out gain you set is exactly what you get, and the limiter adds nothing. */
    setDynamics(d) {
      const c = Object.assign({ on: false, threshold: -24, ratio: 3, attack: 10, release: 150, knee: 2, makeup: 0 }, d && d.comp);
      const l = Object.assign({ ceiling: -1, release: 120, arc: false, bits: 24, dither: 'type1', shaping: 'normal' }, d && d.lim);
      if (l.threshold === undefined) l.threshold = l.ceiling; // threshold = ceiling → no extra level
      const t = this.ctx.currentTime, set = (prm, v) => prm.setTargetAtTime(v, t, 0.01);
      set(this.comp.threshold, c.threshold); set(this.comp.ratio, c.ratio); set(this.comp.knee, c.knee);
      set(this.comp.attack, c.attack / 1000); set(this.comp.release, Math.max(10, c.release) / 1000);
      set(this.makeup.gain, dbToGain(c.makeup + 0.6 * compCurve(0, c.threshold, c.ratio, c.knee)));
      // limiter: level pushed up by (ceiling − threshold), then held under the ceiling
      const lt = l.ceiling - 1;
      set(this.limDrive.gain, dbToGain(Math.max(0, l.ceiling - l.threshold)));
      set(this.limiter.threshold, lt); set(this.limiter.ratio, 20); set(this.limiter.knee, 0);
      set(this.limiter.attack, 0.001); set(this.limiter.release, Math.max(1, l.release) / 1000);
      this._l2p = { drive: dbToGain(Math.max(0, l.ceiling - l.threshold)), ceil: dbToGain(l.ceiling), rel: Math.max(0.01, l.release) / 1000, arc: !!l.arc,
        bits: +l.bits || 24, dither: { none: 0, type1: 1, type2: 2 }[l.dither] ?? 1, shaping: { none: 0, moderate: 1, normal: 2, ultra: 3 }[l.shaping] ?? 2 };
      if (this.l2) this.l2.port.postMessage(this._l2p);
      else this._arc(l);
      set(this.limGain.gain, dbToGain(0.6 * compCurve(0, lt, 20, 0)));
      if (this._ceilDb !== l.ceiling) {
        this._ceilDb = l.ceiling;
        const n = 8193, cv = new Float32Array(n), top = Math.pow(10, l.ceiling / 20), knee = top * 0.93; // only real overs are rounded off
        for (let i = 0; i < n; i++) { const x = i / (n - 1) * 2 - 1, a = Math.abs(x); cv[i] = Math.sign(x) * (a <= knee ? a : knee + (top - knee) * Math.tanh((a - knee) / (top - knee))); }
        this.ceil.curve = cv;
      }
      this.dyn = { comp: c, lim: l };
      if (this.compOn !== !!c.on) { this.compOn = !!c.on; if (this._wired) this._wire(); }
    }
    /* ARC (automatic release, like the L2): when the limiter is working all the time the release is made longer
       (up to 4×) so it does not pump or distort; short peaks still get your Release time */
    _arc(l) {
      this._arcBase = Math.max(1, l.release) / 1000;
      if (l.arc && !this._arcT) {
        this._arcAvg = 0;
        this._arcT = setInterval(() => {
          const r = this.limiterOn ? this.limiter.reduction : 0;       // negative dB
          this._arcAvg = this._arcAvg * 0.96 + r * 0.04;                // about a second of history
          const k = 1 + Math.min(3, Math.max(0, -this._arcAvg) / 2);  // 2 dB of steady limiting → twice as long
          this.limiter.release.setTargetAtTime(this._arcBase * k, this.ctx.currentTime, 0.05);
        }, 50);
      } else if (!l.arc && this._arcT) { clearInterval(this._arcT); this._arcT = null; }
      this.arcOn = !!l.arc;
    }
    // peak level going into the limiter, per channel (dB)
    limInput() {
      const out = [];
      for (const an of [this.lInL, this.lInR]) { an.getFloatTimeDomainData(this._db); let p = 0; for (let i = 0; i < this._db.length; i++) { const v = Math.abs(this._db[i]); if (v > p) p = v; } out.push(p > 1e-6 ? 20 * Math.log10(p) : -90); }
      return out;
    }
    // how much the compressor / limiter are turning the sound down right now (negative dB), cheap enough for every screen update
    grNow() {
      // the deepest reduction since the last call, so short peaks between screen updates are not missed
      const lim = !this.limiterOn ? 0 : this.l2 ? (performance.now() - (this._l2at || 0) < 200 ? -(this._l2pk || 0) : 0) : this.limiter.reduction;
      this._l2pk = 0;
      return { comp: this.compOn ? this.comp.reduction : 0, lim };
    }
    // for the dynamics window: level going in (peak dB) and how much each stage is turning it down
    dynMeters() {
      let p = 0;
      for (const an of [this.dInL, this.dInR]) { an.getFloatTimeDomainData(this._db); for (let i = 0; i < this._db.length; i++) { const v = Math.abs(this._db[i]); if (v > p) p = v; } }
      const lim = !this.limiterOn ? 0 : this.l2 ? (performance.now() - (this._l2at || 0) < 200 ? -this._l2gr : 0) : this.limiter.reduction;
      return { in: p > 1e-6 ? 20 * Math.log10(p) : -90, comp: this.compOn ? this.comp.reduction : 0, lim };
    }
    setAuto(db) { this.auto.gain.setTargetAtTime(Math.pow(10, db / 20), this.ctx.currentTime, 0.3); }
    setMono(on) {
      if (on === this.monoOn) return;
      try { this.masterOut.disconnect(this.monitor); } catch (e) { /* */ }
      try { this.masterOut.disconnect(this.monoSum); this.monoSum.disconnect(); } catch (e) { /* */ }
      if (on) { this.masterOut.connect(this.monoSum); this.monoSum.connect(this.monitor); }
      else this.masterOut.connect(this.monitor);
      this.monoOn = on;
    }
    setMaster({ gain = 0, limiter = true, monitor = false, monitorGain = 0, dyn = null }) {
      this.masterFader.gain.setTargetAtTime(dbToGain(gain), this.ctx.currentTime, 0.02);
      if (dyn) this.setDynamics(dyn);
      this.setLimiter(limiter);
      this._mon = monitor ? dbToGain(monitorGain) : 0; this._monGain = dbToGain(monitorGain);
      this._applyListen();
    }
    /* which sound goes to this computer's headphones / speakers: the programme (when 🎧 is on) or the Preview shot */
    // which sound device the headphone / monitor sound goes to ('' = the Windows default)
    async setOutput(deviceId) {
      if (!this.ctx.setSinkId) throw new Error('Choosing the output is not supported here.');
      await this.ctx.setSinkId(deviceId || '');
    }
    // program playback device: deviceId null = off, '' = the Windows default
    async setPlayback(deviceId, gainDb = 0) {
      const t = this.ctx.currentTime;
      if (deviceId === null || deviceId === undefined) {
        this.playGain.gain.setTargetAtTime(0, t, 0.02);
        if (this.playEl) { this.playEl.pause(); this.playEl.srcObject = null; this.playEl = null; }
        this.playDev = null;
        return;
      }
      if (!this.playEl) {
        const a = new Audio(); a.autoplay = true; a.srcObject = this.playDest.stream; this.playEl = a;
      }
      if (this.playDev !== deviceId) {
        if (!this.playEl.setSinkId) throw new Error('Choosing the output is not supported here.');
        await this.playEl.setSinkId(deviceId);
        this.playDev = deviceId;
      }
      this.playGain.gain.setTargetAtTime(dbToGain(gainDb), t, 0.02);
      try { await this.playEl.play(); } catch (e) { /* starts on the next user action */ }
    }
    setPlaybackLevel(db) { if (this.playDev !== null) this.playGain.gain.setTargetAtTime(dbToGain(db), this.ctx.currentTime, 0.02); }
    setListen(which) { this.listen = which; this._applyListen(); }
    _applyListen() {
      const t = this.ctx.currentTime, pv = this.listen === 'preview';
      this.monitor.gain.setTargetAtTime(pv ? 0 : this._mon, t, 0.02);
      this.pflMon.gain.setTargetAtTime(pv ? (this._monGain || 0.5) : 0, t, 0.02);
    }
    /* what the preview bus contains: the live inputs (or not) plus the video files of the Preview shot */
    setPreviewMix(inputs, media, mediaGainDb, mediaMute) {
      const t = this.ctx.currentTime, lv = typeof inputs === 'number' ? inputs : inputs ? 1 : 0;
      for (const [id, s] of this.strips) if (s.pflSend) s.pflSend.gain.setTargetAtTime(lv, t, 0.02);
      for (const [id, m] of this.mediaEls) if (m.pfl) m.pfl.gain.setTargetAtTime(Array.isArray(media) ? (media.includes(id) ? 1 : 0) : (media[id] || 0), t, 0.02);
      this.pflMedia.gain.setTargetAtTime(mediaMute ? 0 : dbToGain(mediaGainDb || 0), t, 0.02);
    }
    previewAnalysis() {
      const now = performance.now(), out = {};
      for (const [ch, an] of [['L', this.pL], ['R', this.pR]]) {
        an.getFloatTimeDomainData(this._pb);
        let p = 0; for (let i = 0; i < this._pb.length; i++) { const v = Math.abs(this._pb[i]); if (v > p) p = v; }
        const db = p > 1e-6 ? 20 * Math.log10(p) : -90;
        this.pPeak[ch] = Math.max(db, this.pPeak[ch] - 1.2);
        if (db >= this.pHold[ch] || now - this.pHold['t' + ch] > 1500) { this.pHold[ch] = db; this.pHold['t' + ch] = now; }
        out['peak' + ch] = this.pPeak[ch]; out['hold' + ch] = this.pHold[ch]; out['clip' + ch] = db > -1;
      }
      out.silent = out.peakL < -80 && out.peakR < -80;
      return out;
    }
    fadeMaster(on, ms) {
      const g = this.masterOut.gain, t = this.ctx.currentTime;
      g.cancelScheduledValues(t);
      g.setValueAtTime(g.value, t);
      g.linearRampToValueAtTime(on ? 1 : 0, t + ms / 1000);
    }

    /* one processing strip: delay -> low cut -> voice compressor -> fader -> pan -> mute -> master */
    _strip(id, input, cfg) {
      const ctx = this.ctx;
      const s = { id, input };
      s.delay = ctx.createDelay(2);
      s.lowcut = ctx.createBiquadFilter(); s.lowcut.type = 'highpass'; s.lowcut.Q.value = 0.707;
      s.comp = ctx.createDynamicsCompressor();
      s.fader = ctx.createGain();
      s.pan = ctx.createStereoPanner();
      s.mute = ctx.createGain();
      s.meter = ctx.createAnalyser(); s.meter.fftSize = 1024;
      s.raw = ctx.createGain(); input.connect(s.raw); // untouched input, used by the sync test
      input.connect(s.delay); s.delay.connect(s.lowcut); s.lowcut.connect(s.comp); s.comp.connect(s.fader);
      s.fader.connect(s.pan); s.pan.connect(s.mute); s.mute.connect(id === 'media' ? this.masterIn : this.liveBus);
      if (id !== 'media') { s.pflSend = ctx.createGain(); s.mute.connect(s.pflSend); s.pflSend.connect(this.pfl); }
      s.fader.connect(s.meter);
      this.strips.set(id, s);
      this.update(id, cfg);
      return s;
    }
    update(id, cfg) {
      const s = this.strips.get(id);
      if (!s) return;
      const t = this.ctx.currentTime;
      const c = Object.assign({ gain: 0, mute: false, delay: 0, lowcut: false, voice: false, pan: 0 }, cfg);
      s.fader.gain.setTargetAtTime(dbToGain(c.gain), t, 0.015);
      s.mute.gain.setTargetAtTime(c.mute ? 0 : 1, t, 0.01);
      s.delay.delayTime.setTargetAtTime(Math.max(0, Math.min(2000, c.delay)) / 1000, t, 0.01);
      s.lowcut.frequency.setTargetAtTime(c.lowcut ? 90 : 5, t, 0.01);
      s.pan.pan.setTargetAtTime(Math.max(-1, Math.min(1, c.pan)), t, 0.01);
      if (c.voice) {
        s.comp.threshold.value = -22; s.comp.knee.value = 8; s.comp.ratio.value = 3.5;
        s.comp.attack.value = 0.004; s.comp.release.value = 0.22;
      } else {
        s.comp.threshold.value = 0; s.comp.knee.value = 0; s.comp.ratio.value = 1;
      }
    }

    async _device(deviceId, channels) {
      const key = deviceId || 'default';
      let d = this.devices.get(key);
      if (d && d.channels >= channels) { d.users++; return d; }
      if (d) { d.users++; return d; }
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: deviceId ? { exact: deviceId } : undefined,
          echoCancellation: false, noiseSuppression: false, autoGainControl: false,
          channelCount: { ideal: Math.max(2, channels) }, sampleRate: 48000, latency: 0
        }, video: false
      });
      const node = this.ctx.createMediaStreamSource(stream);
      const n = node.channelCount || 2;
      const splitter = this.ctx.createChannelSplitter(Math.max(2, n));
      node.connect(splitter);
      d = { stream, node, splitter, users: 1, channels: Math.max(2, n), key };
      this.devices.set(key, d);
      return d;
    }
    _release(key) {
      const d = this.devices.get(key);
      if (!d) return;
      d.users--;
      if (d.users <= 0) {
        d.stream.getTracks().forEach(t => t.stop());
        try { d.node.disconnect(); } catch (e) { /* ignore */ }
        this.devices.delete(key);
      }
    }

    /* channel: '1'..'8' = one input as mono (centre), 'stereo' = inputs 1+2, 'mix' = 1+2 summed to mono */
    async addInput(cfg) {
      this.removeInput(cfg.id);
      const ch = cfg.channel || '1';
      const need = ch === 'stereo' || ch === 'mix' ? 2 : parseInt(ch, 10);
      const d = await this._device(cfg.deviceId, need);
      const ctx = this.ctx;
      let input;
      if (ch === 'stereo') {
        input = ctx.createChannelMerger(2);
        d.splitter.connect(input, 0, 0);
        d.splitter.connect(input, Math.min(1, d.channels - 1), 1);
      } else if (ch === 'mix') {
        const sum = ctx.createGain(); sum.gain.value = 0.5;
        sum.channelCount = 1; sum.channelCountMode = 'explicit';
        d.splitter.connect(sum, 0); d.splitter.connect(sum, Math.min(1, d.channels - 1));
        input = ctx.createChannelMerger(2);
        sum.connect(input, 0, 0); sum.connect(input, 0, 1);
      } else {
        const idx = Math.min(d.channels - 1, Math.max(0, parseInt(ch, 10) - 1));
        input = ctx.createChannelMerger(2);
        d.splitter.connect(input, idx, 0);
        d.splitter.connect(input, idx, 1);
      }
      const s = this._strip(cfg.id, input, cfg);
      s.deviceKey = d.key;
      s.channels = d.channels;
      return s;
    }
    removeInput(id) {
      const s = this.strips.get(id);
      if (!s || id === 'media') return;
      try { s.mute.disconnect(); s.input.disconnect(); if (s.pflSend) s.pflSend.disconnect(); } catch (e) { /* ignore */ }
      this.strips.delete(id);
      if (s.deviceKey) this._release(s.deviceKey);
    }

    /* video-file audio: each file gets its own gate so only the clip on air is heard */
    attachMedia(sourceId, el) {
      if (this.mediaEls.has(sourceId)) return;
      try {
        const node = this.ctx.createMediaElementSource(el);
        const gain = this.ctx.createGain();
        gain.gain.value = 0;
        node.connect(gain); gain.connect(this.media.input);
        const pfl = this.ctx.createGain(); pfl.gain.value = 0; node.connect(pfl); pfl.connect(this.pflMedia);
        this.mediaEls.set(sourceId, { node, gain, pfl });
      } catch (e) { console.warn('media audio', e); }
    }
    detachMedia(sourceId) {
      const m = this.mediaEls.get(sourceId);
      if (!m) return;
      try { m.gain.disconnect(); if (m.pfl) m.pfl.disconnect(); m.node.disconnect(); } catch (e) { /* ignore */ }
      this.mediaEls.delete(sourceId);
    }
    // live inputs on / off for the shot on air, with a short fade so there is no click
    setLiveInputs(on, ms = 300, level = 1) {
      const g = this.liveBus.gain, t = this.ctx.currentTime;
      g.cancelScheduledValues(t); g.setValueAtTime(g.value, t);
      g.linearRampToValueAtTime(on ? level : 0, t + Math.max(0.03, ms / 1000));
    }
    // a video / music file's volume while it is on air (0 = silent, 1 = as recorded)
    setMediaLevel(sourceId, level, ms = 300) {
      const m = this.mediaEls.get(sourceId);
      if (!m) return;
      const g = m.gain.gain, t = this.ctx.currentTime;
      g.cancelScheduledValues(t);
      g.setValueAtTime(g.value, t);
      g.linearRampToValueAtTime(Math.max(0, level), t + Math.max(0.01, ms / 1000));
    }
    setMediaActive(sourceId, on, ms = 300) {
      const m = this.mediaEls.get(sourceId);
      if (!m) return;
      const g = m.gain.gain, t = this.ctx.currentTime;
      g.cancelScheduledValues(t);
      g.setValueAtTime(g.value, t);
      g.linearRampToValueAtTime(on ? 1 : 0, t + Math.max(0.01, ms / 1000));
    }

    /* everything the master section shows: peak, RMS, peak hold, clip, phase correlation, loudness */
    masterAnalysis() {
      const L = this._bL, R = this._bR, now = performance.now();
      this.mL.getFloatTimeDomainData(L); this.mR.getFloatTimeDomainData(R);
      let pl = 0, pr = 0, sl = 0, sr = 0, slr = 0;
      for (let i = 0; i < L.length; i++) {
        const l = L[i], r = R[i];
        const al = l < 0 ? -l : l, ar = r < 0 ? -r : r;
        if (al > pl) pl = al; if (ar > pr) pr = ar;
        sl += l * l; sr += r * r; slr += l * r;
      }
      const db = v => v > 1e-6 ? 20 * Math.log10(v) : -90;
      const peakL = db(pl), peakR = db(pr);
      const rmsL = db(Math.sqrt(sl / L.length)), rmsR = db(Math.sqrt(sr / R.length));
      for (const [ch, v] of [['L', peakL], ['R', peakR]]) {
        if (v >= this.hold[ch] || now - this.hold['t' + ch] > 1500) { this.hold[ch] = v; this.hold['t' + ch] = now; }
        if (v > -1.15) this.clip[ch] = now; // at the -1 dB ceiling
      }
      const den = Math.sqrt(sl * sr);
      if (den > 1e-9) this.corr += (slr / den - this.corr) * 0.15; // phase: +1 = mono-safe, 0 = wide, -1 = out of phase
      else this.corr += (1 - this.corr) * 0.02;
      // loudness (approximate ITU-R BS.1770, K-weighted)
      const KL = this._kL, KR = this._kR;
      this.kL.getFloatTimeDomainData(KL); this.kR.getFloatTimeDomainData(KR);
      let kl = 0, kr = 0;
      for (let i = 0; i < KL.length; i++) { kl += KL[i] * KL[i]; kr += KR[i] * KR[i]; }
      const ms = (kl + kr) / L.length;
      this._ms.push({ t: now, ms });
      while (this._ms.length && now - this._ms[0].t > 3000) this._ms.shift();
      const avg = (from) => { let a = 0, n = 0; for (const b of this._ms) if (now - b.t <= from) { a += b.ms; n++; } return n ? a / n : 0; };
      const lufs = m => m > 1e-10 ? -0.691 + 10 * Math.log10(m) : -70;
      return {
        peakL, peakR, rmsL, rmsR, holdL: this.hold.L, holdR: this.hold.R,
        clipL: now - this.clip.L < 2000, clipR: now - this.clip.R < 2000,
        corr: this.corr, lufsM: lufs(avg(400)), lufsS: lufs(avg(3000)), L: this._bL, R: this._bR,
        silent: pl < 1e-4 && pr < 1e-4
      };
    }

    _peak(an) {
      an.getFloatTimeDomainData(this._buf);
      let p = 0;
      for (let i = 0; i < this._buf.length; i++) { const v = Math.abs(this._buf[i]); if (v > p) p = v; }
      return p;
    }
    /* returns dBFS peaks with a gentle fall-off for display */
    levels() {
      const out = {};
      const fall = (id, v) => {
        const db = v > 0 ? 20 * Math.log10(v) : -90;
        const prev = this.peaks.get(id);
        const next = prev === undefined ? db : Math.max(db, prev - 1.2);
        this.peaks.set(id, next);
        return next;
      };
      for (const [id, s] of this.strips) out[id] = fall(id, this._peak(s.meter));
      out.__L = fall('__L', this._peak(this.mL));
      out.__R = fall('__R', this._peak(this.mR));
      return out;
    }
  }

  window.LiveAudio = { compCurve, Mixer, dbToGain };
})();
