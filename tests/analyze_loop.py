import sys
import numpy as np

SR = 48000
src = np.fromfile("speech.f32", dtype=np.float32)


def stats(name):
    x = np.fromfile(name, dtype=np.float32)
    seg = SR // 2
    rms = [20 * np.log10(np.sqrt(np.mean(x[i:i + seg] ** 2)) + 1e-9) for i in range(0, len(x) - seg, seg)]
    # strongest narrow tone in the last 5 s relative to median spectrum
    tail = x[-5 * SR:]
    spec = np.abs(np.fft.rfft(tail * np.hanning(len(tail))))
    f = np.fft.rfftfreq(len(tail), 1 / SR)
    db = 20 * np.log10(spec + 1e-12)
    k = np.argmax(db)
    ratio = db[k] - np.median(db[(f > 100) & (f < 10000)])
    return rms, f[k], ratio


src_rms = [20 * np.log10(np.sqrt(np.mean(src[i:i + SR // 2] ** 2)) + 1e-9) for i in range(0, len(src) - SR // 2, SR // 2)]
print("time(s)  source  no-plugin  plugin50%  plugin100%   (RMS dBFS)")
r0, f0, p0 = stats("loop_off.f32")
r5, f5, p5 = stats("loop_on50.f32")
r1, f1, p1 = stats("loop_on.f32")
for i in range(0, len(r0), 4):
    print(f"{i * 0.5:5.1f}   {src_rms[i]:6.1f}   {r0[i]:7.1f}   {r5[i]:8.1f}   {r1[i]:8.1f}")
print(f"\nstrongest tone in last 5 s:  no plugin {f0:.0f} Hz +{p0:.0f} dB over median | 50%: {f5:.0f} Hz +{p5:.0f} dB | 100%: {f1:.0f} Hz +{p1:.0f} dB")
