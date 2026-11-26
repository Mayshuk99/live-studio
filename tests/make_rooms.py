"""Room dataset for training / validating DE-ROOM (and DE-REVERB).

Each room: shoebox image-source early reflections (up to 3rd order), axial room modes
(resonances < 300 Hz), diffuse late tail with Sabine T60, mic distance -> DRR from
diffuse-field theory. Target = direct path only (what a perfect 'de-room' would give).

Writes rooms/<split>_<i>_mix.f32 and rooms/<split>_<i>_dry.f32 plus rooms/rooms.txt
"""
import os
import sys
import numpy as np
from scipy import signal

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from make_signals import speech_like, music_like  # noqa: E402

SR = 48000
C = 343.0
SECONDS = 12
OUT = "rooms"


def peaking(fc, gain_db, q):
    A = 10 ** (gain_db / 40)
    w0 = 2 * np.pi * fc / SR
    al = np.sin(w0) / (2 * q)
    b = [1 + al * A, -2 * np.cos(w0), 1 - al * A]
    a = [1 + al / A, -2 * np.cos(w0), 1 - al / A]
    return np.array(b) / a[0], np.array(a) / a[0]


def make_room(rng):
    Lx, Ly, Lz = rng.uniform(4, 30), rng.uniform(4, 22), rng.uniform(2.6, 10)
    alpha = rng.uniform(0.06, 0.45)
    V, S = Lx * Ly * Lz, 2 * (Lx * Ly + Lx * Lz + Ly * Lz)
    A = S * alpha
    t60 = float(np.clip(0.161 * V / A, 0.25, 3.0))
    src = np.array([rng.uniform(1, Lx - 1), rng.uniform(1, Ly - 1), rng.uniform(1.2, 2.0)])
    dist = rng.choice([rng.uniform(0.15, 0.6), rng.uniform(0.6, 3), rng.uniform(3, 10)])
    d = rng.standard_normal(3)
    d[2] *= 0.2
    mic = src + dist * d / np.linalg.norm(d)
    mic = np.clip(mic, [0.3, 0.3, 0.3], [Lx - 0.3, Ly - 0.3, Lz - 0.3])
    r0 = np.linalg.norm(mic - src)
    beta = np.sqrt(1 - alpha)

    Lir = int(min(3.2, 1.4 * t60 + 0.1) * SR)
    early = np.zeros(Lir)
    t_mix = 0.06
    for nx in range(-3, 4):
        for ny in range(-3, 4):
            for nz in range(-3, 4):
                if nx == ny == nz == 0:
                    continue
                order = abs(nx) + abs(ny) + abs(nz)
                if order > 3:
                    continue
                img = np.array([
                    nx * Lx + (src[0] if nx % 2 == 0 else Lx - src[0]),
                    ny * Ly + (src[1] if ny % 2 == 0 else Ly - src[1]),
                    nz * Lz + (src[2] if nz % 2 == 0 else Lz - src[2]),
                ])
                r = np.linalg.norm(img - mic)
                delay = (r - r0) / C  # relative to the direct sound
                if delay <= 0 or delay > t_mix:
                    continue
                k = int(round(delay * SR))
                early[k] += (r0 / r) * beta ** order * rng.choice([1, -1], p=[0.8, 0.2])
    # walls absorb highs more
    b, a = signal.butter(1, rng.uniform(3000, 9000) / (SR / 2))
    early = signal.lfilter(b, a, early)

    # diffuse late tail, octave-dependent decay
    t = np.arange(Lir) / SR
    late = np.zeros(Lir)
    for fc, kf in [(125, 1.35), (250, 1.2), (500, 1.05), (1000, 1.0), (2000, 0.9), (4000, 0.75), (8000, 0.6)]:
        lo, hi = fc / np.sqrt(2), min(fc * np.sqrt(2), SR / 2 * 0.95)
        bb, aa = signal.butter(2, [lo / (SR / 2), hi / (SR / 2)], "band")
        late += signal.lfilter(bb, aa, rng.standard_normal(Lir)) * np.exp(-6.9 * t / (t60 * kf))
    ramp = np.clip((t - t_mix * 0.5) / (t_mix * 0.5), 0, 1)
    late *= ramp
    # energy from diffuse-field theory: E_rev / E_dir = 16 pi r^2 / A
    e_rev = 16 * np.pi * r0 ** 2 / A
    e_early = np.sum(early ** 2)
    e_late = max(e_rev - e_early, 0.25 * e_rev)
    late *= np.sqrt(e_late / np.sum(late ** 2))

    rev = early + late
    # room modes (axial) boost the reverberant field
    modes = []
    for Ld in (Lx, Ly, Lz):
        for n in (1, 2, 3, 4):
            f = n * C / (2 * Ld)
            if 40 < f < 300:
                modes.append(f)
    rng.shuffle(modes)
    used = []
    for f in modes[: rng.integers(2, 5)]:
        g, q = rng.uniform(4, 10), rng.uniform(6, 14)
        bb, aa = peaking(f, g, q)
        rev = signal.lfilter(bb, aa, rev)
        used.append(round(f))
    drr = 10 * np.log10(1 / np.sum(rev ** 2))
    info = dict(L=(round(Lx, 1), round(Ly, 1), round(Lz, 1)), alpha=round(alpha, 2), t60=round(t60, 2),
                dist=round(r0, 2), drr=round(drr, 1), modes=used)
    return rev, info


def main():
    os.makedirs(OUT, exist_ok=True)
    rng = np.random.default_rng(2026)
    lines = []
    plan = [("train", 20), ("test", 10)]
    seed = 100
    for split, count in plan:
        for i in range(count):
            seed += 1
            src = music_like(SECONDS) if i % 5 == 4 else speech_like(SECONDS, seed=seed)
            rev, info = make_room(rng)
            wet = src + signal.fftconvolve(src, rev)[: len(src)]
            peak = np.max(np.abs(wet)) / 0.5
            (wet / peak).astype(np.float32).tofile(f"{OUT}/{split}_{i}_mix.f32")
            (src / peak).astype(np.float32).tofile(f"{OUT}/{split}_{i}_dry.f32")
            kind = "music" if i % 5 == 4 else "speech"
            lines.append(f"{split}_{i} {kind} T60={info['t60']}s dist={info['dist']}m DRR={info['drr']}dB "
                         f"room={info['L']} modes={info['modes']}")
        # dry examples (close mic in a dead booth): target = input
        for j in range(2 if split == "train" else 1):
            seed += 1
            src = speech_like(SECONDS, seed=seed)
            name = f"{split}_dry{j}"
            (src * 2).astype(np.float32).tofile(f"{OUT}/{name}_mix.f32")
            (src * 2).astype(np.float32).tofile(f"{OUT}/{name}_dry.f32")
            lines.append(f"{name} speech DRY")
    with open(f"{OUT}/rooms.txt", "w") as fh:
        fh.write("\n".join(lines) + "\n")
    print("\n".join(lines))


if __name__ == "__main__":
    main()
