"""Saturated-howl test: hard-clipping amp, De-Feedback knob turned up only after the howl has
already saturated (3 s). Also the normal-start case with hard clipping."""
import os, subprocess, sys
import numpy as np
SR = 48000
exe = sys.argv[1] if len(sys.argv) > 1 else "./dsp_test"
G = float(open("loop_gain.txt").readline())
src = np.fromfile("speech.f32", np.float32)
r = lambda v: 20 * np.log10(np.sqrt(np.mean(v ** 2)) + 1e-9)

def run(strength, enable_at, clip):
    env = dict(os.environ, DFB_ENABLE_AT=str(enable_at), DFB_CLIP=str(clip))
    subprocess.run([exe, "loop", "speech.f32", "room_ir.f32", "sat.f32", str(G), str(strength), "sat_n.txt"], check=True, env=env)
    return np.fromfile("sat.f32", np.float32)

print("hard-clipping amp, loop gain +3 dB  (RMS dBFS per second; source in first row)")
print("        " + " ".join(f"{i:5d}" for i in range(0, 20, 1)))
print("source  " + " ".join(f"{r(src[i*SR:(i+1)*SR]):5.0f}" for i in range(20)))
for label, s, en in [("off", -1, 0), ("50% from start", 0.5, 0), ("50% at 3 s", 0.5, 3.0), ("100% at 3 s", 1.0, 3.0)]:
    x = run(s, en, 0.5)
    rec = next((i / 4 for i in range(12, 80) if r(x[i*SR//4:(i+1)*SR//4]) < r(src[i*SR//4:(i+1)*SR//4]) + 6), None)
    print(f"{label:15s}" + " ".join(f"{r(x[i*SR:(i+1)*SR]):5.0f}" for i in range(20)) +
          f"   | last 5 s {r(x[-5*SR:]):6.1f} dBFS (source {r(src[-5*SR:]):.1f}) | back to normal at {rec} s")
    if s >= 0:
        print("                notches at end:", open("sat_n.txt").read().strip().splitlines()[-1][:120])
