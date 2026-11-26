#pragma once
// De-Reverb v2: late-reverberation suppression with BLIND room T60 estimation.
//
// 1) Room decay time (T60) is measured automatically in 6 frequency bands by looking for
//    free decays (sound stops -> energy falls along a straight line in dB). The median of
//    recent decays per band is the room's T60 (0.2 .. 4 s).
// 2) Late reverb power now = decay(T60, D) * smoothed power D ms ago (Lebart / Habets model).
//    D goes from 50 ms (knob low, keeps all early reflections) to 25 ms (knob high).
// 2b) How much of the signal is reverb at all (kappa) is measured too: right after a word ends,
//    a dry/close-miked signal drops far below the decay line, a reverberant one stays on it.
//    kappa per band = low percentile of (level now / predicted decay from D ms ago) at offsets.
//    -> a close vocal mic gets almost no processing, a distant/ambient mic gets full processing.
// 3) Gain per bin = decision-directed Wiener gain on the signal-to-reverb ratio, which keeps
//    random bins from "popping open" (the main weakness of plain spectral subtraction).
// Works on the power spectrum delivered by SpectralCleaner; output is a gain per bin.

#include <algorithm>
#include <array>
#include <atomic>
#include <cmath>
#include <vector>

namespace dfb
{
class ReverbSuppressor
{
public:
    static constexpr int kBands = 6;

    ReverbSuppressor()
    {
        for (auto& t : t60Display) t.store (0.0f);
    }

    void prepare (int numBins, int fftSize, int hopSize, double sampleRate)
    {
        bins = numBins;
        sr = sampleRate;
        hopSec = (double) hopSize / sampleRate;

        const float edges[kBands + 1] = { 0.0f, 250.0f, 500.0f, 1000.0f, 2000.0f, 4000.0f, 1.0e9f };
        bandOf.assign ((size_t) bins, 0);
        for (int k = 0; k < bins; ++k)
        {
            const float f = (float) (k * sampleRate / fftSize);
            int b = 0;
            while (b < kBands - 1 && f >= edges[b + 1]) ++b;
            bandOf[(size_t) k] = b;
        }
        // interpolation weights between band centres (log frequency) for a smooth T60 per bin
        const float centres[kBands] = { 160.0f, 350.0f, 700.0f, 1400.0f, 2800.0f, 6000.0f };
        lowBand.assign ((size_t) bins, 0);
        frac.assign ((size_t) bins, 0.0f);
        for (int k = 0; k < bins; ++k)
        {
            const float f = std::max (1.0f, (float) (k * sampleRate / fftSize));
            int b = 0;
            while (b < kBands - 2 && f > centres[b + 1]) ++b;
            float t = std::log (f / centres[b]) / std::log (centres[b + 1] / centres[b]);
            lowBand[(size_t) k] = b;
            frac[(size_t) k] = std::clamp (t, 0.0f, 1.0f);
        }

        Dmax = std::max (2, (int) std::lround (0.05 / hopSec));
        hist.assign ((size_t) (Dmax + 1), std::vector<float> ((size_t) bins, 0.0f));
        Pr.assign ((size_t) bins, 0.0f);
        PrF.assign ((size_t) bins, 0.0f);
        Pq.assign ((size_t) bins, 0.0f);
        PqF.assign ((size_t) bins, 0.0f);
        decayBin.assign ((size_t) bins, 1.0f);
        kappaBin.assign ((size_t) bins, 1.0f);
        Dref = std::clamp ((int) std::lround (0.04 / hopSec), 1, Dmax);
        gain.assign ((size_t) bins, 1.0f);
        gammaPrev.assign ((size_t) bins, 1.0f);

        // T60 estimator windows: short (fast rooms) and long (churches, halls)
        Wshort = std::max (8, (int) std::lround (0.12 / hopSec));
        Wlong = std::max (Wshort + 8, (int) std::lround (0.30 / hopSec));
        bandHist.assign ((size_t) Wlong, std::array<float, kBands> {});
        reset();
    }

    void reset()
    {
        for (auto& h : hist) std::fill (h.begin(), h.end(), 0.0f);
        std::fill (Pr.begin(), Pr.end(), 0.0f);
        std::fill (Pq.begin(), Pq.end(), 0.0f);
        std::fill (gain.begin(), gain.end(), 1.0f);
        std::fill (gammaPrev.begin(), gammaPrev.end(), 1.0f);
        for (auto& b : bandHist) b.fill (-200.0f);
        bandSmooth.fill (0.0f);
        for (int b = 0; b < kBands; ++b)
        {
            t60[(size_t) b] = kDefaultT60;
            candCount[(size_t) b] = 0;
            candPos[(size_t) b] = 0;
            t60Display[(size_t) b].store (0.0f);
            kappaDb[(size_t) b] = kDefaultKappaDb;
            kCount[(size_t) b] = 0;
            kPos[(size_t) b] = 0;
        }
        histPos = bandPos = frames = 0;
    }

    // P: power spectrum of this frame, noise: current noise-floor estimate (both 'bins' long).
    // gainOut receives the reverb gain (1 = untouched). Returns false when nothing is applied.
    bool process (const float* P, const float* noise, float amount, float* gainOut) noexcept
    {
        ++frames;
        updateT60 (P, noise);

        // smoothed powers (time + frequency) -> low-variance estimates
        for (int k = 0; k < bins; ++k)
        {
            Pr[(size_t) k] = 0.7f * Pr[(size_t) k] + 0.3f * P[k];
            Pq[(size_t) k] = 0.5f * Pq[(size_t) k] + 0.5f * P[k];
        }
        for (int k = 0; k < bins; ++k)
        {
            float s5 = 0.0f, w5 = 0.0f, s3 = 0.0f, w3 = 0.0f;
            for (int j = -2; j <= 2; ++j)
            {
                const int kk = std::clamp (k + j, 0, bins - 1);
                const float w = (float) (3 - std::abs (j));
                s5 += w * Pr[(size_t) kk]; w5 += w;
                if (std::abs (j) <= 1) { s3 += (2.0f - (float) std::abs (j)) * Pq[(size_t) kk]; w3 += 2.0f - (float) std::abs (j); }
            }
            PrF[(size_t) k] = s5 / w5;
            PqF[(size_t) k] = s3 / w3;
        }

        // history ring (needed even while the knob is at 0, so turning it up works instantly)
        const int writeIdx = histPos;
        hist[(size_t) writeIdx] = PrF;
        histPos = (histPos + 1) % (Dmax + 1);

        if (amount <= 0.001f || frames <= Dmax)
        {
            std::fill (gain.begin(), gain.end(), 1.0f);
            std::fill (gammaPrev.begin(), gammaPrev.end(), 1.0f);
            for (int k = 0; k < bins; ++k) gainOut[k] = 1.0f;
            return false;
        }

        const float a = amount;
        const int D = std::clamp ((int) std::lround ((0.05 - 0.025 * a) / hopSec), 1, Dmax);
        const auto& past = hist[(size_t) ((writeIdx - D + Dmax + 1) % (Dmax + 1))];
        const float dSec = (float) (D * hopSec);

        // per-bin decay factor and reverb fraction (interpolated between bands)
        for (int k = 0; k < bins; ++k)
        {
            const int b = lowBand[(size_t) k];
            const float fr = frac[(size_t) k];
            const float t = t60[(size_t) b] * (1.0f - fr) + t60[(size_t) b + 1] * fr;
            const float kd = kappaDb[(size_t) b] * (1.0f - fr) + kappaDb[(size_t) b + 1] * fr;
            decayBin[(size_t) k] = std::exp (-2.0f * 6.9078f / std::max (0.15f, t) * dSec);
            kappaBin[(size_t) k] = std::pow (10.0f, kd / 10.0f);
        }

        const float over = 1.0f + 4.0f * a;                          // over-estimation 1 .. 5
        const float floorG = std::pow (10.0f, -30.0f * a / 20.0f);   // 0 .. -30 dB
        const float aDD = 0.9f;

        for (int k = 0; k < bins; ++k)
        {
            const float late = over * kappaBin[(size_t) k] * decayBin[(size_t) k] * past[(size_t) k] + 1e-12f;
            const float gamma = std::min (PqF[(size_t) k] / late, 1.0e4f);
            const float g0 = gain[(size_t) k];
            const float xi = aDD * g0 * g0 * gammaPrev[(size_t) k] + (1.0f - aDD) * std::max (gamma - 1.0f, 0.0f);
            const float g = std::max (xi / (1.0f + xi), floorG);
            gain[(size_t) k] = g;
            gammaPrev[(size_t) k] = gamma;
            gainOut[k] = g;
        }
        return true;
    }

    // estimated room T60 in seconds (0 = not measured yet); band 3 = 1-2 kHz
    float getT60 (int band) const noexcept { return t60Display[(size_t) band].load (std::memory_order_relaxed); }
    float getKappaDb (int band) const noexcept { return kappaDb[(size_t) band]; }
    float getT60Mid() const noexcept
    {
        float s = 0.0f; int n = 0;
        for (int b = 2; b <= 4; ++b) { const float t = getT60 (b); if (t > 0.0f) { s += t; ++n; } }
        return n > 0 ? s / (float) n : 0.0f;
    }

private:
    static constexpr float kDefaultT60 = 1.0f;
    static constexpr int kCand = 40;
    static constexpr float kDefaultKappaDb = -3.0f;
    static constexpr int kKappaCand = 64;

    void updateT60 (const float* P, const float* noise) noexcept
    {
        std::array<double, kBands> e {}, nz {};
        for (int k = 1; k < bins; ++k)
        {
            e[(size_t) bandOf[(size_t) k]] += P[k];
            nz[(size_t) bandOf[(size_t) k]] += noise[k];
        }
        auto& row = bandHist[(size_t) bandPos];
        for (int b = 0; b < kBands; ++b)
        {
            const float db = 10.0f * (float) std::log10 (e[(size_t) b] + 1e-20);
            bandSmooth[(size_t) b] = frames <= 1 ? db : 0.5f * bandSmooth[(size_t) b] + 0.5f * db;
            row[(size_t) b] = bandSmooth[(size_t) b];
            noiseDb[(size_t) b] = 10.0f * (float) std::log10 (nz[(size_t) b] + 1e-20);
        }
        // reverb fraction at word endings: level now vs. decay line from Dref frames ago
        if (frames > Wlong)
        {
            const auto& pastRow = bandHist[(size_t) ((bandPos - Dref + Wlong) % Wlong)];
            for (int b = 0; b < kBands; ++b)
            {
                const float now = row[(size_t) b], then = pastRow[(size_t) b];
                if (then < noiseDb[(size_t) b] + 20.0f || now > then - 3.0f) continue;
                const float decayDb = -60.0f * (float) (Dref * hopSec) / std::max (0.15f, t60[(size_t) b]);
                const float r = std::min (0.0f, now - then - decayDb);
                auto& c = kappaCand[(size_t) b];
                c[(size_t) kPos[(size_t) b]] = std::max (r, -30.0f);
                kPos[(size_t) b] = (kPos[(size_t) b] + 1) % kKappaCand;
                kCount[(size_t) b] = std::min (kCount[(size_t) b] + 1, kKappaCand);
                const int n = kCount[(size_t) b];
                if (n >= 8 && (n % 4) == 0)
                {
                    std::array<float, kKappaCand> tmp {};
                    std::copy (c.begin(), c.begin() + n, tmp.begin());
                    const int q = n / 2;                                   // median
                    std::nth_element (tmp.begin(), tmp.begin() + q, tmp.begin() + n);
                    kappaDb[(size_t) b] = 0.8f * kappaDb[(size_t) b] + 0.2f * tmp[(size_t) q];
                }
            }
        }

        bandPos = (bandPos + 1) % Wlong;

        if (frames < Wlong || (frames % 4) != 0) return;

        for (int b = 0; b < kBands; ++b)
        {
            float t = 0.0f;
            if (fitDecay (b, Wshort, 8.0f, t) || fitDecay (b, Wlong, 6.0f, t))
                addCandidate (b, t);
        }
    }

    // linear regression of band level over the last W frames; true if it is a clean free decay
    bool fitDecay (int b, int W, float minDropDb, float& t60Out) const noexcept
    {
        double sx = 0, sy = 0, sxx = 0, sxy = 0;
        float first = 0.0f, last = 0.0f;
        int rises = 0;
        float prev = 0.0f;
        for (int i = 0; i < W; ++i)
        {
            const int idx = (bandPos - W + i + Wlong) % Wlong;
            const float y = bandHist[(size_t) idx][(size_t) b];
            const double x = i * hopSec;
            sx += x; sy += y; sxx += x * x; sxy += x * y;
            if (i == 0) first = y;
            if (i == W - 1) last = y;
            if (i > 0 && (i % 4) == 0) { if (y > prev + 0.5f) ++rises; prev = y; }
            if (i == 0) prev = y;
        }
        const double n = W;
        const double den = n * sxx - sx * sx;
        if (den <= 0.0) return false;
        const double slope = (n * sxy - sx * sy) / den;      // dB per second
        if (slope >= -1.0) return false;
        const double icpt = (sy - slope * sx) / n;

        const float drop = (float) (-slope * (W - 1) * hopSec);
        if (drop < minDropDb) return false;
        if (rises > W / 16) return false;                     // must fall steadily
        if (last < noiseDb[(size_t) b] + 6.0f) return false;  // stay clear of the noise floor
        if (first < noiseDb[(size_t) b] + 15.0f) return false;

        double res = 0.0;
        for (int i = 0; i < W; ++i)
        {
            const int idx = (bandPos - W + i + Wlong) % Wlong;
            const double r = bandHist[(size_t) idx][(size_t) b] - (icpt + slope * i * hopSec);
            res += r * r;
        }
        if (std::sqrt (res / n) > 1.5) return false;          // must be a straight line in dB

        t60Out = (float) std::clamp (-60.0 / slope, 0.2, 4.0);
        return true;
    }

    void addCandidate (int b, float t) noexcept
    {
        auto& c = cand[(size_t) b];
        c[(size_t) candPos[(size_t) b]] = t;
        candPos[(size_t) b] = (candPos[(size_t) b] + 1) % kCand;
        candCount[(size_t) b] = std::min (candCount[(size_t) b] + 1, kCand);
        const int n = candCount[(size_t) b];
        if (n < 5) return;

        std::array<float, kCand> tmp {};
        std::copy (c.begin(), c.begin() + n, tmp.begin());
        std::nth_element (tmp.begin(), tmp.begin() + n / 2, tmp.begin() + n);
        const float med = tmp[(size_t) (n / 2)];
        t60[(size_t) b] = 0.85f * t60[(size_t) b] + 0.15f * med;
        t60Display[(size_t) b].store (t60[(size_t) b], std::memory_order_relaxed);
    }

    int bins = 257;
    double sr = 48000.0, hopSec = 128.0 / 48000.0;
    int Dmax = 19, histPos = 0;
    long long frames = 0;

    std::vector<int> bandOf, lowBand;
    std::vector<float> frac;
    std::vector<std::vector<float>> hist;
    std::vector<float> Pr, PrF, Pq, PqF, decayBin, kappaBin, gain, gammaPrev;
    int Dref = 15;
    std::array<float, kBands> kappaDb {};
    std::array<std::array<float, kKappaCand>, kBands> kappaCand {};
    std::array<int, kBands> kCount {}, kPos {};

    int Wshort = 45, Wlong = 112, bandPos = 0;
    std::vector<std::array<float, kBands>> bandHist;
    std::array<float, kBands> bandSmooth {}, noiseDb {};
    std::array<float, kBands> t60 {};
    std::array<std::array<float, kCand>, kBands> cand {};
    std::array<int, kBands> candCount {}, candPos {};
    std::array<std::atomic<float>, kBands> t60Display;
};
} // namespace dfb
