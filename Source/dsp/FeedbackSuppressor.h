#pragma once
// Zero-latency feedback (howl) suppressor.
//
// Audio path : a cascade of up to 16 narrow peaking-cut filters (IIR, no latency).
// Side chain : a 4096-point FFT analyser (at 44.1/48 kHz) looks for howling peaks
//              using several classic criteria at once:
//   * PMPR  - peak to median power ratio (tone stands far above the spectrum)
//   * PNPR  - peak to neighbour ratio (very narrow, pure tone)
//   * PHPR  - peak to harmonic ratio (feedback has no harmonic series, voices/instruments do)
//   * persistence + frequency stability over several frames (feedback is a steady tone,
//     voices have vibrato / pitch movement)
// When a peak passes all tests a notch is placed (or an existing one deepened).
// Notches hold for a while, then slowly release.

#include "FFT.h"
#include <algorithm>
#include <array>
#include <atomic>
#include <cmath>
#include <cstdint>
#include <vector>

namespace dfb
{
class FeedbackSuppressor
{
public:
    static constexpr int kMaxNotches = 16;
    static constexpr int kMaxChannels = 2;
    static constexpr int kDisplayPoints = 256;
    static constexpr int kCoefInterval = 32;   // samples between filter coefficient updates

    struct NotchInfo   // read by the UI thread
    {
        std::atomic<float> freq { 0.0f };
        std::atomic<float> depthDb { 0.0f };   // current cut in dB (positive number)
        std::atomic<int> hits { 0 };
    };

    FeedbackSuppressor()
    {
        for (auto& d : displayDb) d.store (-120.0f);
    }

    // magnitude (dB) of one notch filter at frequency f - used by the UI to draw the filter curve
    static float notchResponseDb (float f, float notchFreq, float cutDb, double sampleRate) noexcept
    {
        if (cutDb <= 0.0f || notchFreq <= 0.0f) return 0.0f;
        const double A = std::pow (10.0, -cutDb / 40.0);
        const double w0 = 2.0 * kPi * std::min ((double) notchFreq, sampleRate * 0.49) / sampleRate;
        const double alpha = std::sin (w0) / (2.0 * kQ);
        const double cw = std::cos (w0);
        const double b0 = 1.0 + alpha * A, b1 = -2.0 * cw, b2 = 1.0 - alpha * A;
        const double a0 = 1.0 + alpha / A, a1 = -2.0 * cw, a2 = 1.0 - alpha / A;
        const double w = 2.0 * kPi * std::min ((double) f, sampleRate * 0.5) / sampleRate;
        const std::complex<double> z1 = std::polar (1.0, -w), z2 = std::polar (1.0, -2.0 * w);
        const auto H = (b0 + b1 * z1 + b2 * z2) / (a0 + a1 * z1 + a2 * z2);
        return (float) (20.0 * std::log10 (std::abs (H) + 1e-12));
    }

    void prepare (double sampleRate, int numChannels)
    {
        sr = sampleRate;
        channels = std::min (numChannels, kMaxChannels);

        fftSize = nextPow2 ((int) std::lround (sr * 0.085));   // 4096 @ 44.1/48 kHz
        hop = fftSize / 8;
        fft.init (fftSize);
        fftBuf.assign ((size_t) fftSize, cfloat());
        ring.assign ((size_t) fftSize, 0.0f);
        ringPos = 0;
        hopCounter = 0;

        window.resize ((size_t) fftSize);
        double wsum = 0.0;
        for (int i = 0; i < fftSize; ++i)
        {
            window[(size_t) i] = 0.5f - 0.5f * (float) std::cos (2.0 * kPi * i / fftSize);
            wsum += window[(size_t) i];
        }
        // full-scale sine -> 0 dB
        normDb = (float) (20.0 * std::log10 (wsum / 2.0));

        const int bins = fftSize / 2 + 1;
        levelDb.assign ((size_t) bins, -200.0f);
        scratch.reserve ((size_t) bins);

        kLo = std::max (3, (int) (80.0 * fftSize / sr));
        kHi = std::min (bins - 10, (int) (std::min (16000.0, sr * 0.45) * fftSize / sr));

        // display: log-spaced 20 Hz .. 20 kHz
        for (int i = 0; i < kDisplayPoints; ++i)
            displayDb[(size_t) i].store (-120.0f);

        reset();
    }

    void reset()
    {
        for (auto& n : notches) n = Notch();
        for (auto& c : candidates) c = Candidate();
        for (auto& ni : notchInfo) { ni.freq.store (0.0f); ni.depthDb.store (0.0f); ni.hits.store (0); }
        std::fill (ring.begin(), ring.end(), 0.0f);
        sampleCount = 0;
        coefCounter = 0;
    }

    void setStrength (float s01) noexcept { strength = std::clamp (s01, 0.0f, 1.0f); }

    // attack: time for a notch to reach its depth; release: time until a notch is gone after
    // the feedback stopped (held for 70 %, faded out over the last 30 %);
    // ratio 1..4 (1:1 .. 1:4): cut = howl excess * (1 - 1/ratio). 1:1 = detect & show only.
    void setTiming (float attackMs, float releaseSeconds, int ratioN) noexcept
    {
        attackSec = std::clamp (attackMs, 1.0f, 1000.0f) * 0.001f;
        releaseSec = std::clamp (releaseSeconds, 0.2f, 120.0f);
        ratio = std::clamp (ratioN, 1, 4);
    }
    void requestClear() noexcept { clearRequested.store (true); }

    void process (float* const* ch, int numCh, int numSamples) noexcept
    {
        numCh = std::min (numCh, channels);
        if (clearRequested.exchange (false))
            for (auto& n : notches) { n.targetDb = 0.0f; n.currentDb = 0.0f; n.active = false; n.resetState(); n.hits = 0; }

        int pos = 0;
        while (pos < numSamples)
        {
            const int todo = std::min (numSamples - pos, kCoefInterval - coefCounter);

            // 1) side-chain analysis on the mono sum
            for (int i = 0; i < todo; ++i)
            {
                float m = 0.0f;
                for (int c = 0; c < numCh; ++c) m += ch[c][pos + i];
                m /= (float) std::max (1, numCh);
                ring[(size_t) ringPos] = m;
                ringPos = (ringPos + 1) & (fftSize - 1);
                ++sampleCount;
                if (++hopCounter >= hop) { hopCounter = 0; analyse(); }
            }

            // 2) coefficient update at the start of each 32-sample chunk
            if (coefCounter == 0) updateNotchCoefficients();

            // 3) apply active notches
            for (auto& n : notches)
            {
                if (! n.active || n.currentDb <= 0.0f) continue;
                for (int c = 0; c < numCh; ++c)
                {
                    float* d = ch[c] + pos;
                    double s1 = n.s1[c], s2 = n.s2[c];
                    for (int i = 0; i < todo; ++i)
                    {
                        const double x = d[i];
                        const double y = n.b0 * x + s1;
                        s1 = n.b1 * x - n.a1 * y + s2;
                        s2 = n.b2 * x - n.a2 * y;
                        d[i] = (float) y;
                    }
                    n.s1[c] = s1; n.s2[c] = s2;
                }
            }

            coefCounter = (coefCounter + todo) % kCoefInterval;
            pos += todo;
        }
    }

    // ---- UI access ---------------------------------------------------------
    const NotchInfo& getNotchInfo (int i) const noexcept { return notchInfo[(size_t) i]; }
    float getDisplayDb (int i) const noexcept { return displayDb[(size_t) i].load (std::memory_order_relaxed); }
    static float displayFreq (int i) noexcept
    {
        return 20.0f * std::pow (1000.0f, (float) i / (float) (kDisplayPoints - 1));
    }
    int getActiveNotchCount() const noexcept
    {
        int c = 0;
        for (auto& n : notches) c += n.active ? 1 : 0;
        return c;
    }

private:
    struct Notch
    {
        bool active = false;
        float freq = 1000.0f;
        float targetDb = 0.0f;     // desired cut (positive dB)
        float currentDb = 0.0f;    // smoothed cut
        double lastHit = -1e9;     // seconds
        int hits = 0;
        double b0 = 1, b1 = 0, b2 = 0, a1 = 0, a2 = 0;
        double s1[kMaxChannels] {}, s2[kMaxChannels] {};
        void resetState() { for (int c = 0; c < kMaxChannels; ++c) s1[c] = s2[c] = 0.0; }
    };

    struct Candidate
    {
        bool used = false;
        float bin = 0.0f;
        int count = 0;
        int missed = 0;
        float firstLevel = 0.0f, lastLevel = 0.0f;
        float minBin = 0.0f, maxBin = 0.0f;
    };

    static constexpr float kQ = 12.0f;              // ~1/8 octave
    static constexpr float kFastReleaseDbPerSec = 30.0f;
    float ratioFactor() const noexcept { return ratio <= 1 ? 0.0f : 1.0f - 1.0f / (float) ratio; }
    float maxDepthDb() const noexcept { return 9.0f + 21.0f * strength; }   // 9 .. 30 dB

    double now() const noexcept { return (double) sampleCount / sr; }

    float binLevel (int k) const noexcept
    {
        if (k < 1 || k >= (int) levelDb.size()) return -200.0f;
        return levelDb[(size_t) k];
    }

    float maxAround (int k, int r) const noexcept
    {
        float m = -200.0f;
        for (int j = k - r; j <= k + r; ++j) m = std::max (m, binLevel (j));
        return m;
    }

    void analyse() noexcept
    {
        // windowed FFT of the last fftSize samples
        for (int i = 0; i < fftSize; ++i)
            fftBuf[(size_t) i] = cfloat (ring[(size_t) ((ringPos + i) & (fftSize - 1))] * window[(size_t) i], 0.0f);
        fft.forward (fftBuf.data());

        const int bins = fftSize / 2 + 1;
        for (int k = 0; k < bins; ++k)
            levelDb[(size_t) k] = 10.0f * std::log10 (std::norm (fftBuf[(size_t) k]) + 1e-20f) - normDb;

        updateDisplay();

        const double t = now();
        const float dt = (float) hop / (float) sr;
        updateNotchTargets (t, dt);

        if (strength <= 0.001f)
        {
            for (auto& c : candidates) c = Candidate();
            return;
        }

        // median level of the band
        scratch.assign (levelDb.begin() + kLo, levelDb.begin() + kHi);
        auto mid = scratch.begin() + (long) scratch.size() / 2;
        std::nth_element (scratch.begin(), mid, scratch.end());
        const float medianDb = *mid;

        // thresholds controlled by strength (more strength = more sensitive)
        const float s = strength;
        const float pmprThr = 30.0f - 12.0f * s;     // 30 .. 18 dB above the median
        const float pnprThr = 24.0f - 8.0f * s;      // 24 .. 16 dB above neighbours
        const float phprThr = 14.0f - 4.0f * s;      // harmonics at least 14 .. 10 dB lower
        const float absThr = -55.0f - 15.0f * s;     // -55 .. -70 dBFS
        const float topThr = 12.0f + 6.0f * s;       // within 12 .. 18 dB of the loudest peak
        const int framesFast = (int) std::lround (10.0f - 4.0f * s);    // ~107 .. 64 ms
        const int framesSlow = (int) std::lround (45.0f - 25.0f * s);   // ~480 .. 215 ms
        const float growThr = 12.0f - 6.0f * s;                          // 12 .. 6 dB relative growth

        // total band power (for "relative level" = peak vs. everything else)
        double bandPow = 0.0;
        float globalMax = -200.0f;
        for (int k = kLo; k < kHi; ++k)
        {
            bandPow += std::pow (10.0, levelDb[(size_t) k] / 10.0);
            globalMax = std::max (globalMax, levelDb[(size_t) k]);
        }

        // collect peaks that pass the instantaneous tests
        struct Peak { float bin; float level; float rel; };
        std::array<Peak, 8> peaks {};
        int numPeaks = 0;

        for (int k = kLo; k < kHi; ++k)
        {
            const float L = levelDb[(size_t) k];
            if (L < absThr || L - medianDb < pmprThr || L < globalMax - topThr) continue;
            if (! (L > levelDb[(size_t) k - 1] && L >= levelDb[(size_t) k + 1])) continue;

            float neigh = -200.0f;
            for (int m = 4; m <= 8; ++m)
                neigh = std::max ({ neigh, binLevel (k - m), binLevel (k + m) });
            if (L - neigh < pnprThr) continue;

            if (2 * k < bins - 3 && L - maxAround (2 * k, 2) < phprThr) continue;
            if (3 * k < bins - 3 && L - maxAround (3 * k, 3) < phprThr) continue;

            // parabolic interpolation for a precise frequency
            const float a = levelDb[(size_t) k - 1], b = L, c = levelDb[(size_t) k + 1];
            const float den = a - 2.0f * b + c;
            const float delta = std::abs (den) > 1e-6f ? std::clamp (0.5f * (a - c) / den, -0.5f, 0.5f) : 0.0f;

            // level of the peak relative to the rest of the spectrum
            double peakPow = 0.0;
            for (int j = k - 3; j <= k + 3; ++j) peakPow += std::pow (10.0, binLevel (j) / 10.0);
            const double restPow = std::max (bandPow - peakPow, bandPow * 1e-6);
            const float rel = L - (float) (10.0 * std::log10 (restPow + 1e-30));

            const Peak p { (float) k + delta, L, rel };
            if (numPeaks < (int) peaks.size()) peaks[(size_t) numPeaks++] = p;
            else
            {
                auto weakest = std::min_element (peaks.begin(), peaks.end(), [] (auto& x, auto& y) { return x.level < y.level; });
                if (weakest->level < p.level) *weakest = p;
            }
        }

        // match peaks to tracked candidates
        std::array<bool, 16> matched {};
        for (int pi = 0; pi < numPeaks; ++pi)
        {
            const auto& p = peaks[(size_t) pi];
            int best = -1;
            float bestDist = 1.5f;
            for (int ci = 0; ci < (int) candidates.size(); ++ci)
            {
                auto& c = candidates[(size_t) ci];
                if (! c.used) continue;
                const float d = std::abs (c.bin - p.bin);
                if (d < bestDist) { bestDist = d; best = ci; }
            }

            if (best < 0)
            {
                auto it = std::find_if (candidates.begin(), candidates.end(), [] (auto& c) { return ! c.used; });
                if (it == candidates.end())
                    it = std::min_element (candidates.begin(), candidates.end(), [] (auto& x, auto& y) { return x.count < y.count; });
                *it = Candidate();
                it->used = true;
                it->bin = it->minBin = it->maxBin = p.bin;
                it->firstLevel = it->lastLevel = p.rel;
                it->count = 1;
                best = (int) (it - candidates.begin());
            }
            else
            {
                auto& c = candidates[(size_t) best];
                c.bin = p.bin;
                c.minBin = std::min (c.minBin, p.bin);
                c.maxBin = std::max (c.maxBin, p.bin);
                c.lastLevel = p.rel;
                ++c.count;
                c.missed = 0;
            }
            matched[(size_t) best] = true;

            auto& c = candidates[(size_t) best];
            const float freqHz = (float) (c.bin * sr / fftSize);
            const bool stable = (c.maxBin - c.minBin) <= 0.6f;
            const float relGrowth = c.lastLevel - c.firstLevel;   // growth vs. rest of spectrum

            // A) isolated tone that keeps growing faster than everything else -> feedback building up
            const bool growing = c.count >= framesFast && relGrowth >= growThr;
            // B) steady isolated tone that just won't go away (ringing / saturated howl).
            //    Already-notched frequencies that persist are deepened quickly.
            const int needed = isNearActiveNotch (freqHz) ? framesFast : framesSlow;
            const bool persistent = c.count >= needed && relGrowth > -3.0f;

            if (stable && (growing || persistent))
            {
                triggerNotch (freqHz, t, p.level - medianDb - 10.0f);
                c.count = 1;
                c.minBin = c.maxBin = c.bin;
                c.firstLevel = c.lastLevel;
            }
            else if (! stable)
            {
                // moving pitch -> restart (voice / instrument with vibrato)
                c.count = 1;
                c.minBin = c.maxBin = c.bin;
                c.firstLevel = c.lastLevel;
            }
        }

        for (int ci = 0; ci < (int) candidates.size(); ++ci)
        {
            auto& c = candidates[(size_t) ci];
            if (c.used && ! matched[(size_t) ci] && ++c.missed > 1) c = Candidate();
        }
    }

    bool isNearActiveNotch (float f) const noexcept
    {
        for (auto& n : notches)
            if (n.active && n.targetDb > 0.0f && std::abs (std::log2 (f / n.freq)) < 1.0f / 24.0f)
                return true;
        return false;
    }

    void triggerNotch (float f, double t, float excessDb) noexcept
    {
        const float maxDepth = maxDepthDb();
        const float rf = ratioFactor();                                   // 0 (1:1) .. 0.75 (1:4)
        const float firstDepth = rf > 0.0f ? std::clamp (std::max (excessDb, 4.0f) * rf, 3.0f, maxDepth) : 0.0f;
        const float stepDb = 3.0f * rf / 0.75f;

        // existing notch close by? (within 1/24 octave)
        Notch* hit = nullptr;
        float bestOct = 1.0f / 24.0f;
        for (auto& n : notches)
        {
            if (! n.active) continue;
            const float d = std::abs (std::log2 (f / n.freq));
            if (d < bestOct) { bestOct = d; hit = &n; }
        }

        if (hit != nullptr)
        {
            hit->freq = 0.8f * hit->freq + 0.2f * f;
            hit->targetDb = rf > 0.0f ? std::min (maxDepth, std::max (hit->targetDb, hit->currentDb) + stepDb) : 0.0f;
            hit->lastHit = t;
            ++hit->hits;
            return;
        }

        // free slot, otherwise replace the shallowest notch
        Notch* slot = nullptr;
        for (auto& n : notches) if (! n.active) { slot = &n; break; }
        if (slot == nullptr)
            slot = &*std::min_element (notches.begin(), notches.end(), [] (auto& a, auto& b) { return a.currentDb < b.currentDb; });

        *slot = Notch();
        slot->active = true;
        slot->freq = f;
        slot->targetDb = firstDepth;
        slot->currentDb = 0.0f;
        slot->lastHit = t;
        slot->hits = 1;
    }

    void updateNotchTargets (double t, float dt) noexcept
    {
        for (size_t i = 0; i < notches.size(); ++i)
        {
            auto& n = notches[i];
            if (n.active)
            {
                const float holdSec = 0.7f * releaseSec;
                const float fadeRate = maxDepthDb() / std::max (0.1f, 0.3f * releaseSec);
                if (strength <= 0.001f)
                {
                    n.targetDb = 0.0f;
                    n.lastHit = -1e9;
                }
                else if (t - n.lastHit > holdSec)
                    n.targetDb = std::max (0.0f, n.targetDb - fadeRate * dt);

                if (ratio <= 1) n.targetDb = 0.0f;                 // 1:1 = detect & show only
                n.targetDb = std::min (n.targetDb, maxDepthDb());  // knob lowered -> shallower
            }

            notchInfo[i].freq.store (n.active ? n.freq : 0.0f, std::memory_order_relaxed);
            notchInfo[i].depthDb.store (n.active ? n.currentDb : 0.0f, std::memory_order_relaxed);
            notchInfo[i].hits.store (n.active ? n.hits : 0, std::memory_order_relaxed);
        }
    }

    void updateNotchCoefficients() noexcept
    {
        const float dt = (float) kCoefInterval / (float) sr;
        const double t = now();
        const float relRate = std::max (kFastReleaseDbPerSec, maxDepthDb() / std::max (0.1f, 0.3f * releaseSec));
        for (auto& n : notches)
        {
            if (! n.active) continue;

            if (n.currentDb < n.targetDb)
                n.currentDb = std::min (n.targetDb, n.currentDb + std::max (n.targetDb, 3.0f) / attackSec * dt);
            else if (n.currentDb > n.targetDb)
                n.currentDb = std::max (n.targetDb, n.currentDb - relRate * dt);

            if (n.targetDb <= 0.0f && n.currentDb <= 0.05f)
            {
                n.currentDb = 0.0f;
                n.resetState();
                n.b0 = 1.0; n.b1 = n.b2 = n.a1 = n.a2 = 0.0;
                // keep listing it (detected frequency) until the release time is over
                if (t - n.lastHit > releaseSec) n.active = false;
                continue;
            }

            const double A = std::pow (10.0, -n.currentDb / 40.0);
            const double w0 = 2.0 * kPi * std::min ((double) n.freq, sr * 0.49) / sr;
            const double alpha = std::sin (w0) / (2.0 * kQ);
            const double cw = std::cos (w0);
            const double a0 = 1.0 + alpha / A;
            n.b0 = (1.0 + alpha * A) / a0;
            n.b1 = (-2.0 * cw) / a0;
            n.b2 = (1.0 - alpha * A) / a0;
            n.a1 = (-2.0 * cw) / a0;
            n.a2 = (1.0 - alpha / A) / a0;
        }
    }

    void updateDisplay() noexcept
    {
        const int bins = fftSize / 2 + 1;
        for (int i = 0; i < kDisplayPoints; ++i)
        {
            const float f0 = displayFreq (i) * std::pow (1000.0f, -0.5f / (kDisplayPoints - 1));
            const float f1 = displayFreq (i) * std::pow (1000.0f, 0.5f / (kDisplayPoints - 1));
            int k0 = (int) std::floor (f0 * (double) fftSize / sr);
            int k1 = (int) std::ceil (f1 * (double) fftSize / sr);
            k0 = std::clamp (k0, 1, bins - 1);
            k1 = std::clamp (k1, k0, bins - 1);
            float m = -200.0f;
            for (int k = k0; k <= k1; ++k) m = std::max (m, levelDb[(size_t) k]);
            const float old = displayDb[(size_t) i].load (std::memory_order_relaxed);
            const float v = m > old ? m : old * 0.85f + m * 0.15f;   // fast rise, slow fall
            displayDb[(size_t) i].store (v, std::memory_order_relaxed);
        }
    }

    double sr = 48000.0;
    int channels = 2;
    int fftSize = 4096, hop = 512;
    int kLo = 8, kHi = 1500;
    float normDb = 0.0f;
    FFT fft;
    std::vector<cfloat> fftBuf;
    std::vector<float> ring, window, levelDb, scratch;
    int ringPos = 0, hopCounter = 0, coefCounter = 0;
    int64_t sampleCount = 0;

    float strength = 0.5f;
    float attackSec = 0.02f, releaseSec = 15.0f;
    int ratio = 4;
    std::atomic<bool> clearRequested { false };

    std::array<Notch, kMaxNotches> notches {};
    std::array<Candidate, 16> candidates {};
    std::array<NotchInfo, kMaxNotches> notchInfo;
    std::array<std::atomic<float>, kDisplayPoints> displayDb;
};
} // namespace dfb
