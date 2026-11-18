/* Live Studio — audio mixer
 * Mic / line inputs (e.g. SSL 2, SSL 2+, SSL 12), camera audio and video-file audio,
 * mixed into one stereo bus that goes to the stream and recording.
 */
(function () {
  'use strict';

  const dbToGain = db => (db <= -60 ? 0 : Math.pow(10, db / 20));

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
      this.limiterOn = null;
      this.setLimiter(true);
      this.dest = ctx.createMediaStreamDestination();
      this.dest.channelCount = 2;
      this.masterOut.connect(this.dest);
      this.monitor = ctx.createGain();
      this.monitor.gain.value = 0;
      this.masterOut.connect(this.monitor);
      this.monitor.connect(ctx.destination);
      // master meters (L / R)
      const split = ctx.createChannelSplitter(2);
      this.masterOut.connect(split);
      this.mL = ctx.createAnalyser(); this.mR = ctx.createAnalyser();
      this.mL.fftSize = this.mR.fftSize = 1024;
      split.connect(this.mL, 0); split.connect(this.mR, 1);

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
      if (this.limiterOn === on) return;
      try { this.masterFader.disconnect(); } catch (e) { /* first run */ }
      try { this.limiter.disconnect(); } catch (e) { /* first run */ }
      if (on) { this.masterFader.connect(this.limiter); this.limiter.connect(this.masterOut); }
      else this.masterFader.connect(this.masterOut);
      this.limiterOn = on;
    }
    setMaster({ gain = 0, limiter = true, monitor = false, monitorGain = 0 }) {
      this.masterFader.gain.setTargetAtTime(dbToGain(gain), this.ctx.currentTime, 0.02);
      this.setLimiter(limiter);
      this.monitor.gain.setTargetAtTime(monitor ? dbToGain(monitorGain) : 0, this.ctx.currentTime, 0.02);
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
      input.connect(s.delay); s.delay.connect(s.lowcut); s.lowcut.connect(s.comp); s.comp.connect(s.fader);
      s.fader.connect(s.pan); s.pan.connect(s.mute); s.mute.connect(this.masterIn);
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
      try { s.mute.disconnect(); s.input.disconnect(); } catch (e) { /* ignore */ }
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
        this.mediaEls.set(sourceId, { node, gain });
      } catch (e) { console.warn('media audio', e); }
    }
    detachMedia(sourceId) {
      const m = this.mediaEls.get(sourceId);
      if (!m) return;
      try { m.gain.disconnect(); m.node.disconnect(); } catch (e) { /* ignore */ }
      this.mediaEls.delete(sourceId);
    }
    setMediaActive(sourceId, on, ms = 300) {
      const m = this.mediaEls.get(sourceId);
      if (!m) return;
      const g = m.gain.gain, t = this.ctx.currentTime;
      g.cancelScheduledValues(t);
      g.setValueAtTime(g.value, t);
      g.linearRampToValueAtTime(on ? 1 : 0, t + Math.max(0.01, ms / 1000));
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

  window.LiveAudio = { Mixer, dbToGain };
})();
