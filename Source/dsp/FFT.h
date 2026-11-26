#pragma once
// Simple iterative radix-2 complex FFT. No external dependencies, so the DSP core
// can be compiled and tested without JUCE.

#include <algorithm>
#include <cmath>
#include <complex>
#include <vector>
#include <utility>

namespace dfb
{
using cfloat = std::complex<float>;
constexpr double kPi = 3.14159265358979323846;

class FFT
{
public:
    void init (int size)
    {
        n = size;
        log2n = 0;
        while ((1 << log2n) < n) ++log2n;

        twiddle.resize ((size_t) n / 2);
        for (int k = 0; k < n / 2; ++k)
        {
            const double a = -2.0 * 3.14159265358979323846 * k / n;
            twiddle[(size_t) k] = cfloat ((float) std::cos (a), (float) std::sin (a));
        }

        bitrev.resize ((size_t) n);
        for (int i = 0; i < n; ++i)
        {
            int r = 0;
            for (int b = 0; b < log2n; ++b)
                if (i & (1 << b)) r |= 1 << (log2n - 1 - b);
            bitrev[(size_t) i] = r;
        }
    }

    int size() const noexcept { return n; }

    void forward (cfloat* x) const noexcept { transform (x, false); }

    void inverse (cfloat* x) const noexcept
    {
        transform (x, true);
        const float s = 1.0f / (float) n;
        for (int i = 0; i < n; ++i) x[i] *= s;
    }

private:
    void transform (cfloat* x, bool inv) const noexcept
    {
        for (int i = 0; i < n; ++i)
        {
            const int j = bitrev[(size_t) i];
            if (i < j) std::swap (x[i], x[j]);
        }

        for (int len = 2; len <= n; len <<= 1)
        {
            const int half = len >> 1;
            const int step = n / len;
            for (int i = 0; i < n; i += len)
            {
                for (int k = 0; k < half; ++k)
                {
                    cfloat w = twiddle[(size_t) (k * step)];
                    if (inv) w = std::conj (w);
                    const cfloat u = x[i + k];
                    const cfloat a = x[i + k + half];
                    const cfloat v (a.real() * w.real() - a.imag() * w.imag(),
                                    a.real() * w.imag() + a.imag() * w.real());
                    x[i + k] = u + v;
                    x[i + k + half] = u - v;
                }
            }
        }
    }

    int n = 0, log2n = 0;
    std::vector<cfloat> twiddle;
    std::vector<int> bitrev;
};

// Decision-directed a-priori SNR with fast onset: when a bin suddenly is far above the
// noise / reverb estimate (consonants, sibilants, attacks) the gain opens immediately
// instead of ramping up over several frames.
inline float onsetXi (float xiDD, float gamma) noexcept
{
    constexpr float kOnsetGamma = 4.0f;   // 6 dB above the estimate
    constexpr float kOnsetWeight = 0.5f;
    return gamma > kOnsetGamma ? std::max (xiDD, kOnsetWeight * (gamma - 1.0f)) : xiDD;
}

inline int nextPow2 (int v)
{
    int p = 1;
    while (p < v) p <<= 1;
    return p;
}
} // namespace dfb
