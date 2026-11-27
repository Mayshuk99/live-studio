#include "PluginEditor.h"

namespace Colours
{
    const juce::Colour background   { 0xff1e2228 };
    const juce::Colour panel        { 0xff272c34 };
    const juce::Colour panelEdge    { 0xff3a414c };
    const juce::Colour text         { 0xffe6e9ee };
    const juce::Colour textDim      { 0xff8a93a0 };
    const juce::Colour grid         { 0xff343b45 };
    const juce::Colour spectrum     { 0xff5aa9e6 };   // input (unprocessed)
    const juce::Colour output       { 0xff7cf08a };   // output (processed)
    const juce::Colour feedback     { 0xffff5a4e };   // problem frequencies
    const juce::Colour filterCurve  { 0xffffb347 };
    const juce::Colour knobFeedback { 0xffff6b5e };
    const juce::Colour knobNoise    { 0xff5aa9e6 };
    const juce::Colour knobReverb   { 0xff9b7bea };
    const juce::Colour knobRoom     { 0xff3cc8b4 };
    const juce::Colour knobRestore  { 0xffe8c547 };
}

static juce::String freqText (float f)
{
    if (f >= 1000.0f) return juce::String (f / 1000.0f, f >= 10000.0f ? 1 : 2) + " kHz";
    return juce::String (juce::roundToInt (f)) + " Hz";
}

//==============================================================================
DfbLookAndFeel::DfbLookAndFeel()
{
    setColour (juce::Slider::textBoxTextColourId, Colours::text);
    setColour (juce::Slider::textBoxOutlineColourId, juce::Colours::transparentBlack);
    setColour (juce::Slider::textBoxBackgroundColourId, juce::Colours::transparentBlack);
    setColour (juce::Label::textColourId, Colours::text);
    setColour (juce::TextButton::buttonColourId, Colours::panel);
    setColour (juce::TextButton::textColourOffId, Colours::text);
    setColour (juce::ComboBox::outlineColourId, Colours::panelEdge);
}

void DfbLookAndFeel::drawRotarySlider (juce::Graphics& g, int x, int y, int w, int h, float pos,
                                       float startAngle, float endAngle, juce::Slider& s)
{
    const auto accent = s.findColour (juce::Slider::rotarySliderFillColourId);
    const auto bounds = juce::Rectangle<float> ((float) x, (float) y, (float) w, (float) h).reduced (6.0f);
    const float radius = juce::jmin (bounds.getWidth(), bounds.getHeight()) * 0.5f;
    const auto centre = bounds.getCentre();
    const float track = juce::jmax (4.0f, radius * 0.12f);
    const float angle = startAngle + pos * (endAngle - startAngle);

    juce::Path bg;
    bg.addCentredArc (centre.x, centre.y, radius - track, radius - track, 0.0f, startAngle, endAngle, true);
    g.setColour (Colours::grid);
    g.strokePath (bg, juce::PathStrokeType (track, juce::PathStrokeType::curved, juce::PathStrokeType::rounded));

    if (pos > 0.0f)
    {
        juce::Path arc;
        arc.addCentredArc (centre.x, centre.y, radius - track, radius - track, 0.0f, startAngle, angle, true);
        g.setColour (accent);
        g.strokePath (arc, juce::PathStrokeType (track, juce::PathStrokeType::curved, juce::PathStrokeType::rounded));
    }

    const float knobR = radius - track * 2.2f;
    g.setColour (Colours::panel.brighter (0.15f));
    g.fillEllipse (centre.x - knobR, centre.y - knobR, knobR * 2.0f, knobR * 2.0f);
    g.setColour (Colours::panelEdge);
    g.drawEllipse (centre.x - knobR, centre.y - knobR, knobR * 2.0f, knobR * 2.0f, 1.0f);

    juce::Path pointer;
    pointer.addRoundedRectangle (-2.0f, -knobR + 4.0f, 4.0f, knobR * 0.45f, 2.0f);
    pointer.applyTransform (juce::AffineTransform::rotation (angle).translated (centre));
    g.setColour (Colours::text);
    g.fillPath (pointer);
}

void DfbLookAndFeel::drawToggleButton (juce::Graphics& g, juce::ToggleButton& b, bool highlighted, bool)
{
    auto r = b.getLocalBounds().toFloat().reduced (2.0f);
    const bool on = b.getToggleState();
    g.setColour (on ? juce::Colour (0xffd64541) : Colours::panel.brighter (highlighted ? 0.1f : 0.0f));
    g.fillRoundedRectangle (r, 6.0f);
    g.setColour (on ? juce::Colour (0xffd64541).brighter (0.3f) : Colours::panelEdge);
    g.drawRoundedRectangle (r, 6.0f, 1.0f);
    g.setColour (Colours::text);
    g.setFont (juce::FontOptions (15.0f, juce::Font::bold));
    g.drawText (b.getButtonText(), r, juce::Justification::centred);
}

//==============================================================================
float SpectrumView::xForFreq (juce::Rectangle<float> r, float f) const
{
    return r.getX() + r.getWidth() * std::log (juce::jlimit (20.0f, 20000.0f, f) / 20.0f) / std::log (1000.0f);
}

float SpectrumView::yForDb (juce::Rectangle<float> r, float db) const
{
    return juce::jmap (juce::jlimit (-100.0f, 0.0f, db), -100.0f, 0.0f, r.getBottom(), r.getY());
}

SpectrumView::SpectrumView (DefeedbackAudioProcessor& p) : proc (p)
{
    inS.fill (-120.0f);
    outS.fill (-120.0f);
    smoothSlider.setSliderStyle (juce::Slider::LinearHorizontal);
    smoothSlider.setRange (0.0, 100.0, 1.0);
    smoothSlider.setTextBoxStyle (juce::Slider::TextBoxRight, false, 40, 16);
    smoothSlider.setTextValueSuffix (" %");
    smoothSlider.setColour (juce::Slider::trackColourId, Colours::spectrum);
    smoothSlider.setColour (juce::Slider::thumbColourId, Colours::text);
    smoothSlider.setColour (juce::Slider::backgroundColourId, Colours::grid);
    smoothSlider.setTooltip ("Graph smoothing: 0 % = instant, 100 % = very smooth (about 2 s)");
    smoothSlider.setValue ((double) proc.apvts.state.getProperty ("graphSmoothing", 30.0), juce::dontSendNotification);
    smoothSlider.onValueChange = [this] { proc.apvts.state.setProperty ("graphSmoothing", smoothSlider.getValue(), nullptr); };
    smoothSlider.setDoubleClickReturnValue (true, 30.0);
    addAndMakeVisible (smoothSlider);
    smoothLabel.setText ("SMOOTHING", juce::dontSendNotification);
    smoothLabel.setFont (juce::FontOptions (10.5f, juce::Font::bold));
    smoothLabel.setColour (juce::Label::textColourId, Colours::textDim);
    smoothLabel.setJustificationType (juce::Justification::centredRight);
    addAndMakeVisible (smoothLabel);
}

void SpectrumView::resized()
{
    auto top = getLocalBounds().reduced (10, 2).removeFromTop (18);
    smoothSlider.setBounds (top.removeFromRight (170));
    smoothLabel.setBounds (top.removeFromRight (70));
}

void SpectrumView::tick (float dt)
{
    // 0 % -> no extra smoothing, 100 % -> ~2 s time constant (logarithmic in between)
    const float v = (float) smoothSlider.getValue() / 100.0f;
    const float tau = v <= 0.001f ? 0.0f : 0.02f * std::pow (100.0f, v);
    const float a = tau <= 0.0f ? 1.0f : 1.0f - std::exp (-dt / tau);
    auto& fb = proc.engine.feedback;
    for (int i = 0; i < dfb::FeedbackSuppressor::kDisplayPoints; ++i)
    {
        const float ti = fb.getDisplayDb (i), to = proc.engine.outputSpectrum.getDisplayDb (i);
        inS[(size_t) i] = primed ? inS[(size_t) i] + a * (ti - inS[(size_t) i]) : ti;
        outS[(size_t) i] = primed ? outS[(size_t) i] + a * (to - outS[(size_t) i]) : to;
    }
    primed = true;
    repaint();
}

void SpectrumView::paint (juce::Graphics& g)
{
    auto area = getLocalBounds().toFloat();
    g.setColour (Colours::panel);
    g.fillRoundedRectangle (area, 8.0f);
    g.setColour (Colours::panelEdge);
    g.drawRoundedRectangle (area.reduced (0.5f), 8.0f, 1.0f);

    auto plot = area.reduced (36.0f, 22.0f).withTrimmedRight (-24.0f);
    auto& fb = proc.engine.feedback;
    const double sr = proc.getCurrentSampleRate();

    // grid
    g.setFont (juce::FontOptions (11.0f));
    for (float f : { 50.0f, 100.0f, 200.0f, 500.0f, 1000.0f, 2000.0f, 5000.0f, 10000.0f, 20000.0f })
    {
        const float x = xForFreq (plot, f);
        g.setColour (Colours::grid);
        g.drawVerticalLine ((int) x, plot.getY(), plot.getBottom());
        g.setColour (Colours::textDim);
        const auto label = f >= 1000.0f ? juce::String ((int) (f / 1000.0f)) + "k" : juce::String ((int) f);
        g.drawText (label, juce::Rectangle<float> (x - 20.0f, plot.getBottom() + 3.0f, 40.0f, 14.0f), juce::Justification::centred);
    }
    for (float db : { -20.0f, -40.0f, -60.0f, -80.0f })
    {
        const float y = yForDb (plot, db);
        g.setColour (Colours::grid);
        g.drawHorizontalLine ((int) y, plot.getX(), plot.getRight());
        g.setColour (Colours::textDim);
        g.drawText (juce::String ((int) db), juce::Rectangle<float> (area.getX() + 2.0f, y - 7.0f, 30.0f, 14.0f), juce::Justification::centredRight);
    }

    // spectrum
    juce::Path line, fill;
    for (int i = 0; i < dfb::FeedbackSuppressor::kDisplayPoints; ++i)
    {
        const float x = xForFreq (plot, dfb::FeedbackSuppressor::displayFreq (i));
        const float y = yForDb (plot, inS[(size_t) i]);
        if (i == 0) { line.startNewSubPath (x, y); fill.startNewSubPath (x, plot.getBottom()); }
        else line.lineTo (x, y);
        fill.lineTo (x, y);
    }
    fill.lineTo (plot.getRight(), plot.getBottom());
    fill.closeSubPath();
    g.setGradientFill (juce::ColourGradient (Colours::spectrum.withAlpha (0.35f), 0.0f, plot.getY(),
                                             Colours::spectrum.withAlpha (0.02f), 0.0f, plot.getBottom(), false));
    g.fillPath (fill);
    g.setColour (Colours::spectrum.withAlpha (0.9f));
    g.strokePath (line, juce::PathStrokeType (1.3f));

    // processed output on top of the input
    {
        juce::Path outLine;
        for (int i = 0; i < dfb::SpectrumAnalyzer::kDisplayPoints; ++i)
        {
            const float x = xForFreq (plot, dfb::FeedbackSuppressor::displayFreq (i));
            const float y = yForDb (plot, outS[(size_t) i]);
            if (i == 0) outLine.startNewSubPath (x, y); else outLine.lineTo (x, y);
        }
        g.setColour (juce::Colours::black.withAlpha (0.35f));
        g.strokePath (outLine, juce::PathStrokeType (3.5f));
        g.setColour (Colours::output);
        g.strokePath (outLine, juce::PathStrokeType (1.8f));
    }

    // combined notch filter curve (0 dB at the top, 3 px per dB)
    bool anyNotch = false;
    for (int k = 0; k < dfb::FeedbackSuppressor::kMaxNotches; ++k)
        anyNotch |= fb.getNotchInfo (k).freq.load() > 0.0f;

    if (anyNotch)
    {
        juce::Path curve;
        const int pts = 400;
        for (int i = 0; i < pts; ++i)
        {
            const float f = 20.0f * std::pow (1000.0f, (float) i / (pts - 1));
            float totalDb = 0.0f;
            for (int k = 0; k < dfb::FeedbackSuppressor::kMaxNotches; ++k)
            {
                auto& ni = fb.getNotchInfo (k);
                totalDb += dfb::FeedbackSuppressor::notchResponseDb (f, ni.freq.load(), ni.depthDb.load(), sr);
            }
            const float x = xForFreq (plot, f);
            const float y = plot.getY() + juce::jmin (-totalDb, 40.0f) * 3.0f;
            if (i == 0) curve.startNewSubPath (x, y); else curve.lineTo (x, y);
        }
        g.setColour (Colours::filterCurve);
        g.strokePath (curve, juce::PathStrokeType (1.8f));
    }

    // problem-frequency markers
    g.setFont (juce::FontOptions (11.0f, juce::Font::bold));
    float lastLabelX = -1000.0f;
    int labelRow = 0;
    for (int k = 0; k < dfb::FeedbackSuppressor::kMaxNotches; ++k)
    {
        auto& ni = fb.getNotchInfo (k);
        const float f = ni.freq.load();
        if (f <= 0.0f) continue;
        const float x = xForFreq (plot, f);
        g.setColour (Colours::feedback.withAlpha (0.8f));
        g.drawLine (x, plot.getY(), x, plot.getBottom(), 1.5f);

        labelRow = std::abs (x - lastLabelX) < 60.0f ? (labelRow + 1) % 3 : 0;
        lastLabelX = x;
        auto box = juce::Rectangle<float> (x - 28.0f, plot.getBottom() - 18.0f - labelRow * 17.0f, 56.0f, 15.0f);
        g.setColour (Colours::feedback);
        g.fillRoundedRectangle (box, 3.0f);
        g.setColour (juce::Colours::white);
        g.drawText (freqText (f), box, juce::Justification::centred);
    }

    // legend
    g.setFont (juce::FontOptions (11.0f, juce::Font::bold));
    auto legend = area.reduced (10.0f, 4.0f).removeFromTop (14.0f);
    auto item = [&g, &legend] (juce::Colour c, const juce::String& text, float w) {
        auto r = legend.removeFromLeft (w);
        g.setColour (c);
        g.fillRoundedRectangle (r.removeFromLeft (14.0f).reduced (0.0f, 5.0f), 1.5f);
        r.removeFromLeft (4.0f);
        g.drawText (text, r, juce::Justification::centredLeft);
    };
    item (Colours::spectrum, "INPUT", 66.0f);
    item (Colours::output, "OUTPUT", 76.0f);
    item (Colours::filterCurve, "NOTCHES", 82.0f);
    item (Colours::feedback, "FEEDBACK", 86.0f);
}

//==============================================================================
void NotchList::paint (juce::Graphics& g)
{
    auto area = getLocalBounds().toFloat();
    g.setColour (Colours::panel);
    g.fillRoundedRectangle (area, 8.0f);
    g.setColour (Colours::panelEdge);
    g.drawRoundedRectangle (area.reduced (0.5f), 8.0f, 1.0f);

    auto r = area.reduced (10.0f, 8.0f);
    g.setColour (Colours::text);
    g.setFont (juce::FontOptions (13.0f, juce::Font::bold));
    g.drawText ("FEEDBACK FREQUENCIES", r.removeFromTop (18.0f), juce::Justification::centredLeft);

    g.setFont (juce::FontOptions (11.0f));
    g.setColour (Colours::textDim);
    auto header = r.removeFromTop (16.0f);
    g.drawText ("Frequency", header.withWidth (header.getWidth() * 0.45f), juce::Justification::centredLeft);
    g.drawText ("Cut", header.withTrimmedLeft (header.getWidth() * 0.45f).withWidth (header.getWidth() * 0.35f), juce::Justification::centredLeft);
    g.drawText ("Hits", header, juce::Justification::centredRight);
    r.removeFromTop (2.0f);

    struct Row { float f, d; int h; };
    std::vector<Row> rows;
    auto& fb = proc.engine.feedback;
    for (int k = 0; k < dfb::FeedbackSuppressor::kMaxNotches; ++k)
    {
        auto& ni = fb.getNotchInfo (k);
        if (ni.freq.load() > 0.0f) rows.push_back ({ ni.freq.load(), ni.depthDb.load(), ni.hits.load() });
    }
    std::sort (rows.begin(), rows.end(), [] (auto& a, auto& b) { return a.f < b.f; });

    if (rows.empty())
    {
        g.setColour (Colours::textDim);
        g.setFont (juce::FontOptions (12.0f));
        g.drawText ("No feedback detected", r.removeFromTop (24.0f), juce::Justification::centredLeft);
        return;
    }

    const float rowH = juce::jmin (20.0f, r.getHeight() / (float) dfb::FeedbackSuppressor::kMaxNotches);
    g.setFont (juce::FontOptions (juce::jmin (12.5f, rowH * 0.7f)));
    for (auto& row : rows)
    {
        auto line = r.removeFromTop (rowH);
        const float barW = line.getWidth() * 0.35f;
        auto cutArea = line.withTrimmedLeft (line.getWidth() * 0.45f).withWidth (barW);

        g.setColour (Colours::feedback);
        g.fillEllipse (line.getX(), line.getCentreY() - 3.0f, 6.0f, 6.0f);
        g.setColour (Colours::text);
        g.drawText (freqText (row.f), line.withTrimmedLeft (12.0f).withWidth (line.getWidth() * 0.45f - 12.0f), juce::Justification::centredLeft);

        g.setColour (Colours::grid);
        g.fillRoundedRectangle (cutArea.reduced (0.0f, rowH * 0.25f), 2.0f);
        g.setColour (Colours::feedback.withAlpha (0.85f));
        g.fillRoundedRectangle (cutArea.reduced (0.0f, rowH * 0.25f).withWidth (barW * juce::jlimit (0.0f, 1.0f, row.d / 30.0f)), 2.0f);
        g.setColour (Colours::text);
        g.drawText ("-" + juce::String (row.d, 1) + " dB", cutArea, juce::Justification::centred);

        g.drawText (juce::String (row.h), line, juce::Justification::centredRight);
    }
}

//==============================================================================
static float toDb (float lin) { return lin > 1.0e-5f ? 20.0f * std::log10 (lin) : -100.0f; }

void LevelMeter::update()
{
    const int chans = juce::jlimit (1, 2, proc.meterChannels.load());
    for (int c = 0; c < 2; ++c)
    {
        const float pk = c < chans ? toDb (meter.peak[(size_t) c].exchange (0.0f)) : -100.0f;
        const float rm = c < chans ? toDb (meter.rms[(size_t) c].load()) : -100.0f;

        peakDb[(size_t) c] = juce::jmax (pk, peakDb[(size_t) c] - 1.2f);       // ~36 dB/s fall
        rmsDb[(size_t) c] = rm > rmsDb[(size_t) c] ? rm : rmsDb[(size_t) c] * 0.85f + rm * 0.15f;

        if (pk >= holdDb[(size_t) c]) { holdDb[(size_t) c] = pk; holdFrames[(size_t) c] = 45; }   // 1.5 s hold
        else if (--holdFrames[(size_t) c] <= 0) holdDb[(size_t) c] = juce::jmax (-100.0f, holdDb[(size_t) c] - 1.5f);

        if (pk >= -0.1f) clip[(size_t) c] = true;
    }
    repaint();
}

float LevelMeter::yForDb (juce::Rectangle<float> r, float db) const
{
    return juce::jmap (juce::jlimit (-60.0f, 0.0f, db), -60.0f, 0.0f, r.getBottom(), r.getY());
}

void LevelMeter::paint (juce::Graphics& g)
{
    auto area = getLocalBounds().toFloat();
    g.setColour (Colours::panel);
    g.fillRoundedRectangle (area, 8.0f);
    g.setColour (Colours::panelEdge);
    g.drawRoundedRectangle (area.reduced (0.5f), 8.0f, 1.0f);

    auto r = area.reduced (6.0f, 6.0f);
    g.setColour (Colours::text);
    g.setFont (juce::FontOptions (13.0f, juce::Font::bold));
    g.drawText (name, r.removeFromTop (16.0f), juce::Justification::centred);

    auto readout = r.removeFromBottom (16.0f);
    auto leds = r.removeFromTop (8.0f);
    r.removeFromTop (3.0f);

    const int chans = juce::jlimit (1, 2, proc.meterChannels.load());
    auto scale = r.removeFromLeft (24.0f);
    r.removeFromLeft (2.0f);
    const float gap = 3.0f;
    const float barW = (r.getWidth() - gap * (float) (chans - 1)) / (float) chans;

    // scale
    g.setFont (juce::FontOptions (9.5f));
    for (float db : { 0.0f, -6.0f, -12.0f, -18.0f, -24.0f, -36.0f, -48.0f, -60.0f })
    {
        const float y = yForDb (r, db);
        g.setColour (Colours::textDim);
        g.drawText (juce::String ((int) db), juce::Rectangle<float> (scale.getX(), y - 6.0f, scale.getWidth(), 12.0f), juce::Justification::centredRight);
        g.setColour (Colours::grid);
        g.drawHorizontalLine ((int) y, r.getX(), r.getRight());
    }

    const juce::ColourGradient grad (juce::Colour (0xffff3b30), 0.0f, yForDb (r, 0.0f),
                                     juce::Colour (0xff34c759), 0.0f, yForDb (r, -60.0f), false);
    float maxHold = -100.0f;
    for (int c = 0; c < chans; ++c)
    {
        auto bar = juce::Rectangle<float> (r.getX() + (float) c * (barW + gap), r.getY(), barW, r.getHeight());
        g.setColour (Colours::background);
        g.fillRect (bar);

        auto grad2 = grad;
        grad2.addColour (0.10, juce::Colour (0xffff9500));   // -6 dB
        grad2.addColour (0.30, juce::Colour (0xffffcc00));   // -18 dB
        g.setGradientFill (grad2);
        const float yPk = yForDb (bar, peakDb[(size_t) c]);
        g.fillRect (bar.withTop (yPk));

        g.setColour (juce::Colours::white.withAlpha (0.85f));                       // RMS
        g.fillRect (bar.getX(), yForDb (bar, rmsDb[(size_t) c]) - 1.0f, bar.getWidth(), 2.0f);
        if (holdDb[(size_t) c] > -60.0f)
        {
            g.setColour (Colours::text);                                            // peak hold
            g.fillRect (bar.getX(), yForDb (bar, holdDb[(size_t) c]) - 1.0f, bar.getWidth(), 2.0f);
        }

        auto led = juce::Rectangle<float> (bar.getX(), leds.getY(), barW, leds.getHeight());
        g.setColour (clip[(size_t) c] ? juce::Colour (0xffff3b30) : Colours::grid);
        g.fillRoundedRectangle (led, 2.0f);
        maxHold = juce::jmax (maxHold, holdDb[(size_t) c]);
    }

    g.setColour (maxHold >= -0.1f ? juce::Colour (0xffff3b30) : Colours::text);
    g.setFont (juce::FontOptions (11.0f));
    g.drawText (maxHold <= -99.0f ? juce::String ("-inf") : juce::String (maxHold, 1) + " dB", readout, juce::Justification::centred);
}

//==============================================================================
FeedbackSettings::FeedbackSettings (DefeedbackAudioProcessor& p) : proc (p)
{
    ratioParam = dynamic_cast<juce::AudioParameterChoice*> (proc.apvts.getParameter ("fbRatio"));
    const char* names[] = { "1:1", "1:2", "1:3", "1:4" };
    for (int i = 0; i < 4; ++i)
    {
        auto& b = ratioButtons[(size_t) i];
        b.setButtonText (names[i]);
        b.setClickingTogglesState (false);
        b.setColour (juce::TextButton::buttonOnColourId, Colours::knobFeedback);
        b.setTooltip (i == 0 ? "1:1 - detect and show only, no cut" : "Cut = howl level above normal x (1 - 1/ratio)");
        b.onClick = [this, i] {
            if (ratioParam == nullptr) return;
            ratioParam->beginChangeGesture();
            *ratioParam = i;
            ratioParam->endChangeGesture();
            syncRatio();
        };
        addAndMakeVisible (b);
    }

    auto setupSmall = [this] (juce::Slider& s, juce::Label& l, const juce::String& text) {
        s.setSliderStyle (juce::Slider::RotaryHorizontalVerticalDrag);
        s.setTextBoxStyle (juce::Slider::TextBoxBelow, false, 70, 18);
        s.setRotaryParameters (juce::degreesToRadians (225.0f), juce::degreesToRadians (495.0f), true);
        s.setColour (juce::Slider::rotarySliderFillColourId, Colours::knobFeedback);
        addAndMakeVisible (s);
        l.setText (text, juce::dontSendNotification);
        l.setJustificationType (juce::Justification::centred);
        l.setFont (juce::FontOptions (11.5f, juce::Font::bold));
        l.setColour (juce::Label::textColourId, Colours::textDim);
        addAndMakeVisible (l);
    };
    setupSmall (attack, attackLabel, "ATTACK");
    setupSmall (release, releaseLabel, "RELEASE");
    attackAtt = std::make_unique<juce::AudioProcessorValueTreeState::SliderAttachment> (proc.apvts, "fbAttack", attack);
    releaseAtt = std::make_unique<juce::AudioProcessorValueTreeState::SliderAttachment> (proc.apvts, "fbRelease", release);
    attack.setDoubleClickReturnValue (true, 20.0);
    release.setDoubleClickReturnValue (true, 15.0);

    ratioLabel.setText ("RATIO", juce::dontSendNotification);
    ratioLabel.setFont (juce::FontOptions (11.5f, juce::Font::bold));
    ratioLabel.setColour (juce::Label::textColourId, Colours::textDim);
    addAndMakeVisible (ratioLabel);
    syncRatio();
}

void FeedbackSettings::syncRatio()
{
    const int idx = ratioParam != nullptr ? ratioParam->getIndex() : 3;
    for (int i = 0; i < 4; ++i)
        ratioButtons[(size_t) i].setToggleState (i == idx, juce::dontSendNotification);
}

void FeedbackSettings::paint (juce::Graphics& g)
{
    auto area = getLocalBounds().toFloat();
    g.setColour (Colours::panel);
    g.fillRoundedRectangle (area, 8.0f);
    g.setColour (Colours::panelEdge);
    g.drawRoundedRectangle (area.reduced (0.5f), 8.0f, 1.0f);
    g.setColour (Colours::text);
    g.setFont (juce::FontOptions (13.0f, juce::Font::bold));
    g.drawText ("DE-FEEDBACK SETTINGS", area.reduced (10.0f, 6.0f).removeFromTop (18.0f), juce::Justification::centredLeft);
}

void FeedbackSettings::resized()
{
    auto r = getLocalBounds().reduced (10, 6);
    r.removeFromTop (22);
    auto ratioRow = r.removeFromTop (26);
    ratioLabel.setBounds (ratioRow.removeFromLeft (48));
    const int bw = ratioRow.getWidth() / 4;
    for (int i = 0; i < 4; ++i)
        ratioButtons[(size_t) i].setBounds (ratioRow.removeFromLeft (bw).reduced (2, 0));
    r.removeFromTop (6);
    auto left = r.removeFromLeft (r.getWidth() / 2);
    attackLabel.setBounds (left.removeFromTop (14));
    attack.setBounds (left);
    releaseLabel.setBounds (r.removeFromTop (14));
    release.setBounds (r);
}

//==============================================================================
DefeedbackAudioProcessorEditor::DefeedbackAudioProcessorEditor (DefeedbackAudioProcessor& p)
    : AudioProcessorEditor (&p), proc (p), spectrum (p), notchList (p),
      inMeter (p, p.inputMeter, "IN"), outMeter (p, p.outputMeter, "OUT"), fbSettings (p)
{
    setLookAndFeel (&lnf);

    addAndMakeVisible (spectrum);
    addAndMakeVisible (notchList);
    addAndMakeVisible (inMeter);
    addAndMakeVisible (outMeter);
    addAndMakeVisible (fbSettings);

    setupKnob (feedbackKnob, feedbackLabel, "DE-FEEDBACK");
    setupKnob (denoiseKnob, denoiseLabel, "DE-NOISE");
    setupKnob (deroomKnob, deroomLabel, "DE-ROOM");
    setupKnob (dereverbKnob, dereverbLabel, "DE-REVERB");
    setupKnob (restoreKnob, restoreLabel, "VOICE RESTORE");
    restoreKnob.setColour (juce::Slider::rotarySliderFillColourId, Colours::knobRestore);
    restoreAtt = std::make_unique<SliderAttachment> (proc.apvts, "restore", restoreKnob);
    feedbackKnob.setColour (juce::Slider::rotarySliderFillColourId, Colours::knobFeedback);
    denoiseKnob.setColour (juce::Slider::rotarySliderFillColourId, Colours::knobNoise);
    dereverbKnob.setColour (juce::Slider::rotarySliderFillColourId, Colours::knobReverb);
    deroomKnob.setColour (juce::Slider::rotarySliderFillColourId, Colours::knobRoom);

    feedbackAtt = std::make_unique<SliderAttachment> (proc.apvts, "feedback", feedbackKnob);
    denoiseAtt  = std::make_unique<SliderAttachment> (proc.apvts, "denoise", denoiseKnob);
    dereverbAtt = std::make_unique<SliderAttachment> (proc.apvts, "dereverb", dereverbKnob);
    deroomAtt   = std::make_unique<SliderAttachment> (proc.apvts, "deroom", deroomKnob);

    addAndMakeVisible (muteButton);
    muteAtt = std::make_unique<ButtonAttachment> (proc.apvts, "mute", muteButton);

    addAndMakeVisible (clearButton);
    clearButton.onClick = [this] { proc.engine.feedback.requestClear(); };

    setResizable (true, true);
    setResizeLimits (1080, 620, 1900, 1250);
    setSize (1200, 700);
    startTimerHz (30);
}

DefeedbackAudioProcessorEditor::~DefeedbackAudioProcessorEditor()
{
    stopTimer();
    setLookAndFeel (nullptr);
}

void DefeedbackAudioProcessorEditor::setupKnob (juce::Slider& s, juce::Label& l, const juce::String& name)
{
    s.setSliderStyle (juce::Slider::RotaryHorizontalVerticalDrag);
    s.setTextBoxStyle (juce::Slider::TextBoxBelow, false, 80, 22);
    s.setTextValueSuffix (" %");
    s.setNumDecimalPlacesToDisplay (0);
    s.setRotaryParameters (juce::degreesToRadians (225.0f), juce::degreesToRadians (495.0f), true);
    s.setDoubleClickReturnValue (true, 0.0);
    addAndMakeVisible (s);

    l.setText (name, juce::dontSendNotification);
    l.setJustificationType (juce::Justification::centred);
    l.setFont (juce::FontOptions (15.0f, juce::Font::bold));
    addAndMakeVisible (l);
}

void DefeedbackAudioProcessorEditor::paint (juce::Graphics& g)
{
    g.fillAll (Colours::background);

    auto r = getLocalBounds().reduced (16, 10);
    auto title = r.removeFromTop (44);
    g.setColour (Colours::text);
    g.setFont (juce::FontOptions (26.0f, juce::Font::bold));
    g.drawText ("DE-FEEDBACK", title.removeFromLeft (240), juce::Justification::centredLeft);
    g.setColour (Colours::textDim);
    g.setFont (juce::FontOptions (14.0f));
    g.drawText ("Zero-Latency De-Feedback  +  De-Noise  +  De-Room  +  De-Reverb  +  Voice Restore", title, juce::Justification::centredLeft);

    // status line under the knobs
    auto status = getLocalBounds().reduced (16, 8).removeFromBottom (20);
    g.setFont (juce::FontOptions (12.0f));
    g.setColour (Colours::textDim);
    const int notches = proc.engine.feedback.getActiveNotchCount();
    g.drawText ("Active notches: " + juce::String (notches) + " / " + juce::String (dfb::FeedbackSuppressor::kMaxNotches)
                    + "      Noise / reverb reduction: " + juce::String (shownReduction, 1) + " dB"
                    + "      Room reverb (T60): " + (proc.engine.cleaner.getRoomT60() > 0.0f
                                                       ? juce::String (proc.engine.cleaner.getRoomT60(), 1) + " s" : juce::String ("measuring..."))
                    + "      Latency: 0 samples",
                status, juce::Justification::centredLeft);
}

void DefeedbackAudioProcessorEditor::resized()
{
    auto r = getLocalBounds().reduced (16, 10);
    r.removeFromTop (44);
    r.removeFromBottom (24);

    auto bottom = r.removeFromBottom (juce::jlimit (170, 260, getHeight() / 3));
    r.removeFromBottom (10);

    auto rightCol = r.removeFromRight (juce::jlimit (240, 320, getWidth() / 4));
    fbSettings.setBounds (rightCol.removeFromBottom (juce::jmin (150, rightCol.getHeight() / 2)));
    rightCol.removeFromBottom (8);
    notchList.setBounds (rightCol);
    r.removeFromRight (10);
    spectrum.setBounds (r);

    // meters | knobs | meters | buttons
    auto buttons = bottom.removeFromRight (150);
    outMeter.setBounds (bottom.removeFromRight (76).reduced (2, 0));
    bottom.removeFromRight (6);
    inMeter.setBounds (bottom.removeFromLeft (76).reduced (2, 0));
    bottom.removeFromLeft (6);
    const int knobW = bottom.getWidth() / 5;
    juce::Slider* knobs[] = { &feedbackKnob, &denoiseKnob, &deroomKnob, &dereverbKnob, &restoreKnob };
    juce::Label* labels[] = { &feedbackLabel, &denoiseLabel, &deroomLabel, &dereverbLabel, &restoreLabel };
    for (int i = 0; i < 5; ++i)
    {
        auto col = bottom.removeFromLeft (knobW).reduced (8, 4);
        labels[i]->setBounds (col.removeFromTop (24));
        knobs[i]->setBounds (col);
    }

    buttons = buttons.reduced (6, 20);
    muteButton.setBounds (buttons.removeFromTop (48));
    buttons.removeFromTop (14);
    clearButton.setBounds (buttons.removeFromTop (34));
}

void DefeedbackAudioProcessorEditor::timerCallback()
{
    const float gr = proc.engine.cleaner.getGainReductionDb();
    shownReduction = 0.8f * shownReduction + 0.2f * gr;
    inMeter.update();
    outMeter.update();
    fbSettings.syncRatio();
    spectrum.tick (1.0f / 30.0f);
    notchList.repaint();
    repaint (getLocalBounds().removeFromBottom (32));
}
