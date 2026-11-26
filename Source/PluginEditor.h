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
// Vertical stereo level meter (peak bar, RMS line, peak hold, clip LED, dB readout)
class LevelMeter : public juce::Component
{
public:
    LevelMeter (DefeedbackAudioProcessor& p, DefeedbackAudioProcessor::Meter& m, const juce::String& title)
        : proc (p), meter (m), name (title) {}
    void update();                 // called from the editor timer (30 Hz)
    void paint (juce::Graphics&) override;
    void mouseDown (const juce::MouseEvent&) override { clip.fill (false); repaint(); }

private:
    float yForDb (juce::Rectangle<float> r, float db) const;
    DefeedbackAudioProcessor& proc;
    DefeedbackAudioProcessor::Meter& meter;
    juce::String name;
    std::array<float, 2> peakDb { -100.0f, -100.0f }, rmsDb { -100.0f, -100.0f }, holdDb { -100.0f, -100.0f };
    std::array<int, 2> holdFrames {};
    std::array<bool, 2> clip {};
};

//==============================================================================
// DE-FEEDBACK settings: ratio 1:1 .. 1:4, attack, release
class FeedbackSettings : public juce::Component
{
public:
    explicit FeedbackSettings (DefeedbackAudioProcessor&);
    void paint (juce::Graphics&) override;
    void resized() override;
    void syncRatio();          // called from the editor timer

private:
    DefeedbackAudioProcessor& proc;
    juce::AudioParameterChoice* ratioParam = nullptr;
    std::array<juce::TextButton, 4> ratioButtons;
    juce::Slider attack, release;
    juce::Label attackLabel, releaseLabel, ratioLabel;
    std::unique_ptr<juce::AudioProcessorValueTreeState::SliderAttachment> attackAtt, releaseAtt;
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
    juce::TooltipWindow tooltipWindow { this, 600 };

    SpectrumView spectrum;
    NotchList notchList;
    LevelMeter inMeter, outMeter;
    FeedbackSettings fbSettings;

    juce::Slider feedbackKnob, denoiseKnob, deroomKnob, dereverbKnob;
    juce::Label feedbackLabel, denoiseLabel, deroomLabel, dereverbLabel;
    juce::ToggleButton muteButton { "MUTE" };
    juce::TextButton clearButton { "Clear notches" };

    using SliderAttachment = juce::AudioProcessorValueTreeState::SliderAttachment;
    using ButtonAttachment = juce::AudioProcessorValueTreeState::ButtonAttachment;
    std::unique_ptr<SliderAttachment> feedbackAtt, denoiseAtt, deroomAtt, dereverbAtt;
    std::unique_ptr<ButtonAttachment> muteAtt;

    float shownReduction = 0.0f;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (DefeedbackAudioProcessorEditor)
};
