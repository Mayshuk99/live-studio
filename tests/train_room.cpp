// DE-ROOM parameter training on the simulated room set (tests/make_rooms.py).
//
// Objective: log-spectral distance (LSD) between the plugin output and the DRY direct sound,
// averaged over the training rooms at knob 50 % and 100 %.  Dry recordings are part of the
// set (target = input), so "damaging" a dry voice is penalised as well.
// Search: coordinate descent over RoomParams, then the result is validated on held-out rooms.
//
//   train_room search            -> prints best parameters
//   train_room eval  a b c d e f -> per-room results for given parameters
//                                  (overMax floorMaxDb percentile aDD dMin endMs)

#include "../Source/dsp/DefeedbackEngine.h"
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

using Params = dfb::ReverbSuppressor::RoomParams;
static constexpr double SR = 48000.0;

struct Room { std::string name; std::vector<float> mix, dry; bool isDry = false; float baseLsd = 0.0f; };

static std::vector<float> readF32 (const std::string& p)
{
    std::ifstream f (p, std::ios::binary);
    f.seekg (0, std::ios::end);
    const auto n = (size_t) f.tellg() / 4;
    f.seekg (0);
    std::vector<float> v (n);
    f.read ((char*) v.data(), (std::streamsize) (n * 4));
    return v;
}

// ---- log spectral distance between x and reference (frames after 3 s, active frames only)
static float lsd (const std::vector<float>& x, const std::vector<float>& ref)
{
    const int N = 1024, H = 512, B = N / 2;
    dfb::FFT fft; fft.init (N);
    std::vector<dfb::cfloat> bx (N), br (N);
    std::vector<float> win (N);
    for (int i = 0; i < N; ++i) win[i] = 0.5f - 0.5f * std::cos (2.0f * (float) dfb::kPi * i / N);
    const size_t start = (size_t) (3 * SR);
    const int frames = (int) ((x.size() - start - N) / H);
    std::vector<float> dx ((size_t) frames * B), dr ((size_t) frames * B), er (frames);
    float maxDb = -300.0f, maxE = -300.0f;
    for (int f = 0; f < frames; ++f)
    {
        const size_t o = start + (size_t) f * H;
        for (int i = 0; i < N; ++i) { bx[i] = { x[o + i] * win[i], 0.0f }; br[i] = { ref[o + i] * win[i], 0.0f }; }
        fft.forward (bx.data()); fft.forward (br.data());
        double e = 0.0;
        for (int k = 1; k <= B; ++k)
        {
            const float px = std::norm (bx[k]), pr = std::norm (br[k]);
            dx[(size_t) f * B + k - 1] = 10.0f * std::log10 (px + 1e-12f);
            dr[(size_t) f * B + k - 1] = 10.0f * std::log10 (pr + 1e-12f);
            maxDb = std::max (maxDb, dr[(size_t) f * B + k - 1]);
            e += pr;
        }
        er[f] = 10.0f * (float) std::log10 (e + 1e-12);
        maxE = std::max (maxE, er[f]);
    }
    const float floorDb = maxDb - 60.0f;
    double off = 0.0; long cnt = 0;
    for (int f = 0; f < frames; ++f)
    {
        if (er[f] < maxE - 35.0f) continue;
        for (int k = 0; k < B; ++k)
        {
            off += std::max (dx[(size_t) f * B + k], floorDb) - std::max (dr[(size_t) f * B + k], floorDb);
            ++cnt;
        }
    }
    off /= std::max (1L, cnt);
    double total = 0.0; int nf = 0;
    for (int f = 0; f < frames; ++f)
    {
        if (er[f] < maxE - 35.0f) continue;
        double s = 0.0;
        for (int k = 0; k < B; ++k)
        {
            const double d = (std::max (dx[(size_t) f * B + k], floorDb) - off) - std::max (dr[(size_t) f * B + k], floorDb);
            s += d * d;
        }
        total += std::sqrt (s / B);
        ++nf;
    }
    return (float) (total / std::max (1, nf));
}

using RParams = dfb::ReverbSuppressor::ReverbParams;
static RParams gRev;   // reverb parameters used by every run

static float runRoom (const Room& r, const Params& p, float roomAmt, float reverbAmt)
{
    auto eng = std::make_unique<dfb::DefeedbackEngine>();
    eng->prepare (SR, 1);
    eng->cleaner.getReverbSuppressor().setRoomParams (p);
    eng->cleaner.getReverbSuppressor().setReverbParams (gRev);
    eng->setParameters (0.0f, 0.0f, reverbAmt, false, roomAmt);
    std::vector<float> y = r.mix;
    for (size_t pos = 0; pos < y.size(); pos += 256)
    {
        float* ch[1] = { y.data() + pos };
        eng->process (ch, 1, (int) std::min ((size_t) 256, y.size() - pos));
    }
    return lsd (y, r.dry);
}

struct Result { float objective; std::vector<float> at50, at100; };

static bool gSweepReverb = false;   // false: sweep De-Room 50/100 %, true: sweep De-Reverb 50/100 %

static Result evaluate (const std::vector<Room>& rooms, const Params& p, float reverbAmt = 0.0f)
{
    Result res;
    res.at50.resize (rooms.size());
    res.at100.resize (rooms.size());
    std::vector<std::thread> pool;
    std::mutex m;
    size_t next = 0;
    const unsigned nt = std::max (1u, std::thread::hardware_concurrency());
    for (unsigned t = 0; t < nt; ++t)
        pool.emplace_back ([&] {
            for (;;)
            {
                size_t i;
                { std::lock_guard<std::mutex> lk (m); if (next >= rooms.size()) return; i = next++; }
                if (gSweepReverb)
                {
                    res.at50[i] = runRoom (rooms[i], p, 0.0f, 0.5f);
                    res.at100[i] = runRoom (rooms[i], p, 0.0f, 1.0f);
                }
                else
                {
                    res.at50[i] = runRoom (rooms[i], p, 0.5f, reverbAmt);
                    res.at100[i] = runRoom (rooms[i], p, 1.0f, reverbAmt);
                }
            }
        });
    for (auto& th : pool) th.join();

    double obj = 0.0, w = 0.0;
    for (size_t i = 0; i < rooms.size(); ++i)
    {
        const double wi = rooms[i].isDry ? 3.0 : 1.0;   // dry voices count triple: "do no harm"
        obj += wi * 0.5 * (res.at50[i] + res.at100[i]);
        w += wi;
    }
    res.objective = (float) (obj / w);
    return res;
}

static std::vector<Room> loadSplit (const std::string& split)
{
    std::vector<Room> rooms;
    std::ifstream f ("rooms/rooms.txt");
    std::string line;
    while (std::getline (f, line))
    {
        const std::string name = line.substr (0, line.find (' '));
        if (name.rfind (split + "_", 0) != 0) continue;
        Room r;
        r.name = name;
        r.mix = readF32 ("rooms/" + name + "_mix.f32");
        r.dry = readF32 ("rooms/" + name + "_dry.f32");
        r.isDry = line.find ("DRY") != std::string::npos;
        r.baseLsd = r.isDry ? 0.0f : lsd (r.mix, r.dry);
        rooms.push_back (std::move (r));
    }
    return rooms;
}

static void printParams (const char* tag, const Params& p, float obj)
{
    printf ("%s overMax=%.2f floorMaxDb=%.1f percentile=%.2f aDD=%.2f dMin=%d endMs=%.0f  -> objective %.3f dB\n",
            tag, p.overMax, p.floorMaxDb, p.percentile, p.aDD, p.dMin, p.endMs, obj);
    fflush (stdout);
}

static void report (const char* title, const std::vector<Room>& rooms, const Params& p, float reverbAmt)
{
    auto r = evaluate (rooms, p, reverbAmt);
    printf ("\n%s (De-Reverb %d %%)\n  room         LSD to dry: input -> 50 %% -> 100 %%\n", title, (int) (reverbAmt * 100));
    double b = 0, a5 = 0, a1 = 0; int n = 0;
    for (size_t i = 0; i < rooms.size(); ++i)
    {
        printf ("  %-12s %6.2f -> %6.2f -> %6.2f\n", rooms[i].name.c_str(), rooms[i].baseLsd, r.at50[i], r.at100[i]);
        if (! rooms[i].isDry) { b += rooms[i].baseLsd; a5 += r.at50[i]; a1 += r.at100[i]; ++n; }
    }
    printf ("  MEAN (rooms) %6.2f -> %6.2f -> %6.2f dB\n", b / n, a5 / n, a1 / n);
}

int main (int argc, char** argv)
{
    const std::string mode = argc > 1 ? argv[1] : "search";
    auto train = loadSplit ("train");
    auto test = loadSplit ("test");
    printf ("train rooms %zu, test rooms %zu\n", train.size(), test.size());

    Params p;
    if (const char* e = getenv ("DFB_REV"))
        sscanf (e, "%f,%f,%f,%f,%f,%f", &gRev.overMax, &gRev.floorMaxDb, &gRev.lateStartMs0, &gRev.lateStartMs1, &gRev.aDD, &gRev.gateDb);
    if (mode == "reverb-eval")
    {
        gSweepReverb = true;
        auto tr = evaluate (train, p);
        auto r = evaluate (test, p);
        double b = 0, a5 = 0, a1 = 0, far5 = 0, far1 = 0, farb = 0; int n = 0, nf = 0;
        for (size_t i = 0; i < test.size(); ++i)
        {
            if (test[i].isDry) continue;
            b += test[i].baseLsd; a5 += r.at50[i]; a1 += r.at100[i]; ++n;
            if (test[i].baseLsd > 3.0f) { farb += test[i].baseLsd; far5 += r.at50[i]; far1 += r.at100[i]; ++nf; }
        }
        printf ("floor=%4.0f dB: train obj %.3f | TEST all %.2f -> %.2f -> %.2f | distant mics %.2f -> %.2f -> %.2f\n",
                gRev.floorMaxDb, tr.objective, b / n, a5 / n, a1 / n, farb / nf, far5 / nf, far1 / nf);
        return 0;
    }
    if (mode == "reverb")   // train De-Reverb parameters
    {
        gSweepReverb = true;
        float best = evaluate (train, p).objective;
        auto show = [&] (const char* tag) {
            printf ("%s over=%.1f floor=%.0f late0=%.0f late1=%.0f aDD=%.2f gate=%.0f -> %.3f\n", tag, gRev.overMax, gRev.floorMaxDb,
                    gRev.lateStartMs0, gRev.lateStartMs1, gRev.aDD, gRev.gateDb, best); fflush (stdout); };
        show ("start");
        auto tryF = [&] (float RParams::*f, std::vector<float> vals) {
            for (float v : vals)
            {
                const RParams keep = gRev;
                if (gRev.*f == v) continue;
                gRev.*f = v;
                const float o = evaluate (train, p).objective;
                if (o < best - 0.002f) { best = o; show ("  * better"); }
                else gRev = keep;
            }
        };
        for (int pass = 0; pass < 2; ++pass)
        {
            tryF (&RParams::gateDb, { -20.0f, -15.0f, -12.0f, -9.0f, -6.0f });
            tryF (&RParams::overMax, { 2.0f, 3.0f, 4.0f, 7.0f, 10.0f });
            tryF (&RParams::floorMaxDb, { 12.0f, 18.0f, 24.0f, 36.0f });
            tryF (&RParams::lateStartMs1, { 15.0f, 20.0f, 35.0f });
            tryF (&RParams::lateStartMs0, { 40.0f });
            tryF (&RParams::aDD, { 0.8f, 0.95f });
            show (("pass " + std::to_string (pass + 1)).c_str());
        }
        auto r = evaluate (test, p);
        printf ("\nTEST De-Reverb (never seen)\n  room         LSD to dry: input -> 50 %% -> 100 %%\n");
        double b = 0, a5 = 0, a1 = 0; int n = 0;
        for (size_t i = 0; i < test.size(); ++i)
        {
            printf ("  %-12s %6.2f -> %6.2f -> %6.2f\n", test[i].name.c_str(), test[i].baseLsd, r.at50[i], r.at100[i]);
            if (! test[i].isDry) { b += test[i].baseLsd; a5 += r.at50[i]; a1 += r.at100[i]; ++n; }
        }
        printf ("  MEAN (rooms) %6.2f -> %6.2f -> %6.2f dB\n", b / n, a5 / n, a1 / n);
        return 0;
    }
    if (mode == "gate")
    {
        for (float g : { -40.0f, -20.0f, -15.0f, -12.0f, -9.0f, -6.0f })
        {
            Params q = p; q.gateDb = g;
            auto r = evaluate (train, q);
            double worst = 0; for (size_t i = 0; i < train.size(); ++i) if (! train[i].isDry) worst = std::max (worst, (double) (r.at100[i] - train[i].baseLsd));
            printf ("gateDb=%.0f -> objective %.3f  (worst room change at 100%%: %+.2f dB)\n", g, r.objective, worst); fflush (stdout);
        }
        return 0;
    }
    if (mode == "eval")
    {
        if (argc >= 8)
        {
            p.overMax = (float) atof (argv[2]); p.floorMaxDb = (float) atof (argv[3]);
            p.percentile = (float) atof (argv[4]); p.aDD = (float) atof (argv[5]);
            p.dMin = atoi (argv[6]); p.endMs = (float) atof (argv[7]);
            if (argc >= 9) p.gateDb = (float) atof (argv[8]);
        }
        printParams ("params", p, evaluate (train, p).objective);
        report ("TRAIN", train, p, 0.0f);
        report ("TEST (never seen during training)", test, p, 0.0f);
        report ("TEST with De-Reverb 50 %", test, p, 0.5f);
        return 0;
    }

    // ---- coordinate descent
    float best = evaluate (train, p).objective;
    printParams ("start", p, best);

    const std::vector<float> overV { 1.5f, 2.0f, 3.0f, 4.0f, 6.0f, 8.0f };
    const std::vector<float> floorV { 6.0f, 9.0f, 12.0f, 15.0f, 18.0f, 24.0f };
    const std::vector<float> pctV { 0.1f, 0.2f, 0.3f, 0.45f, 0.6f };
    const std::vector<float> addV { 0.8f, 0.85f, 0.9f, 0.95f };
    const std::vector<int> dminV { 1, 2, 3, 4 };
    const std::vector<float> endV { 25.0f, 30.0f, 40.0f, 50.0f };

    for (int pass = 0; pass < 2; ++pass)
    {
        bool improved = false;
        auto tryF = [&] (float Params::*field, const std::vector<float>& vals, const char* nm) {
            for (float v : vals)
            {
                Params q = p; q.*field = v;
                if (q.*field == p.*field) continue;
                const float o = evaluate (train, q).objective;
                printf ("   %s=%.2f -> %.3f\n", nm, v, o); fflush (stdout);
                if (o < best - 0.002f) { best = o; p = q; improved = true; printParams ("  * better", p, best); }
            }
        };
        tryF (&Params::overMax, overV, "overMax");
        tryF (&Params::floorMaxDb, floorV, "floorMaxDb");
        tryF (&Params::percentile, pctV, "percentile");
        tryF (&Params::aDD, addV, "aDD");
        for (int v : dminV)
        {
            Params q = p; q.dMin = v;
            if (v == p.dMin) continue;
            const float o = evaluate (train, q).objective;
            printf ("   dMin=%d -> %.3f\n", v, o); fflush (stdout);
            if (o < best - 0.002f) { best = o; p = q; improved = true; printParams ("  * better", p, best); }
        }
        tryF (&Params::endMs, endV, "endMs");
        printParams (("pass " + std::to_string (pass + 1)).c_str(), p, best);
        if (! improved) break;
    }
    printParams ("BEST", p, best);
    report ("TRAIN", train, p, 0.0f);
    report ("TEST (never seen during training)", test, p, 0.0f);
    return 0;
}
