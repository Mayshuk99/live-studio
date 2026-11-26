"""Shadow-filter evaluation of DE-REVERB on the rooms from make_reverb.py."""
import subprocess, sys
import numpy as np
from scipy import signal

SR = 48000
WARM = 3 * SR
mask = np.load("speech_mask.npy")[WARM:]
exe = sys.argv[1] if len(sys.argv) > 1 else "./dsp_test"
knobs = [0.25, 0.5, 0.75, 1.0]


def ld(p):
    return np.fromfile(p, np.float32).astype(np.float64)


def shadow(mix, part, rv):
    subprocess.run([exe, "shadow", mix, part, "sh.f32", "0", str(rv)], check=True)
    return ld("sh.f32")[WARM:]


def db(x, m=None):
    x = x if m is None else x[m]
    return 10 * np.log10(np.mean(x ** 2) + 1e-20)


def lsd(a, b):
    _, _, A = signal.stft(a, SR, nperseg=1024)
    _, _, B = signal.stft(b, SR, nperseg=1024)
    A = 20 * np.log10(np.abs(A) + 1e-6)
    B = 20 * np.log10(np.abs(B) + 1e-6)
    act = A.max(axis=0) > A.max() - 30
    return np.mean(np.sqrt(np.mean((A[:, act] - B[:, act]) ** 2, axis=0)))


print("room     knob | DRR in -> out | late removed | early removed | late in pauses | direct level | direct LSD")
for room in ["close", "small", "hall", "church"]:
    mix = f"rev_{room}_mix.f32"
    d0, e0, l0 = (ld(f"rev_{room}_{p}.f32")[WARM:] for p in ("direct", "early", "late"))
    for rv in knobs:
        d1 = shadow(mix, f"rev_{room}_direct.f32", rv)
        e1 = shadow(mix, f"rev_{room}_early.f32", rv)
        l1 = shadow(mix, f"rev_{room}_late.f32", rv)
        drr0 = db(d0) - db(e0 + l0)
        drr1 = db(d1) - db(e1 + l1)
        print(f"{room:7s} {int(rv*100):4d}% | {drr0:5.1f} -> {drr1:5.1f} | {db(l1)-db(l0):7.1f} dB  | {db(e1)-db(e0):7.1f} dB   |"
              f" {db(l1,~mask)-db(l0,~mask):7.1f} dB    | {db(d1,mask)-db(d0,mask):6.1f} dB  | {lsd(d0,d1):5.2f}")

d0 = ld("speech.f32")[WARM:]
for rv in knobs:
    d1 = shadow("speech.f32", "speech.f32", rv)
    print(f"dry     {int(rv*100):4d}% | direct level {db(d1,mask)-db(d0,mask):6.1f} dB | LSD {lsd(d0,d1):5.2f}")
