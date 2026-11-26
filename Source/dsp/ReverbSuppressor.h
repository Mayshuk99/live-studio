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
// 4) DE-ROOM (processRoom): early reflections (5..40 ms) and room resonances.
//    Early-reflection power = kappa_k * weighted sum of the power 2..40 ms ago, where kappa_k
//    is measured PER FREQUENCY BIN at word endings (a running percentile of
//    "energy left right after the word ends" / "energy just before").  Frequencies where the
//    room resonates (boom, boxiness) keep more energy after offsets -> higher kappa -> more
//    suppression there.  A dry signal drops instantly -> kappa ~ -30 dB -> left alone.
//    Its parameters (RoomParams) were fitted on a set of simulated rooms (tests/train_room.cpp).
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

    struct RoomParams
    {
        // defaults = result of tests/train_room.cpp on 20 simulated rooms + 2 dry voices
        float overMax = 4.0f;       // over-estimation at 100 %
        float floorMaxDb = 12.0f;   // maximum cut at 100 %
        float percentile = 0.6f;    // percentile of the post-offset energy ratio
        float aDD = 0.8f;           // decision-directed smoothing
        int dMin = 4;               // first lag (frames) counted as a reflection (~10 ms)
        float endMs = 50.0f;        // last lag counted as early
        float gateDb = -10.0f;      // bins whose room fraction is below this are left alone (trained)
    };
    void setRoomParams (const RoomParams& p) noexcept { room = p; }

    struct ReverbParams
    {
        // defaults = result of tests/train_room.cpp ("reverb" mode), applied at knob 50 %
        float overMax = 2.0f;        // over-estimation at 50 %
        float floorMaxDb = 12.0f;    // maximum cut at 50 %
        float lateStartMs0 = 50.0f;  // late boundary at 0 %
        float lateStartMs1 = 35.0f;  // late boundary at 100 %
        float aDD = 0.8f;
        float gateDb = -9.0f;        // bands whose reverb fraction is below this are left alone
        // knob 0..50 % = trained values above (reached at 50 %), 50..100 % = ramp to "strong"
        float overStrong = 5.0f, floorStrongDb = 30.0f, lateStrongMs = 25.0f;
    };
    void setReverbParams (const ReverbParams& p) noexcept { rp = p; }
    const RoomParams& getRoomParams() const noexcept { return room; }

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
        roomKappaDb.assign ((size_t) bins, kRoomKappaInitDb);
        roomKappaS.assign ((size_t) bins, 0.0f);
        roomGain.assign ((size_t) bins, 1.0f);
        roomGammaPrev.assign ((size_t) bins, 1.0f);
        roomEw.assign ((size_t) bins, 0.0f);
        roomW.assign ((size_t) (Dmax + 1), 0.0f);
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
        std::fill (roomKappaDb.begin(), roomKappaDb.end(), kRoomKappaInitDb);
        std::fill (roomGain.begin(), roomGain.end(), 1.0f);
        std::fill (roomGammaPrev.begin(), roomGammaPrev.end(), 1.0f);
        lastWriteIdx = 0;
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
        lastWriteIdx = writeIdx;
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
        const float a1 = std::min (1.0f, 2.0f * a);            // trained range (0..50 %)
        const float u = std::max (0.0f, 2.0f * a - 1.0f);       // strong range (50..100 %)
        const float lateMs = rp.lateStartMs0 + (rp.lateStartMs1 - rp.lateStartMs0) * a1 + (rp.lateStrongMs - rp.lateStartMs1) * u;
        const int D = std::clamp ((int) std::lround (lateMs * 0.001 / hopSec), 1, Dmax);
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

        const float over = 1.0f + (rp.overMax - 1.0f) * a1 + (rp.overStrong - rp.overMax) * u;
        const float floorG = std::pow (10.0f, -(rp.floorMaxDb * a1 + (rp.floorStrongDb - rp.floorMaxDb) * u) / 20.0f);
        const float aDD = rp.aDD;

        for (int k = 0; k < bins; ++k)
        {
            const float late = over * kappaBin[(size_t) k] * decayBin[(size_t) k] * past[(size_t) k] + 1e-12f;
            const float gamma = std::min (PqF[(size_t) k] / late, 1.0e4f);
            const float g0 = gain[(size_t) k];
            const float xi = onsetXi (aDD * g0 * g0 * gammaPrev[(size_t) k] + (1.0f - aDD) * std::max (gamma - 1.0f, 0.0f), gamma);
            const float g = std::max (xi / (1.0f + xi), floorG);
            gain[(size_t) k] = g;
            gammaPrev[(size_t) k] = gamma;
            const float kdB = 10.0f * std::log10 (kappaBin[(size_t) k] + 1e-12f);
            const float wgt = std::clamp ((kdB - rp.gateDb) / 6.0f + 0.5f, 0.0f, 1.0f);
            gainOut[k] = 1.0f - wgt * (1.0f - g);
        }
        return true;
    }

    // DE-ROOM. Call right after process() for the same frame.
    bool processRoom (const float* noise, float amount, float* gainOut) noexcept
    {
        const int ring = Dmax + 1;
        const int dMin = std::clamp (room.dMin, 1, Dmax - 1);
        const int dEnd = std::clamp ((int) std::lround (room.endMs * 0.001 / hopSec), dMin + 1, Dmax);

        // lag weights follow the room decay
        float t60mid = 0.0f;
        for (int b = 2; b <= 4; ++b) t60mid += t60[(size_t) b] / 3.0f;
        float wsum = 0.0f;
        for (int d = dMin; d <= dEnd; ++d)
        {
            roomW[(size_t) d] = std::exp (-13.8f * (float) (d * hopSec) / std::max (0.15f, t60mid));
            wsum += roomW[(size_t) d];
        }
        for (int d = dMin; d <= dEnd; ++d) roomW[(size_t) d] /= wsum;

        std::fill (roomEw.begin(), roomEw.end(), 0.0f);
        for (int d = dMin; d <= dEnd; ++d)
        {
            const auto& h = hist[(size_t) ((lastWriteIdx - d + ring) % ring)];
            const float w = roomW[(size_t) d];
            for (int k = 0; k < bins; ++k) roomEw[(size_t) k] += w * h[(size_t) k];
        }

        // per-bin room fraction, measured at offsets (always running, so the knob reacts at once)
        if (frames > Dmax)
        {
            const auto& before = hist[(size_t) ((lastWriteIdx - dMin + ring) % ring)];
            const float p = std::clamp (room.percentile, 0.02f, 0.98f);
            for (int k = 1; k < bins; ++k)
            {
                const float then = before[(size_t) k];
                const float now = PqF[(size_t) k];
                if (then < 100.0f * noise[k] || now > 0.25f * then) continue;
                const float r = 10.0f * std::log10 (now / (roomEw[(size_t) k] + 1e-20f) + 1e-12f);
                float& q = roomKappaDb[(size_t) k];
                q += r < q ? -kQuantStep * (1.0f - p) : kQuantStep * p;
                q = std::clamp (q, -30.0f, 0.0f);
            }
            for (int k = 0; k < bins; ++k)
            {
                float s = 0.0f, w = 0.0f;
                for (int j = -2; j <= 2; ++j)
                {
                    const int kk = std::clamp (k + j, 0, bins - 1);
                    const float ww = (float) (3 - std::abs (j));
                    s += ww * roomKappaDb[(size_t) kk]; w += ww;
                }
                roomKappaS[(size_t) k] = std::pow (10.0f, (s / w) / 10.0f);
            }
        }

        if (amount <= 0.001f || frames <= Dmax)
        {
            std::fill (roomGain.begin(), roomGain.end(), 1.0f);
            std::fill (roomGammaPrev.begin(), roomGammaPrev.end(), 1.0f);
            for (int k = 0; k < bins; ++k) gainOut[k] = 1.0f;
            return false;
        }

        const float over = 1.0f + (room.overMax - 1.0f) * amount;
        const float floorG = std::pow (10.0f, -room.floorMaxDb * amount / 20.0f);
        const float aDD = room.aDD;
        for (int k = 0; k < bins; ++k)
        {
            const float er = over * roomKappaS[(size_t) k] * roomEw[(size_t) k] + 1e-12f;
            const float gamma = std::min (PqF[(size_t) k] / er, 1.0e4f);
            const float g0 = roomGain[(size_t) k];
            const float xi = onsetXi (aDD * g0 * g0 * roomGammaPrev[(size_t) k] + (1.0f - aDD) * std::max (gamma - 1.0f, 0.0f), gamma);
            const float g = std::max (xi / (1.0f + xi), floorG);
            roomGain[(size_t) k] = g;
            roomGammaPrev[(size_t) k] = gamma;
            // soft gate on the measured room fraction (close mics: nothing to remove)
            const float kdB = 10.0f * std::log10 (roomKappaS[(size_t) k] + 1e-12f);
            const float wgt = std::clamp ((kdB - room.gateDb) / 6.0f + 0.5f, 0.0f, 1.0f);
            gainOut[k] = 1.0f - wgt * (1.0f - g);
        }
        return true;
    }

    float getRoomKappaDb (int bin) const noexcept { return roomKappaDb[(size_t) bin]; }

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
    static constexpr float kRoomKappaInitDb = -15.0f;
    static constexpr float kQuantStep = 1.0f;   // dB per event for the percentile tracker

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
    int lastWriteIdx = 0;
    RoomParams room;
    ReverbParams rp;
    std::vector<float> roomKappaDb, roomKappaS, roomGain, roomGammaPrev, roomEw, roomW;
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
