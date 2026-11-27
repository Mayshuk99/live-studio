#include "PluginProcessor.h"
#include "PluginEditor.h"

namespace ParamIDs
{
    static const juce::ParameterID feedback { "feedback", 1 };
    static const juce::ParameterID denoise  { "denoise",  1 };
    static const juce::ParameterID dereverb { "dereverb", 1 };
    static const juce::ParameterID mute     { "mute",     1 };
    static const juce::ParameterID deroom   { "deroom",   1 };
    static const juce::ParameterID fbAttack { "fbAttack", 1 };
    static const juce::ParameterID fbRelease{ "fbRelease", 1 };
    static const juce::ParameterID fbRatio  { "fbRatio",  1 };
    static const juce::ParameterID restore  { "restore",  1 };
}

DefeedbackAudioProcessor::DefeedbackAudioProcessor()
    : AudioProcessor (BusesProperties()
                          .withInput  ("Input",  juce::AudioChannelSet::stereo(), true)
                          .withOutput ("Output", juce::AudioChannelSet::stereo(), true)),
      apvts (*this, nullptr, "PARAMS", createParameterLayout())
{
    pFeedback = apvts.getRawParameterValue ("feedback");
    pDenoise  = apvts.getRawParameterValue ("denoise");
    pDereverb = apvts.getRawParameterValue ("dereverb");
    pMute     = apvts.getRawParameterValue ("mute");
    pDeroom   = apvts.getRawParameterValue ("deroom");
    pAttack   = apvts.getRawParameterValue ("fbAttack");
    pRelease  = apvts.getRawParameterValue ("fbRelease");
    pRatio    = apvts.getRawParameterValue ("fbRatio");
    pRestore  = apvts.getRawParameterValue ("restore");
    if (! apvts.state.hasProperty ("graphSmoothing")) apvts.state.setProperty ("graphSmoothing", 30.0, nullptr);
}

juce::AudioProcessorValueTreeState::ParameterLayout DefeedbackAudioProcessor::createParameterLayout()
{
    auto percent = juce::AudioParameterFloatAttributes()
                       .withLabel ("%")
                       .withStringFromValueFunction ([] (float v, int) { return juce::String (juce::roundToInt (v)) + " %"; });

    std::vector<std::unique_ptr<juce::RangedAudioParameter>> params;
    params.push_back (std::make_unique<juce::AudioParameterFloat> (ParamIDs::feedback, "De-Feedback",
                                                                   juce::NormalisableRange<float> (0.0f, 100.0f, 1.0f), 50.0f, percent));
    params.push_back (std::make_unique<juce::AudioParameterFloat> (ParamIDs::denoise, "De-Noise",
                                                                   juce::NormalisableRange<float> (0.0f, 100.0f, 1.0f), 0.0f, percent));
    params.push_back (std::make_unique<juce::AudioParameterFloat> (ParamIDs::dereverb, "De-Reverb",
                                                                   juce::NormalisableRange<float> (0.0f, 100.0f, 1.0f), 0.0f, percent));
    params.push_back (std::make_unique<juce::AudioParameterBool> (ParamIDs::mute, "Mute", false));
    params.push_back (std::make_unique<juce::AudioParameterFloat> (ParamIDs::deroom, "De-Room",
                                                                   juce::NormalisableRange<float> (0.0f, 100.0f, 1.0f), 0.0f, percent));

    juce::NormalisableRange<float> attackRange (1.0f, 500.0f, 1.0f);
    attackRange.setSkewForCentre (50.0f);
    params.push_back (std::make_unique<juce::AudioParameterFloat> (ParamIDs::fbAttack, "Feedback Attack", attackRange, 20.0f,
        juce::AudioParameterFloatAttributes().withLabel ("ms")
            .withStringFromValueFunction ([] (float v, int) { return juce::String (juce::roundToInt (v)) + " ms"; })));

    juce::NormalisableRange<float> releaseRange (0.5f, 60.0f, 0.1f);
    releaseRange.setSkewForCentre (8.0f);
    params.push_back (std::make_unique<juce::AudioParameterFloat> (ParamIDs::fbRelease, "Feedback Release", releaseRange, 15.0f,
        juce::AudioParameterFloatAttributes().withLabel ("s")
            .withStringFromValueFunction ([] (float v, int) { return juce::String (v, v < 10.0f ? 1 : 0) + " s"; })));

    params.push_back (std::make_unique<juce::AudioParameterChoice> (ParamIDs::fbRatio, "Feedback Ratio",
                                                                    juce::StringArray { "1:1", "1:2", "1:3", "1:4" }, 3));
    params.push_back (std::make_unique<juce::AudioParameterFloat> (ParamIDs::restore, "Voice Restore",
                                                                   juce::NormalisableRange<float> (0.0f, 100.0f, 1.0f), 0.0f, percent));
    return { params.begin(), params.end() };
}

bool DefeedbackAudioProcessor::isBusesLayoutSupported (const BusesLayout& layouts) const
{
    const auto in = layouts.getMainInputChannelSet();
    const auto out = layouts.getMainOutputChannelSet();
    if (in != out) return false;
    return in == juce::AudioChannelSet::mono() || in == juce::AudioChannelSet::stereo();
}

void DefeedbackAudioProcessor::prepareToPlay (double sampleRate, int)
{
    currentSampleRate.store (sampleRate);
    engine.prepare (sampleRate, 2);
    setLatencySamples (0);
}

void DefeedbackAudioProcessor::processBlock (juce::AudioBuffer<float>& buffer, juce::MidiBuffer&)
{
    juce::ScopedNoDenormals noDenormals;

    const int numIn = getTotalNumInputChannels();
    const int numOut = getTotalNumOutputChannels();
    const int n = buffer.getNumSamples();
    for (int c = numIn; c < numOut; ++c) buffer.clear (c, 0, n);

    engine.setParameters (pFeedback->load() * 0.01f,
                          pDenoise->load() * 0.01f,
                          pDereverb->load() * 0.01f,
                          pMute->load() > 0.5f,
                          pDeroom->load() * 0.01f);
    engine.setFeedbackTiming (pAttack->load(), pRelease->load(), juce::roundToInt (pRatio->load()) + 1);
    engine.setRestore (pRestore->load() * 0.01f);

    const int numCh = juce::jmin (numIn, 2, buffer.getNumChannels());
    meterChannels.store (juce::jmax (1, numCh), std::memory_order_relaxed);

    measure (inputMeter, buffer, numCh, n);
    engine.process (buffer.getArrayOfWritePointers(), numCh, n);
    measure (outputMeter, buffer, numCh, n);
}

void DefeedbackAudioProcessor::measure (Meter& m, const juce::AudioBuffer<float>& b, int numCh, int n) noexcept
{
    for (int c = 0; c < numCh; ++c)
    {
        const float pk = b.getMagnitude (c, 0, n);
        if (pk > m.peak[(size_t) c].load (std::memory_order_relaxed))
            m.peak[(size_t) c].store (pk, std::memory_order_relaxed);
        m.rms[(size_t) c].store (b.getRMSLevel (c, 0, n), std::memory_order_relaxed);
    }
}

juce::AudioProcessorEditor* DefeedbackAudioProcessor::createEditor()
{
    return new DefeedbackAudioProcessorEditor (*this);
}

void DefeedbackAudioProcessor::getStateInformation (juce::MemoryBlock& destData)
{
    if (auto xml = apvts.copyState().createXml())
        copyXmlToBinary (*xml, destData);
}

void DefeedbackAudioProcessor::setStateInformation (const void* data, int sizeInBytes)
{
    if (auto xml = getXmlFromBinary (data, sizeInBytes))
        if (xml->hasTagName (apvts.state.getType()))
            apvts.replaceState (juce::ValueTree::fromXml (*xml));
}

juce::AudioProcessor* JUCE_CALLTYPE createPluginFilter()
{
    return new DefeedbackAudioProcessor();
}
