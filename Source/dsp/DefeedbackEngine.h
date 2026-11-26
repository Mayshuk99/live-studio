#pragma once
// Full processing chain:  input -> De-Feedback (notches) -> De-Noise + De-Room + De-Reverb -> Mute -> output
// Total latency: 0 samples.

#include "FeedbackSuppressor.h"
#include "SpectralCleaner.h"
#include "SpectrumAnalyzer.h"

namespace dfb
{
class DefeedbackEngine
{
public:
    void prepare (double sampleRate, int numChannels)
    {
        sr = sampleRate;
        feedback.prepare (sampleRate, numChannels);
        cleaner.prepare (sampleRate, numChannels);
        outputSpectrum.prepare (sampleRate);
        muteGain = muteTarget;
        muteStep = 1.0f / (float) (0.005 * sampleRate);   // 5 ms ramp
    }

    void reset()
    {
        feedback.reset();
        cleaner.reset();
    }

    // all amounts 0..1
    void setParameters (float feedbackAmt, float noiseAmt, float reverbAmt, bool mute, float roomAmt = 0.0f) noexcept
    {
        feedback.setStrength (feedbackAmt);
        cleaner.setAmounts (noiseAmt, reverbAmt, roomAmt);
        muteTarget = mute ? 0.0f : 1.0f;
    }

    void setFeedbackTiming (float attackMs, float releaseSec, int ratio) noexcept
    {
        feedback.setTiming (attackMs, releaseSec, ratio);
    }

    void process (float* const* ch, int numCh, int numSamples) noexcept
    {
        feedback.process (ch, numCh, numSamples);
        cleaner.process (ch, numCh, numSamples);

        if (! (muteGain == muteTarget && muteGain == 1.0f))
        {
            for (int i = 0; i < numSamples; ++i)
            {
                if (muteGain < muteTarget) muteGain = std::min (muteTarget, muteGain + muteStep);
                else if (muteGain > muteTarget) muteGain = std::max (muteTarget, muteGain - muteStep);
                for (int c = 0; c < numCh; ++c) ch[c][i] *= muteGain;
            }
        }
        outputSpectrum.process (ch, numCh, numSamples);
    }

    FeedbackSuppressor feedback;
    SpectralCleaner cleaner;
    SpectrumAnalyzer outputSpectrum;   // processed signal, for the graph

private:
    double sr = 48000.0;
    float muteGain = 1.0f, muteTarget = 1.0f, muteStep = 0.004f;
};
} // namespace dfb
