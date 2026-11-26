// Offline test harness for the DSP core (no JUCE needed).
//   dsp_test open  in.f32 out.f32 fb nr rv [block]        - mono, open loop
//   dsp_test loop  src.f32 ir.f32 out.f32 gain fb [notches.txt] - closed acoustic loop
//   dsp_test ident                                           - transparency check at 0 %
//   dsp_test bench                                           - CPU usage
// All files: raw float32 mono, 48 kHz.

#include "../Source/dsp/DefeedbackEngine.h"
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <memory>
#include <random>
#include <string>
#include <vector>

static std::vector<float> readF32 (const char* p)
{
    std::ifstream f (p, std::ios::binary);
    f.seekg (0, std::ios::end);
    const auto n = (size_t) f.tellg() / 4;
    f.seekg (0);
    std::vector<float> v (n);
    f.read ((char*) v.data(), (std::streamsize) (n * 4));
    return v;
}

static void writeF32 (const char* p, const std::vector<float>& v)
{
    std::ofstream f (p, std::ios::binary);
    f.write ((const char*) v.data(), (std::streamsize) (v.size() * 4));
}

static const double SR = getenv ("DFB_SR") ? atof (getenv ("DFB_SR")) : 48000.0;

int main (int argc, char** argv)
{
    if (argc < 2) return 1;
    const std::string mode = argv[1];
    auto eng = std::make_unique<dfb::DefeedbackEngine>();

    if (mode == "open")
    {
        auto x = readF32 (argv[2]);
        const float fb = (float) atof (argv[4]), nr = (float) atof (argv[5]), rv = (float) atof (argv[6]);
        const int block = argc > 7 ? atoi (argv[7]) : 256;
        eng->prepare (SR, 1);
        eng->setParameters (fb, nr, rv, false);
        int maxNotches = 0;
        for (size_t p = 0; p < x.size(); p += (size_t) block)
        {
            float* ch[1] = { x.data() + p };
            eng->process (ch, 1, (int) std::min ((size_t) block, x.size() - p));
            maxNotches = std::max (maxNotches, eng->feedback.getActiveNotchCount());
        }
        writeF32 (argv[3], x);
        int hits = 0;
        for (int i = 0; i < dfb::FeedbackSuppressor::kMaxNotches; ++i) hits += eng->feedback.getNotchInfo (i).hits.load();
        printf ("max_active_notches=%d total_hits=%d\n", maxNotches, hits);
        for (int i = 0; i < dfb::FeedbackSuppressor::kMaxNotches; ++i)
        {
            auto& ni = eng->feedback.getNotchInfo (i);
            if (ni.freq.load() > 0) printf ("  notch %.1f Hz  -%.1f dB  hits=%d\n", ni.freq.load(), ni.depthDb.load(), ni.hits.load());
        }
        return 0;
    }

    if (mode == "loop")
    {
        auto src = readF32 (argv[2]);
        auto ir = readF32 (argv[3]);
        const float gain = (float) atof (argv[5]);
        const float fb = (float) atof (argv[6]);
        const bool usePlugin = fb >= 0.0f;
        const int block = 64;
        eng->prepare (SR, 1);
        eng->setParameters (std::max (0.0f, fb), 0.0f, 0.0f, false);

        const size_t n = src.size();
        std::vector<float> mic (n, 0.0f), spk (n, 0.0f), out (n, 0.0f);
        FILE* log = argc > 7 ? fopen (argv[7], "w") : nullptr;
        const size_t irLen = ir.size();
        for (size_t p = 0; p < n; p += block)
        {
            const size_t bl = std::min ((size_t) block, n - p);
            for (size_t i = p; i < p + bl; ++i)
            {
                double acc = src[i];
                // ir starts with >= 64 samples of zeros (acoustic delay), so spk is causal
                for (size_t m = 0; m < irLen && m <= i; ++m)
                    if (ir[m] != 0.0f) acc += (double) ir[m] * spk[i - m];
                mic[i] = (float) acc;
                out[i] = mic[i];
            }
            if (usePlugin)
            {
                float* ch[1] = { out.data() + p };
                eng->process (ch, 1, (int) bl);
            }
            for (size_t i = p; i < p + bl; ++i)
                spk[i] = std::tanh (gain * out[i]);   // amplifier / speaker saturates
            if (log && usePlugin && (p % 4800) < block)
            {
                fprintf (log, "%.3f", p / SR);
                for (int k = 0; k < dfb::FeedbackSuppressor::kMaxNotches; ++k)
                {
                    auto& ni = eng->feedback.getNotchInfo (k);
                    if (ni.freq.load() > 0) fprintf (log, " %.1f:%.1f", ni.freq.load(), ni.depthDb.load());
                }
                fprintf (log, "\n");
            }
        }
        if (log) fclose (log);
        writeF32 (argv[4], mic);
        return 0;
    }

    if (mode == "shadow")   // shadow mix.f32 part.f32 outpart.f32 nr rv : filter driven by mix, applied to part
    {
        auto mix = readF32 (argv[2]);
        auto part = readF32 (argv[3]);
        eng->prepare (SR, 2);
        eng->setParameters (0.0f, (float) atof (argv[5]), (float) atof (argv[6]), false);
        eng->cleaner.setAnalysisChannels (1);
        for (size_t p = 0; p < mix.size(); p += 256)
        {
            float* ch[2] = { mix.data() + p, part.data() + p };
            eng->process (ch, 2, (int) std::min ((size_t) 256, mix.size() - p));
        }
        writeF32 (argv[4], part);
        return 0;
    }

    if (mode == "ident")
    {
        std::mt19937 rng (1);
        std::normal_distribution<float> nd (0.0f, 0.3f);
        std::vector<float> a (48000 * 5), b;
        for (auto& v : a) v = nd (rng);
        b = a;
        std::vector<float> a2 = a, b2 = a;
        eng->prepare (SR, 2);
        eng->setParameters (0, 0, 0, false);
        for (size_t p = 0; p < a.size(); p += 480)
        {
            float* ch[2] = { a.data() + p, a2.data() + p };
            eng->process (ch, 2, (int) std::min ((size_t) 480, a.size() - p));
        }
        double maxErr = 0;
        for (size_t i = 0; i < a.size(); ++i) maxErr = std::max (maxErr, (double) std::abs (a[i] - b[i]));
        printf ("all knobs 0%%: max abs difference = %g\n", maxErr);
        return 0;
    }

    if (mode == "bench")
    {
        std::mt19937 rng (2);
        std::normal_distribution<float> nd (0.0f, 0.1f);
        const int seconds = 30;
        std::vector<float> l ((size_t) (SR * seconds)), r ((size_t) (SR * seconds));
        for (size_t i = 0; i < l.size(); ++i)
        {
            const float tone = 0.3f * (float) std::sin (2 * dfb::kPi * 1234.0 * i / SR);
            l[i] = nd (rng) + tone;
            r[i] = nd (rng) + tone;
        }
        eng->prepare (SR, 2);
        eng->setParameters (1, 1, 1, false);
        const auto t0 = std::chrono::high_resolution_clock::now();
        for (size_t p = 0; p < l.size(); p += 256)
        {
            float* ch[2] = { l.data() + p, r.data() + p };
            eng->process (ch, 2, (int) std::min ((size_t) 256, l.size() - p));
        }
        const double el = std::chrono::duration<double> (std::chrono::high_resolution_clock::now() - t0).count();
        printf ("stereo %.0f Hz, all knobs 100%%: %.2f s CPU for %d s audio -> %.1f%% of one core, notches=%d\n",
                SR, el, seconds, 100.0 * el / seconds, eng->feedback.getActiveNotchCount());
        return 0;
    }
    return 1;
}
