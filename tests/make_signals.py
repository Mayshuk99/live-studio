"""Generate synthetic test signals (48 kHz, float32 raw mono)."""
import numpy as np
from scipy import signal

SR = 48000
rng = np.random.default_rng(7)


def speech_like(seconds, seed=0):
    """Voiced syllables with moving pitch, formants, fricatives and pauses."""
    r = np.random.default_rng(seed)
    n = int(seconds * SR)
    out = np.zeros(n)
    t = 0
    vowels = [(730, 1090, 2440), (270, 2290, 3010), (300, 870, 2240), (530, 1840, 2480), (640, 1190, 2390)]
    while t < n:
        dur = int(r.uniform(0.12, 0.35) * SR)
        if t + dur >= n:
            break
        f0_0, f0_1 = r.uniform(100, 220), r.uniform(100, 220)
        f0 = np.linspace(f0_0, f0_1, dur) * (1 + 0.02 * np.sin(2 * np.pi * 5.5 * np.arange(dur) / SR))
        f0 *= 1 + 0.004 * r.standard_normal(dur)
        phase = np.cumsum(2 * np.pi * f0 / SR)
        src = signal.sawtooth(phase) + 0.05 * r.standard_normal(dur)
        F = vowels[r.integers(len(vowels))]
        y = np.zeros(dur)
        for i, fc in enumerate(F):
            b, a = signal.iirpeak(fc, fc / (60 + 20 * i), SR)
            y += signal.lfilter(b, a, src) * (1.0 / (i + 1))
        env = np.sin(np.linspace(0, np.pi, dur)) ** 0.7
        out[t:t + dur] += y * env
        t += dur
        if r.random() < 0.3:  # fricative
            fd = int(r.uniform(0.05, 0.12) * SR)
            if t + fd < n:
                b, a = signal.butter(4, 3500 / (SR / 2), 'high')
                out[t:t + fd] += 0.3 * signal.lfilter(b, a, r.standard_normal(fd)) * np.hanning(fd)
                t += fd
        t += int(r.uniform(0.03, 0.4) * SR)  # pause
    return 0.25 * out / np.max(np.abs(out))


def music_like(seconds):
    """Sustained chords with harmonics and slight vibrato (should NOT be notched)."""
    n = int(seconds * SR)
    tt = np.arange(n) / SR
    out = np.zeros(n)
    notes = [220, 277.2, 329.6, 440, 196, 246.9, 293.7, 392]
    for idx in range(int(seconds / 2)):
        s, e = idx * 2 * SR, (idx + 1) * 2 * SR
        chord = notes[(idx % 2) * 4:(idx % 2) * 4 + 4]
        seg = np.zeros(e - s)
        ts = tt[:e - s]
        for f in chord:
            vib = 1 + 0.003 * np.sin(2 * np.pi * 5 * ts)
            for h in range(1, 8):
                seg += (0.6 ** h) * np.sin(2 * np.pi * f * h * np.cumsum(vib) / SR)
        seg *= np.minimum(1, ts / 0.05) * np.exp(-ts * 0.4)
        out[s:e] += seg
    return 0.25 * out / np.max(np.abs(out))


def room_ir(t60=0.4, delay_ms=8.0, length_s=0.12, seed=3):
    r = np.random.default_rng(seed)
    d = int(delay_ms * 1e-3 * SR)
    L = int(length_s * SR)
    tail = r.standard_normal(L) * np.exp(-6.9 * np.arange(L) / (t60 * SR))
    tail[0] += 4.0  # direct path
    b, a = signal.butter(2, [150 / (SR / 2), 8000 / (SR / 2)], 'band')
    tail = signal.lfilter(b, a, tail)
    ir = np.concatenate([np.zeros(d), tail])
    return ir


def reverb_ir(t60=1.0, length_s=1.5, seed=4):
    r = np.random.default_rng(seed)
    L = int(length_s * SR)
    tt = np.arange(L) / SR
    tail = r.standard_normal(L) * np.exp(-6.9 * tt / t60)
    tail[: int(0.005 * SR)] = 0
    ir = 0.35 * tail / np.sqrt(np.sum(tail ** 2))
    ir[0] = 1.0
    return ir


def save(name, x):
    np.asarray(x, dtype=np.float32).tofile(name)


if __name__ == "__main__":
    speech = speech_like(20, seed=1)
    music = music_like(20)
    save("speech.f32", speech)
    save("music.f32", music)

    # feedback loop room + gain so that the loop gain peaks at +3 dB
    ir = room_ir()
    H = np.abs(np.fft.rfft(ir, 1 << 16))
    f = np.fft.rfftfreq(1 << 16, 1 / SR)
    gain = 1.41 / H.max()
    above = f[H * gain > 1.0]
    print(f"loop gain {gain:.4f}; frequencies above unity: {len(above)} bins, e.g. {above[:5].round(1)} ... peak {f[H.argmax()]:.1f} Hz")
    save("room_ir.f32", ir)
    with open("loop_gain.txt", "w") as fh:
        fh.write(f"{gain}\n{f[H.argmax()]}\n")

    # noisy speech: pink-ish noise + hum, SNR ~ 10 dB
    n = len(speech)
    wn = rng.standard_normal(n)
    b, a = signal.butter(1, 800 / (SR / 2))
    noise = signal.lfilter(b, a, wn) * 0.6 + 0.4 * wn
    tt = np.arange(n) / SR
    noise += 3 * (np.sin(2 * np.pi * 60 * tt) + 0.5 * np.sin(2 * np.pi * 180 * tt))
    ps = np.mean(speech[np.abs(speech) > 1e-3] ** 2)
    noise *= np.sqrt(ps / 10 ** (10 / 10) / np.mean(noise ** 2))
    save("noisy.f32", speech + noise)
    save("noise_only.f32", noise)
    np.save("speech_mask.npy", np.abs(signal.lfilter(np.ones(480) / 480, 1, np.abs(speech))) > 0.003)

    # reverberant speech
    rir = reverb_ir()
    wet = signal.fftconvolve(speech, rir)[:n]
    save("reverb.f32", wet)
