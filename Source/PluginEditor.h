#pragma once

#include <juce_audio_processors/juce_audio_processors.h>
#include <juce_gui_basics/juce_gui_basics.h>
#include "PluginProcessor.h"

//==============================================================================
class DfbLookAndFeel : public juce::LookAndFeel_V4
{
public:
    DfbLookAndFeel();
    void drawRotarySlider (juce::Graphics&, int x, int y, int w, int h, float pos,
                           float startAngle, float endAngle, juce::Slider&) override;
    void drawToggleButton (juce::Graphics&, juce::ToggleButton&, bool highlighted, bool down) override;
};

//==============================================================================
// Spectrum of the input with markers on every frequency where feedback was detected
class SpectrumView : public juce::Component
{
public:
    explicit SpectrumView (DefeedbackAudioProcessor& p) : proc (p) {}
    void paint (juce::Graphics&) override;

private:
    float xForFreq (juce::Rectangle<float> r, float f) const;
    float yForDb (juce::Rectangle<float> r, float db) const;
    DefeedbackAudioProcessor& proc;
};

//==============================================================================
// Table of problem frequencies: Hz, cut in dB, number of detections
class NotchList : public juce::Component
{
public:
    explicit NotchList (DefeedbackAudioProcessor& p) : proc (p) {}
    void paint (juce::Graphics&) override;

private:
    DefeedbackAudioProcessor& proc;
};

//==============================================================================
class DefeedbackAudioProcessorEditor : public juce::AudioProcessorEditor, private juce::Timer
{
public:
    explicit DefeedbackAudioProcessorEditor (DefeedbackAudioProcessor&);
    ~DefeedbackAudioProcessorEditor() override;

    void paint (juce::Graphics&) override;
    void resized() override;

private:
    void timerCallback() override;
    void setupKnob (juce::Slider& s, juce::Label& l, const juce::String& name);

    DefeedbackAudioProcessor& proc;
    DfbLookAndFeel lnf;

    SpectrumView spectrum;
    NotchList notchList;

    juce::Slider feedbackKnob, denoiseKnob, dereverbKnob;
    juce::Label feedbackLabel, denoiseLabel, dereverbLabel;
    juce::ToggleButton muteButton { "MUTE" };
    juce::TextButton clearButton { "Clear notches" };

    using SliderAttachment = juce::AudioProcessorValueTreeState::SliderAttachment;
    using ButtonAttachment = juce::AudioProcessorValueTreeState::ButtonAttachment;
    std::unique_ptr<SliderAttachment> feedbackAtt, denoiseAtt, dereverbAtt;
    std::unique_ptr<ButtonAttachment> muteAtt;

    float shownReduction = 0.0f;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (DefeedbackAudioProcessorEditor)
};
