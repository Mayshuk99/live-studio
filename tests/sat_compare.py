import os, subprocess, numpy as np
from scipy import signal
SR = 48000
G = float(open("loop_gain.txt").readline())
src = np.fromfile("speech.f32", np.float32)
b, a = signal.butter(2, [660 / (SR / 2), 686 / (SR / 2)], "band")
r = lambda v: 20 * np.log10(np.sqrt(np.mean(v ** 2)) + 1e-9)

def run(strength, extra):
    env = dict(os.environ, DFB_ENABLE_AT="3", DFB_CLIP="0.5", **extra)
    subprocess.run(["./dsp_test", "loop", "speech.f32", "room_ir.f32", "c.f32", str(G), str(strength), "c_n.txt"], check=True, env=env)
    x = np.fromfile("c.f32", np.float32).astype(float)
    h = signal.lfilter(b, a, x)
    seg = SR // 50
    lv = [r(h[i:i + seg]) for i in range(3 * SR, 6 * SR, seg)]
    t40 = next((i * 0.02 for i, v in enumerate(lv) if v < lv[0] - 40), None)
    tnorm = next((i / 20 for i in range(60, 200) if r(x[i * SR // 20:(i + 1) * SR // 20]) < r(src[i * SR // 20:(i + 1) * SR // 20]) + 6), None)
    notches = len(open("c_n.txt").read().strip().splitlines()[-1].split()) - 1
    return t40, tnorm, notches, r(x[-5 * SR:])

print("saturated howl (hard-clipping amp), knob turned up at 3.0 s")
print("version                          strength | howl -40 dB after | level normal at | notches | last 5 s")
for label, extra in [("v1.4 (no residual, no rescue)", {"DFB_NORESID": "1", "DFB_NORESCUE": "1"}),
                     ("full post-notch detection", {"DFB_POST": "1", "DFB_NORESCUE": "1"}),
                     ("v1.5 residual check + rescue", {})]:
    for s in (0.5, 1.0):
        t40, tn, nn, last = run(s, extra)
        print(f"{label:32s} {int(s*100):4d}%   |   {t40 if t40 is None else round(t40,2)} s         |  {tn if tn is None else round(tn-3,2)} s after    |   {nn:2d}    | {last:.1f} dBFS")
