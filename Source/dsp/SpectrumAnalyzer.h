#pragma once
// Display-only spectrum analyser (used for the processed OUTPUT curve).
// Same FFT size, hop, scaling and ballistics as the input analyser inside FeedbackSuppressor,
// so both curves can be compared directly on the graph.

#include "FFT.h"
#include <algorithm>
#include <array>
#include <atomic>
#include <cmath>
#include <vector>

namespace dfb
{
class SpectrumAnalyzer
{
public:
    static constexpr int kDisplayPoints = 256;   // must match FeedbackSuppressor::kDisplayPoints

    SpectrumAnalyzer()
    {
        for (auto& d : displayDb) d.store (-120.0f);
    }

    void prepare (double sampleRate)
    {
        sr = sampleRate;
        fftSize = nextPow2 ((int) std::lround (sr * 0.085));
        hop = fftSize / 8;
        fft.init (fftSize);
        buf.assign ((size_t) fftSize, cfloat());
        ring.assign ((size_t) fftSize, 0.0f);
        window.resize ((size_t) fftSize);
        double wsum = 0.0;
        for (int i = 0; i < fftSize; ++i)
        {
            window[(size_t) i] = 0.5f - 0.5f * (float) std::cos (2.0 * kPi * i / fftSize);
            wsum += window[(size_t) i];
        }
        normDb = (float) (20.0 * std::log10 (wsum / 2.0));
        levelDb.assign ((size_t) (fftSize / 2 + 1), -200.0f);
        pos = counter = 0;
        for (auto& d : displayDb) d.store (-120.0f);
    }

    void process (const float* const* ch, int numCh, int numSamples) noexcept
    {
        if (ring.empty()) return;
        const float inv = 1.0f / (float) std::max (1, numCh);
        for (int i = 0; i < numSamples; ++i)
        {
            float m = 0.0f;
            for (int c = 0; c < numCh; ++c) m += ch[c][i];
            ring[(size_t) pos] = m * inv;
            pos = (pos + 1) & (fftSize - 1);
            if (++counter >= hop) { counter = 0; analyse(); }
        }
    }

    float getDisplayDb (int i) const noexcept { return displayDb[(size_t) i].load (std::memory_order_relaxed); }

private:
    void analyse() noexcept
    {
        for (int i = 0; i < fftSize; ++i)
            buf[(size_t) i] = cfloat (ring[(size_t) ((pos + i) & (fftSize - 1))] * window[(size_t) i], 0.0f);
        fft.forward (buf.data());
        const int bins = fftSize / 2 + 1;
        for (int k = 0; k < bins; ++k)
            levelDb[(size_t) k] = 10.0f * std::log10 (std::norm (buf[(size_t) k]) + 1e-20f) - normDb;

        for (int i = 0; i < kDisplayPoints; ++i)
        {
            const float fc = 20.0f * std::pow (1000.0f, (float) i / (float) (kDisplayPoints - 1));
            const float f0 = fc * std::pow (1000.0f, -0.5f / (kDisplayPoints - 1));
            const float f1 = fc * std::pow (1000.0f, 0.5f / (kDisplayPoints - 1));
            const int k0 = std::clamp ((int) std::floor (f0 * (double) fftSize / sr), 1, bins - 1);
            const int k1 = std::clamp ((int) std::ceil (f1 * (double) fftSize / sr), k0, bins - 1);
            float m = -200.0f;
            for (int k = k0; k <= k1; ++k) m = std::max (m, levelDb[(size_t) k]);
            const float old = displayDb[(size_t) i].load (std::memory_order_relaxed);
            displayDb[(size_t) i].store (m > old ? m : old * 0.85f + m * 0.15f, std::memory_order_relaxed);
        }
    }

    double sr = 48000.0;
    int fftSize = 4096, hop = 512, pos = 0, counter = 0;
    float normDb = 0.0f;
    FFT fft;
    std::vector<cfloat> buf;
    std::vector<float> ring, window, levelDb;
    std::array<std::atomic<float>, kDisplayPoints> displayDb;
};
} // namespace dfb
