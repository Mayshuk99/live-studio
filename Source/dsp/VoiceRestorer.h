#pragma once
// VOICE RESTORE - gives back what the voice lost, zero latency.
//
// 1) Tone / level restoration (spectral makeup)
//    While the voice is present (frames well above the noise floor) the restorer measures, in
//    16 bands, how much De-Room + De-Reverb removed. Part of that loss is given back as a slow,
//    smooth EQ curve that is multiplied into SpectralCleaner's gain curve (so it is part of the
//    same minimum-phase filter). The voice does not get thinner or quieter.
//    The amount (restoreMax) was tuned on the simulated room set (tests/train_room.cpp, "restore").
//
// 2) Air restoration (bandwidth extension)
//    If the output has much less energy above 8 kHz than a natural voice (dull mic, phone-like
//    source, losses from processing), upper harmonics are re-created from the 3..7 kHz band
//    (band-pass -> level-normalised x*|x| -> high-pass 7.5 kHz) and mixed in. A slow control loop
//    only adds as much as is missing, so a voice that already has air is left alone.

#include "FFT.h"
#include <algorithm>
#include <array>
#include <atomic>
#include <cmath>
#include <vector>

namespace dfb
{
class VoiceRestorer
{
public:
    static constexpr int kBands = 16;
    static constexpr int kMaxChannels = 2;

    struct Params
    {
        float restoreMax = 0.7f;     // fraction of the measured voice loss given back at 100 % (tuned)
        float maxBoostDb = 9.0f;     // never boost more than this
        float airTargetDb = -16.0f;  // natural voice: energy 8-16 kHz vs 2-6 kHz
        float airMaxMix = 0.6f;      // maximum exciter mix at 100 %
    };
    void setParams (const Params& p) noexcept { prm = p; }

    VoiceRestorer()
    {
        for (auto& b : bandBoostDisplay) b.store (0.0f);
    }

    void prepare (int numBins, int fftSize, double sampleRate)
    {
        bins = numBins;
        sr = sampleRate;
        // 16 log-spaced bands 100 Hz .. 16 kHz
        bandOf.assign ((size_t) bins, -1);
        for (int k = 0; k < bins; ++k)
        {
            const double f = k * sampleRate / fftSize;
            if (f < 80.0 || f > 18000.0) continue;
            const int b = (int) std::floor (std::log (std::max (f, 100.0) / 100.0) / std::log (160.0) * kBands);
            bandOf[(size_t) k] = std::clamp (b, 0, kBands - 1);
        }
        boostBin.assign ((size_t) bins, 1.0f);
        num.fill (0.0); den.fill (0.0);
        boostDb.fill (0.0f);

        // exciter filters
        designBandpass (4600.0, 0.8);
        designHighpass (7500.0);
        for (auto& s : exState) s = ExState();
        envFast = 0.0f;
        airMix = 0.0f;
        eLow = eHigh = 0.0;
        frameLevel = 0.0f;
        levelPeak = 0.0f;
        aEnv = 1.0f - std::exp (-1.0f / (float) (0.005 * sr));
        aMeas = 1.0f - std::exp (-1.0f / (float) (0.3 * sr));
        aPeak = 1.0f - std::exp (-1.0f / (float) (5.0 * sr));
    }

    void setAmount (float a) noexcept { amount = std::clamp (a, 0.0f, 1.0f); }
    float getAmount() const noexcept { return amount; }

    // ---- 1) spectral makeup. Called once per STFT frame by SpectralCleaner.
    // P: input power, lossGain: gain of De-Room x De-Reverb for this frame (before smoothing),
    // noise: noise floor. Returns pointer to the boost curve (linear, >= 1), or nullptr if off.
    const float* updateMakeup (const float* P, const float* lossGain, const float* noise, float hopSec) noexcept
    {
        double e = 0.0, n = 0.0;
        for (int k = 1; k < bins; ++k) { e += P[k]; n += noise[k]; }
        const bool voice = e > 30.0 * n && e > 1.0e-9;             // > ~15 dB above the floor

        if (voice)
        {
            const double a = std::exp (-(double) hopSec / 3.0);   // ~3 s memory
            std::array<double, kBands> fn {}, fd {};
            for (int k = 0; k < bins; ++k)
            {
                const int b = bandOf[(size_t) k];
                if (b < 0) continue;
                fn[(size_t) b] += (double) lossGain[k] * lossGain[k] * P[k];
                fd[(size_t) b] += P[k];
            }
            for (int b = 0; b < kBands; ++b)
            {
                num[(size_t) b] = a * num[(size_t) b] + (1.0 - a) * fn[(size_t) b];
                den[(size_t) b] = a * den[(size_t) b] + (1.0 - a) * fd[(size_t) b];
            }
        }

        if (amount <= 0.001f)
        {
            for (auto& d : bandBoostDisplay) d.store (0.0f, std::memory_order_relaxed);
            return nullptr;
        }

        bool any = false;
        for (int b = 0; b < kBands; ++b)
        {
            const double lossDb = den[(size_t) b] > 0.0 ? 10.0 * std::log10 (num[(size_t) b] / den[(size_t) b] + 1e-12) : 0.0;
            const float target = std::clamp ((float) (-lossDb) * prm.restoreMax * amount, 0.0f, prm.maxBoostDb);
            boostDb[(size_t) b] += 0.05f * (target - boostDb[(size_t) b]);        // glide
            bandBoostDisplay[(size_t) b].store (boostDb[(size_t) b], std::memory_order_relaxed);
            any |= boostDb[(size_t) b] > 0.05f;
        }
        if (! any) return nullptr;

        // smooth curve over bins (interpolate between band centres)
        for (int k = 0; k < bins; ++k)
        {
            const int b = bandOf[(size_t) k];
            if (b < 0) { boostBin[(size_t) k] = 1.0f; continue; }
            float s = 0.0f, w = 0.0f;
            for (int j = -1; j <= 1; ++j)
            {
                const int bb = std::clamp (b + j, 0, kBands - 1);
                const float ww = j == 0 ? 2.0f : 1.0f;
                s += ww * boostDb[(size_t) bb]; w += ww;
            }
            boostBin[(size_t) k] = std::pow (10.0f, (s / w) / 20.0f);
        }
        return boostBin.data();
    }

    // ---- 2) air restoration, time domain, on the final output
    void processAir (float* const* ch, int numCh, int numSamples) noexcept
    {
        numCh = std::min (numCh, kMaxChannels);
        const float maxMix = prm.airMaxMix * amount;
        if (maxMix <= 0.0005f && airMix <= 0.0005f) { airMix = 0.0f; return; }
        const float target = std::pow (10.0f, prm.airTargetDb / 10.0f);

        for (int i = 0; i < numSamples; ++i)
        {
            float mono = 0.0f;
            for (int c = 0; c < numCh; ++c)
            {
                auto& st = exState[(size_t) c];
                const float x = ch[c][i];
                const float b = biquadS (bp, st.bp, x);
                st.env += aEnv * (std::abs (b) - st.env);
                const float h = b * std::abs (b) / (st.env + 1.0e-6f);       // 2nd-order products, level-normalised
                const float air = biquadS (hp2, st.hp2, biquadS (hp1, st.hp1, h));
                const float y = x + airMix * air;
                ch[c][i] = y;
                mono += y;
            }
            mono /= (float) numCh;

            // measurement on the OUTPUT (incl. what we add): ~2-6 kHz vs 8+ kHz, voice only
            const float lo = biquad (bpMeas, mono);
            const float hi = biquad (hpMeas2, biquad (hpMeas1, mono));
            levelPeak = std::max (std::abs (mono), levelPeak * (1.0f - aPeak));
            frameLevel += aEnv * (std::abs (mono) - frameLevel);
            if (frameLevel > 0.03f * levelPeak && frameLevel > 1.0e-4f)      // voice present
            {
                eLow += aMeas * (lo * lo - eLow);
                eHigh += aMeas * (hi * hi - eHigh);
            }
            // control loop: add air only while it is missing
            if ((i & 63) == 0 && eLow > 1.0e-12)
            {
                const double ratio = eHigh / eLow;
                const float step = 0.002f;
                airMix += ratio < target ? step : -step;
                airMix = std::clamp (airMix, 0.0f, maxMix);
            }
        }
    }

    float getBandBoostDb (int b) const noexcept { return bandBoostDisplay[(size_t) b].load (std::memory_order_relaxed); }
    float getAirMix() const noexcept { return airMix; }

private:
    struct Coef { float b0 = 1, b1 = 0, b2 = 0, a1 = 0, a2 = 0; };
    struct St { float z1 = 0, z2 = 0; };
    struct ExState { St bp, hp1, hp2; float env = 0.0f; };

    static float biquadS (const Coef& c, St& s, float x) noexcept
    {
        const float y = c.b0 * x + s.z1;
        s.z1 = c.b1 * x - c.a1 * y + s.z2;
        s.z2 = c.b2 * x - c.a2 * y;
        return y;
    }
    struct Filt { Coef c; St s; };
    static float biquad (Filt& f, float x) noexcept { return biquadS (f.c, f.s, x); }

    static Coef rbjBandpass (double fc, double q, double sr)
    {
        const double w = 2 * kPi * fc / sr, al = std::sin (w) / (2 * q), a0 = 1 + al;
        Coef c; c.b0 = (float) (al / a0); c.b1 = 0; c.b2 = (float) (-al / a0);
        c.a1 = (float) (-2 * std::cos (w) / a0); c.a2 = (float) ((1 - al) / a0);
        return c;
    }
    static Coef rbjHighpass (double fc, double q, double sr)
    {
        const double w = 2 * kPi * std::min (fc, sr * 0.45) / sr, al = std::sin (w) / (2 * q), cw = std::cos (w), a0 = 1 + al;
        Coef c; c.b0 = (float) ((1 + cw) / 2 / a0); c.b1 = (float) (-(1 + cw) / a0); c.b2 = c.b0;
        c.a1 = (float) (-2 * cw / a0); c.a2 = (float) ((1 - al) / a0);
        return c;
    }
    void designBandpass (double fc, double q)
    {
        bp = rbjBandpass (fc, q, sr);
        bpMeas.c = rbjBandpass (3500.0, 0.7, sr);
        bpMeas.s = St();
    }
    void designHighpass (double fc)
    {
        hp1 = rbjHighpass (fc, 0.54, sr);   // 4th-order Butterworth-ish
        hp2 = rbjHighpass (fc, 1.31, sr);
        hpMeas1.c = rbjHighpass (8000.0, 0.54, sr); hpMeas1.s = St();
        hpMeas2.c = rbjHighpass (8000.0, 1.31, sr); hpMeas2.s = St();
    }

    Params prm;
    int bins = 257;
    double sr = 48000.0;
    float amount = 0.0f;
    std::vector<int> bandOf;
    std::vector<float> boostBin;
    std::array<double, kBands> num {}, den {};
    std::array<float, kBands> boostDb {};
    std::array<std::atomic<float>, kBands> bandBoostDisplay;

    Coef bp, hp1, hp2;
    std::array<ExState, kMaxChannels> exState {};
    Filt bpMeas, hpMeas1, hpMeas2;
    float envFast = 0.0f, airMix = 0.0f, frameLevel = 0.0f, levelPeak = 0.0f;
    double eLow = 0.0, eHigh = 0.0;
    float aEnv = 0.004f, aMeas = 0.0001f, aPeak = 0.000005f;
};
} // namespace dfb
