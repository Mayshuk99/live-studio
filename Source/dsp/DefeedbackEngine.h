#pragma once
// Full processing chain:  input -> De-Feedback (notches) -> De-Noise + De-Reverb -> Mute -> output
// Total latency: 0 samples.

#include "FeedbackSuppressor.h"
#include "SpectralCleaner.h"

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
        muteGain = muteTarget;
        muteStep = 1.0f / (float) (0.005 * sampleRate);   // 5 ms ramp
    }

    void reset()
    {
        feedback.reset();
        cleaner.reset();
    }

    // all amounts 0..1
    void setParameters (float feedbackAmt, float noiseAmt, float reverbAmt, bool mute) noexcept
    {
        feedback.setStrength (feedbackAmt);
        cleaner.setAmounts (noiseAmt, reverbAmt);
        muteTarget = mute ? 0.0f : 1.0f;
    }

    void process (float* const* ch, int numCh, int numSamples) noexcept
    {
        feedback.process (ch, numCh, numSamples);
        cleaner.process (ch, numCh, numSamples);

        if (muteGain == muteTarget && muteGain == 1.0f) return;
        for (int i = 0; i < numSamples; ++i)
        {
            if (muteGain < muteTarget) muteGain = std::min (muteTarget, muteGain + muteStep);
            else if (muteGain > muteTarget) muteGain = std::max (muteTarget, muteGain - muteStep);
            for (int c = 0; c < numCh; ++c) ch[c][i] *= muteGain;
        }
    }

    FeedbackSuppressor feedback;
    SpectralCleaner cleaner;

private:
    double sr = 48000.0;
    float muteGain = 1.0f, muteTarget = 1.0f, muteStep = 0.004f;
};
} // namespace dfb
