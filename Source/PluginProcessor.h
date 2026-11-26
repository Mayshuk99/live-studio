#pragma once

#include <juce_audio_processors/juce_audio_processors.h>
#include "dsp/DefeedbackEngine.h"

class DefeedbackAudioProcessor : public juce::AudioProcessor
{
public:
    DefeedbackAudioProcessor();
    ~DefeedbackAudioProcessor() override = default;

    void prepareToPlay (double sampleRate, int samplesPerBlock) override;
    void releaseResources() override {}
    bool isBusesLayoutSupported (const BusesLayout& layouts) const override;
    void processBlock (juce::AudioBuffer<float>&, juce::MidiBuffer&) override;
    using AudioProcessor::processBlock;

    juce::AudioProcessorEditor* createEditor() override;
    bool hasEditor() const override { return true; }

    const juce::String getName() const override { return JucePlugin_Name; }
    bool acceptsMidi() const override { return false; }
    bool producesMidi() const override { return false; }
    bool isMidiEffect() const override { return false; }
    double getTailLengthSeconds() const override { return 0.0; }

    int getNumPrograms() override { return 1; }
    int getCurrentProgram() override { return 0; }
    void setCurrentProgram (int) override {}
    const juce::String getProgramName (int) override { return {}; }
    void changeProgramName (int, const juce::String&) override {}

    void getStateInformation (juce::MemoryBlock& destData) override;
    void setStateInformation (const void* data, int sizeInBytes) override;

    static juce::AudioProcessorValueTreeState::ParameterLayout createParameterLayout();

    juce::AudioProcessorValueTreeState apvts;
    dfb::DefeedbackEngine engine;

    double getCurrentSampleRate() const noexcept { return currentSampleRate.load(); }

    // level meters: peak (max since the UI last read it) and RMS of the last block, linear
    struct Meter
    {
        std::array<std::atomic<float>, 2> peak, rms;
        Meter() { for (int c = 0; c < 2; ++c) { peak[(size_t) c].store (0.0f); rms[(size_t) c].store (0.0f); } }
    };
    Meter inputMeter, outputMeter;
    std::atomic<int> meterChannels { 2 };

private:
    void measure (Meter& m, const juce::AudioBuffer<float>& b, int numCh, int n) noexcept;

    std::atomic<float>* pFeedback = nullptr;
    std::atomic<float>* pDenoise = nullptr;
    std::atomic<float>* pDereverb = nullptr;
    std::atomic<float>* pMute = nullptr;
    std::atomic<double> currentSampleRate { 48000.0 };

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (DefeedbackAudioProcessor)
};
