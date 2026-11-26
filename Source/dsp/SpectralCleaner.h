#pragma once
// Zero-latency De-Noise + De-Reverb.
//
// Side chain : short STFT (512 @ 48 kHz, hop 128) of the input.
//   * Noise    : minimum-statistics noise floor tracker (Martin) + decision-directed
//                Wiener gain (Ephraim-Malah).  Adapts to hum, hiss, fans, HVAC, etc.
//   * Room     : ReverbSuppressor::processRoom - early reflections + room resonances
//   * Reverb   : ReverbSuppressor - blind room-T60 estimation + late-reverb model
//                (Lebart / Habets) + decision-directed Wiener gain.
// Audio path : the resulting gain curve is converted every hop into a short
//              MINIMUM-PHASE FIR filter (cepstral method) and the audio is filtered
//              directly in the time domain, with a crossfade between filters.
//              => no block delay, plugin latency = 0 samples.

#include "FFT.h"
#include "ReverbSuppressor.h"
#include <algorithm>
#include <atomic>
#include <cmath>
#include <limits>
#include <vector>

namespace dfb
{
class SpectralCleaner
{
public:
    static constexpr int kMaxChannels = 2;

    void prepare (double sampleRate, int numChannels)
    {
        sr = sampleRate;
        channels = std::min (numChannels, kMaxChannels);

        N = nextPow2 ((int) std::lround (sr * 0.0105));     // 512 @ 44.1/48 kHz, 1024 @ 88.2/96 kHz
        hop = N / 4;
        bins = N / 2 + 1;
        L = N / 2;                                          // FIR length (5.3 ms @ 48k)
        M = 2 * N;                                          // cepstrum size

        fft.init (N);
        fftC.init (M);
        buf.assign ((size_t) N, cfloat());
        cep.assign ((size_t) M, cfloat());

        window.resize ((size_t) N);
        for (int i = 0; i < N; ++i)
            window[(size_t) i] = 0.5f - 0.5f * (float) std::cos (2.0 * kPi * i / N);

        for (int c = 0; c < kMaxChannels; ++c)
        {
            ana[c].assign ((size_t) N, 0.0f);
            hist[c].assign ((size_t) (2 * L), 0.0f);
        }

        auto z = [this] (std::vector<float>& v, float val = 0.0f) { v.assign ((size_t) bins, val); };
        z (P); z (Psm); z (Pns); z (noise);
        z (gainN, 1.0f); z (gammaN, 1.0f); z (Gr, 1.0f); z (Groom, 1.0f);
        z (G, 1.0f); z (Gs, 1.0f); z (tmp, 1.0f);

        // minimum statistics: U sub-windows of V frames (~1.5 s total)
        const double hopSec = (double) hop / sr;
        V = std::max (4, (int) std::lround (0.19 / hopSec));
        subMin.assign ((size_t) U, std::vector<float> ((size_t) bins, std::numeric_limits<float>::max()));
        curMin.assign ((size_t) bins, std::numeric_limits<float>::max());

        reverb.prepare (bins, N, hop, sr);

        hOld.assign ((size_t) L, 0.0f);
        hNew.assign ((size_t) L, 0.0f);
        hDesign.assign ((size_t) L, 0.0f);
        fadeWin.resize ((size_t) hop);
        for (int i = 0; i < hop; ++i)
            fadeWin[(size_t) i] = 0.5f - 0.5f * (float) std::cos (kPi * (i + 0.5) / hop);

        reset();
    }

    void reset()
    {
        for (int c = 0; c < kMaxChannels; ++c)
        {
            std::fill (ana[c].begin(), ana[c].end(), 0.0f);
            std::fill (hist[c].begin(), hist[c].end(), 0.0f);
        }
        std::fill (Psm.begin(), Psm.end(), 0.0f);
        std::fill (Pns.begin(), Pns.end(), 0.0f);
        std::fill (noise.begin(), noise.end(), 0.0f);
        std::fill (gainN.begin(), gainN.end(), 1.0f);
        std::fill (gammaN.begin(), gammaN.end(), 1.0f);
        std::fill (Gs.begin(), Gs.end(), 1.0f);
        for (auto& s : subMin) std::fill (s.begin(), s.end(), std::numeric_limits<float>::max());
        std::fill (curMin.begin(), curMin.end(), std::numeric_limits<float>::max());
        reverb.reset();
        subIdx = subCount = 0;
        anaPos = histPos = hopCounter = 0;
        frames = 0;
        oldIsIdentity = newIsIdentity = true;
        fadePos = hop;
        gainReductionDb.store (0.0f);
    }

    void setAmounts (float noise01, float reverb01, float room01 = 0.0f) noexcept
    {
        amtNoise = std::clamp (noise01, 0.0f, 1.0f);
        amtReverb = std::clamp (reverb01, 0.0f, 1.0f);
        amtRoom = std::clamp (room01, 0.0f, 1.0f);
    }

    ReverbSuppressor& getReverbSuppressor() noexcept { return reverb; }

    float getGainReductionDb() const noexcept { return gainReductionDb.load (std::memory_order_relaxed); }
    float getRoomT60() const noexcept { return reverb.getT60Mid(); }   // seconds, 0 = not measured yet
    float getRoomT60Band (int b) const noexcept { return reverb.getT60 (b); }
    float getKappaDb (int b) const noexcept { return reverb.getKappaDb (b); }

    // test hook: analyse only the first n channels (0 = all). Used for "shadow filtering" measurements.
    void setAnalysisChannels (int n) noexcept { analysisChannels = n; }

    void process (float* const* ch, int numCh, int numSamples) noexcept
    {
        numCh = std::min (numCh, channels);
        for (int i = 0; i < numSamples; ++i)
        {
            // push input into analysis + filter history
            for (int c = 0; c < numCh; ++c)
            {
                const float x = ch[c][i];
                ana[c][(size_t) anaPos] = x;
                hist[c][(size_t) histPos] = x;
                hist[c][(size_t) (histPos + L)] = x;
            }
            anaPos = (anaPos + 1) & (N - 1);

            if (++hopCounter >= hop)
            {
                hopCounter = 0;
                analyse (analysisChannels > 0 ? std::min (analysisChannels, numCh) : numCh);
            }

            // filter
            for (int c = 0; c < numCh; ++c)
            {
                const float x = ch[c][i];
                const float* slice = hist[c].data() + histPos + 1;

                float yNew = newIsIdentity ? x : dot (hNew.data(), slice);
                float y = yNew;
                if (fadePos < hop)
                {
                    const float yOld = oldIsIdentity ? x : dot (hOld.data(), slice);
                    const float r = fadeWin[(size_t) fadePos];
                    y = yOld + r * (yNew - yOld);
                }
                ch[c][i] = y;
            }
            if (fadePos < hop) ++fadePos;
            histPos = (histPos + 1) % L;
        }
    }

private:
    static float dot (const float* a, const float* b, int n) noexcept
    {
        float s0 = 0, s1 = 0, s2 = 0, s3 = 0;
        int i = 0;
        for (; i + 3 < n; i += 4)
        {
            s0 += a[i] * b[i];
            s1 += a[i + 1] * b[i + 1];
            s2 += a[i + 2] * b[i + 2];
            s3 += a[i + 3] * b[i + 3];
        }
        for (; i < n; ++i) s0 += a[i] * b[i];
        return (s0 + s1) + (s2 + s3);
    }
    float dot (const float* hRev, const float* x) const noexcept { return dot (hRev, x, L); }

    void analyse (int numCh) noexcept
    {
        ++frames;

        // ---- linked power spectrum of all channels
        std::fill (P.begin(), P.end(), 0.0f);
        for (int c = 0; c < numCh; ++c)
        {
            for (int i = 0; i < N; ++i)
                buf[(size_t) i] = cfloat (ana[c][(size_t) ((anaPos + i) & (N - 1))] * window[(size_t) i], 0.0f);
            fft.forward (buf.data());
            for (int k = 0; k < bins; ++k) P[(size_t) k] += std::norm (buf[(size_t) k]);
        }
        const float inv = 1.0f / (float) std::max (1, numCh);
        for (auto& p : P) p = p * inv + 1e-12f;

        // ---- smoothing
        for (int k = 0; k < bins; ++k)
        {
            Psm[(size_t) k] = 0.6f * Psm[(size_t) k] + 0.4f * P[(size_t) k];
            Pns[(size_t) k] = 0.85f * Pns[(size_t) k] + 0.15f * P[(size_t) k];
        }

        // ---- minimum statistics noise floor
        for (int k = 0; k < bins; ++k) curMin[(size_t) k] = std::min (curMin[(size_t) k], Pns[(size_t) k]);
        if (++subCount >= V)
        {
            subMin[(size_t) subIdx] = curMin;
            subIdx = (subIdx + 1) % U;
            subCount = 0;
            std::fill (curMin.begin(), curMin.end(), std::numeric_limits<float>::max());
        }
        for (int k = 0; k < bins; ++k)
        {
            float m = curMin[(size_t) k];
            for (int u = 0; u < U; ++u) m = std::min (m, subMin[(size_t) u][(size_t) k]);
            if (m == std::numeric_limits<float>::max()) m = Pns[(size_t) k];
            noise[(size_t) k] = m * kNoiseBias;
        }

        // ---- gains
        const bool useN = amtNoise > 0.001f;
        const bool useR = reverb.process (P.data(), noise.data(), amtReverb, Gr.data());
        const bool useRoom = reverb.processRoom (noise.data(), amtRoom, Groom.data());
        const float aDD = 0.92f;

        const float overN = 1.0f + 3.0f * amtNoise;
        const float floorN = std::pow (10.0f, -30.0f * amtNoise / 20.0f);    // 0 .. -30 dB

        for (int k = 0; k < bins; ++k)
        {
            float g = 1.0f;
            const float p = P[(size_t) k];

            if (useN)
            {
                const float gamma = std::min (p / (overN * noise[(size_t) k] + 1e-12f), 1e4f);
                const float xi = aDD * gainN[(size_t) k] * gainN[(size_t) k] * gammaN[(size_t) k]
                               + (1.0f - aDD) * std::max (gamma - 1.0f, 0.0f);
                float gn = xi / (1.0f + xi);
                gn = std::max (gn, floorN);
                gainN[(size_t) k] = gn;
                gammaN[(size_t) k] = gamma;
                g *= gn;
            }

            if (useR) g *= Gr[(size_t) k];
            if (useRoom) g *= Groom[(size_t) k];

            G[(size_t) k] = std::max (g, 0.003f);   // never below -50 dB
        }

        // ---- frequency + time smoothing (limits "musical noise")
        for (int k = 0; k < bins; ++k)
        {
            const float a = G[(size_t) std::max (0, k - 1)];
            const float b = G[(size_t) k];
            const float c = G[(size_t) std::min (bins - 1, k + 1)];
            tmp[(size_t) k] = 0.25f * a + 0.5f * b + 0.25f * c;
        }
        double num = 0.0, den = 0.0;
        bool identity = true;
        for (int k = 0; k < bins; ++k)
        {
            const float g = tmp[(size_t) k];
            float& s = Gs[(size_t) k];
            s = g > s ? (0.3f * s + 0.7f * g) : (0.6f * s + 0.4f * g);   // fast open, slower close
            if (! useN && ! useR && ! useRoom) s = 1.0f;
            if (s < 0.999f) identity = false;
            num += (double) s * s * P[(size_t) k];
            den += P[(size_t) k];
        }
        gainReductionDb.store (den > 0.0 ? (float) (10.0 * std::log10 (num / den + 1e-12)) : 0.0f,
                               std::memory_order_relaxed);

        // ---- new filter
        std::swap (hOld, hNew);
        oldIsIdentity = newIsIdentity;
        newIsIdentity = identity;
        if (! identity) designMinimumPhase();
        fadePos = (oldIsIdentity && newIsIdentity) ? hop : 0;
    }

    // gain curve Gs (bins points) -> minimum phase FIR of length L (stored time-reversed in hNew)
    void designMinimumPhase() noexcept
    {
        const int half = M / 2;
        for (int j = 0; j <= half; ++j)
        {
            const float pos = (float) j * (float) (bins - 1) / (float) half;
            const int k = std::min ((int) pos, bins - 2);
            const float fr = pos - (float) k;
            const float g = Gs[(size_t) k] * (1.0f - fr) + Gs[(size_t) k + 1] * fr;
            const float lg = std::log (std::max (g, 1e-4f));
            cep[(size_t) j] = cfloat (lg, 0.0f);
            if (j > 0 && j < half) cep[(size_t) (M - j)] = cfloat (lg, 0.0f);
        }
        fftC.inverse (cep.data());                         // real cepstrum

        // fold to make it causal (minimum phase)
        for (int j = 1; j < half; ++j) cep[(size_t) j] = cfloat (2.0f * cep[(size_t) j].real(), 0.0f);
        cep[0] = cfloat (cep[0].real(), 0.0f);
        cep[(size_t) half] = cfloat (cep[(size_t) half].real(), 0.0f);
        for (int j = half + 1; j < M; ++j) cep[(size_t) j] = cfloat();

        fftC.forward (cep.data());
        for (auto& v : cep)
        {
            const float mag = std::exp (v.real());
            v = cfloat (mag * std::cos (v.imag()), mag * std::sin (v.imag()));
        }
        fftC.inverse (cep.data());                         // impulse response

        const int taper = L / 4;
        for (int i = 0; i < L; ++i)
        {
            float h = cep[(size_t) i].real();
            if (i >= L - taper)
                h *= 0.5f + 0.5f * (float) std::cos (kPi * (i - (L - taper) + 1) / (taper + 1));
            hNew[(size_t) (L - 1 - i)] = h;                // time reversed for dot product
        }
    }

    static constexpr int U = 8;
    static constexpr float kNoiseBias = 2.0f;

    double sr = 48000.0;
    int channels = 2;
    int N = 512, hop = 128, bins = 257, L = 256, M = 1024;
    int V = 70;

    FFT fft, fftC;
    std::vector<cfloat> buf, cep;
    std::vector<float> window, fadeWin;
    std::vector<float> ana[kMaxChannels], hist[kMaxChannels];
    std::vector<float> P, Psm, Pns, noise, gainN, gammaN, Gr, Groom, G, Gs, tmp;
    std::vector<std::vector<float>> subMin;
    ReverbSuppressor reverb;
    std::vector<float> curMin;
    std::vector<float> hOld, hNew, hDesign;

    int subIdx = 0, subCount = 0;
    int anaPos = 0, histPos = 0, hopCounter = 0, fadePos = 0;
    long long frames = 0;
    bool oldIsIdentity = true, newIsIdentity = true;

    float amtNoise = 0.0f, amtReverb = 0.0f, amtRoom = 0.0f;
    int analysisChannels = 0;
    std::atomic<float> gainReductionDb { 0.0f };
};
} // namespace dfb
