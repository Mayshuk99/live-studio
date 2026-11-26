"""Tonal-balance check: how much does each module change each octave of a voice?
Uses a voice with realistic high frequencies (breath, sibilants, air up to 12 kHz)."""
import os, subprocess, sys
import numpy as np
from scipy import signal

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from make_reverb import make_ir  # noqa: E402

SR = 48000
exe = sys.argv[1] if len(sys.argv) > 1 else "./dsp_test"


def voice_hf(seconds, seed=5):
    r = np.random.default_rng(seed)
    n = int(seconds * SR)
    out = np.zeros(n)
    sib = np.zeros(n, bool)
    t = 0
    vowels = [(730, 1090, 2440, 3400), (270, 2290, 3010, 3700), (300, 870, 2240, 3300), (530, 1840, 2480, 3500)]
    while t < n:
        dur = int(r.uniform(0.12, 0.35) * SR)
        if t + dur >= n:
            break
        f0 = np.linspace(r.uniform(100, 220), r.uniform(100, 220), dur) * (1 + 0.02 * np.sin(2 * np.pi * 5.5 * np.arange(dur) / SR))
        src = signal.sawtooth(np.cumsum(2 * np.pi * f0 / SR))
        src += 0.15 * r.standard_normal(dur)                            # breath / aspiration
        y = np.zeros(dur)
        for i, fc in enumerate(vowels[r.integers(len(vowels))]):
            b, a = signal.iirpeak(fc, fc / (8 + 3 * i), SR)
            y += signal.lfilter(b, a, src) / (i + 1)
        y += 0.25 * src                                                 # broadband part = "air"
        env = np.sin(np.linspace(0, np.pi, dur)) ** 0.7
        out[t:t + dur] += y * env
        t += dur
        if r.random() < 0.45:                                           # s / sh
            fd = int(r.uniform(0.06, 0.15) * SR)
            if t + fd < n:
                lo = r.choice([2500, 4000])
                b, a = signal.butter(4, [lo / (SR / 2), 11000 / (SR / 2)], "band")
                out[t:t + fd] += 0.5 * signal.lfilter(b, a, r.standard_normal(fd)) * np.hanning(fd)
                sib[t:t + fd] = True
                t += fd
        t += int(r.uniform(0.04, 0.3) * SR)
    voice_hf.sib = sib
    return 0.3 * out / np.max(np.abs(out))


def save(name, x):
    np.asarray(x, np.float32).tofile(name)


OCT = [125, 250, 500, 1000, 2000, 4000, 8000, 12000]


def ltas_change(x, y, act):
    f, X = signal.welch(x[act], SR, nperseg=4096)
    _, Y = signal.welch(y[act], SR, nperseg=4096)
    res = []
    for fc in OCT:
        m = (f >= fc / np.sqrt(2)) & (f < min(fc * np.sqrt(2), 20000))
        res.append(10 * np.log10(Y[m].sum() / X[m].sum()))
    return res


def run(inp, fb, nr, rv, room):
    env = dict(os.environ, DFB_ROOM_AMT=str(room))
    subprocess.run([exe, "open", inp, "o.f32", str(fb), str(nr), str(rv)], check=True, capture_output=True, env=env)
    return np.fromfile("o.f32", np.float32).astype(np.float64)


if __name__ == "__main__":
    v = voice_hf(20)
    n = len(v)
    rng = np.random.default_rng(1)
    hiss = rng.standard_normal(n)
    b, a = signal.butter(1, 2000 / (SR / 2))
    hiss = 0.5 * hiss + signal.lfilter(b, a, hiss)
    hiss *= 10 ** (-62 / 20) / np.sqrt(np.mean(hiss ** 2))           # mic self-noise ~ -62 dBFS
    e_ir, l_ir = make_ir(1.2, 3.0, 21)
    room = v + signal.fftconvolve(v, e_ir)[:n] + signal.fftconvolve(v, l_ir)[:n]
    room *= 0.5 / np.max(np.abs(room))
    sets = {"dry voice": v, "voice + mic hiss": v + hiss, "voice in hall": room + hiss}
    env = np.abs(signal.lfilter(np.ones(960) / 960, 1, np.abs(v)))
    act = (env > env.max() * 0.03)
    act[: 3 * SR] = False
    sib = voice_hf.sib.copy(); sib[: 3 * SR] = False
    # first 25 ms of every sibilant = the onset
    on = np.zeros(n, bool)
    starts = np.where(np.diff(sib.astype(int)) == 1)[0]
    for s0 in starts: on[s0:s0 + int(0.025 * SR)] = True

    print("change in dB per octave (speech-active parts), negative = quieter")
    print("signal            module         " + "".join(f"{(str(f//1000)+'k') if f>=1000 else str(f):>7s}" for f in OCT))
    for name, x in sets.items():
        save("hf_in.f32", x)
        for label, args in [("De-Noise 50%", (0, .5, 0, 0)), ("De-Noise 100%", (0, 1, 0, 0)),
                            ("De-Room 50%", (0, 0, 0, .5)), ("De-Room 100%", (0, 0, 0, 1)),
                            ("De-Reverb 50%", (0, 0, .5, 0)), ("De-Reverb 100%", (0, 0, 1, 0)),
                            ("De-Feedback 100%", (1, 0, 0, 0)), ("all 50%", (.5, .5, .5, .5))]:
            y = run("hf_in.f32", *args)
            ch = ltas_change(x, y, act)
            b2, a2 = signal.butter(4, [2500 / (SR / 2), 12000 / (SR / 2)], "band")
            xs, ys = signal.lfilter(b2, a2, x), signal.lfilter(b2, a2, y)
            sib_db = 10 * np.log10(np.sum(ys[sib] ** 2) / np.sum(xs[sib] ** 2))
            on_db = 10 * np.log10(np.sum(ys[on] ** 2) / np.sum(xs[on] ** 2))
            print(f"{name:17s} {label:15s}" + "".join(f"{c:7.1f}" for c in ch) + f"   | s/sh: {sib_db:5.1f}  onset: {on_db:5.1f}")
        print()
