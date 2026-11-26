"""Reverb test rooms: direct + early reflections + frequency-dependent diffuse tail.
Writes for each room: rev_<name>.f32 (wet mix) and its parts direct/early/late."""
import numpy as np
from scipy import signal

SR = 48000
speech = np.fromfile("speech.f32", dtype=np.float32).astype(np.float64)
n = len(speech)

ROOMS = {            # name: (T60 at 1 kHz [s], direct-to-reverberant ratio [dB])
    "close": (1.2, 12.0),
    "small": (0.6, 3.0),
    "hall": (1.2, 0.0),
    "church": (2.2, -4.0),
}


def make_ir(t60, drr_db, seed):
    r = np.random.default_rng(seed)
    L = int(min(3.5, 1.6 * t60) * SR)
    t = np.arange(L) / SR
    # diffuse tail in octave bands, longer T60 at low frequencies
    tail = np.zeros(L)
    for fc, k in [(125, 1.4), (250, 1.25), (500, 1.1), (1000, 1.0), (2000, 0.9), (4000, 0.75), (8000, 0.6)]:
        lo, hi = fc / np.sqrt(2), min(fc * np.sqrt(2), SR / 2 * 0.95)
        b, a = signal.butter(2, [lo / (SR / 2), hi / (SR / 2)], "band")
        tail += signal.lfilter(b, a, r.standard_normal(L)) * np.exp(-6.9 * t / (t60 * k))
    onset = int(0.012 * SR)
    tail[:onset] = 0
    tail[onset:onset + 480] *= np.linspace(0, 1, 480)
    # discrete early reflections 5..45 ms
    early = np.zeros(L)
    for _ in range(10):
        d = int(r.uniform(0.005, 0.045) * SR)
        early[d] += r.uniform(0.25, 0.55) * r.choice([-1, 1])
    rev = early + tail
    split = int(0.05 * SR)
    e_part, l_part = rev.copy(), rev.copy()
    e_part[split:] = 0
    l_part[:split] = 0
    # scale reverb to requested DRR
    g = np.sqrt(1.0 / np.sum(rev ** 2) / 10 ** (drr_db / 10))
    return g * e_part, g * l_part


if __name__ == "__main__":
    for i, (name, (t60, drr)) in enumerate(ROOMS.items()):
        e_ir, l_ir = make_ir(t60, drr, 10 + i)
        early = signal.fftconvolve(speech, e_ir)[:n]
        late = signal.fftconvolve(speech, l_ir)[:n]
        wet = speech + early + late
        peak = np.max(np.abs(wet))
        for part, x in [("mix", wet), ("direct", speech), ("early", early), ("late", late)]:
            (x / peak * 0.5).astype(np.float32).tofile(f"rev_{name}_{part}.f32")
        print(f"{name}: T60 {t60} s, DRR {drr} dB, late/direct energy {10*np.log10(np.sum(late**2)/np.sum(speech**2)):.1f} dB")
