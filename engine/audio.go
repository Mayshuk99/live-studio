package main

import (
	"encoding/binary"
	"math"
	"sync"
)

/*
Program sound from Live Studio's window (the mixer + limiter), at the sound card's own pace. The encoders get

	exactly the samples that belong to each output frame (48 kHz), so sound and picture can never drift apart.
	The small difference between the sound card's clock and the cameras' is absorbed by a gentle resampler that
	keeps the waiting sound near 400 ms.

	Why so much: the sound comes from the window, and the window can stall (a title appearing, a slide being drawn:
	60–400 ms in the 26 Nov logs). With 60 ms waiting every such stall was a gap in the stream's sound. Nobody hears
	this delay — it only goes to the encoders — and Live Studio delays the picture by the same amount (the encoders'
	-itsoffset, native-engine.js SOUND_RESERVE_EXTRA_MS), so lips and words stay together.
*/
type Audio struct {
	mu      sync.Mutex
	ch      int       // channels per frame: 2 = the program only; 2 × tracks when recording tracks are sent
	buf     []float32 // ch channels, interleaved: program L, R, then each recording track's L, R
	pos     float64   // read position in frames (fractional) from the start of buf
	inRate  float64
	adj     float64
	level   float64 // smoothed frames waiting (input rate)
	started bool
	under   int
	over    int
	gotAny  bool
	lastLen int
}

const outRate = 48000.0
const targetSec = 0.40 // keep in step with SOUND_RESERVE_EXTRA_MS in native-engine.js (= 400 − 60)
const maxSec = 1.20

func newAudio() *Audio { return &Audio{inRate: 48000, ch: 2} }

func (a *Audio) push(samples []float32, ch int, rate float64) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if rate > 8000 && rate != a.inRate {
		a.inRate = rate
		a.started = false
	}
	if ch < 1 {
		ch = 2
	}
	// recording tracks added or taken away: what is waiting is kept, re-laid to the new number of channels (no gap)
	if ch >= 2 && ch != a.ch {
		a.buf = relay(a.buf, a.ch, ch)
		a.ch = ch
	}
	if ch == 1 {
		for _, s := range samples {
			a.buf = append(a.buf, s, s)
			for c := 2; c < a.ch; c++ {
				a.buf = append(a.buf, 0)
			}
		}
	} else {
		a.buf = append(a.buf, samples[:len(samples)/ch*ch]...)
	}
	a.gotAny = true
	frames := len(a.buf) / a.ch
	// far too much waiting (the window was busy, then sent everything at once): skip to the target now —
	// the moment already had a gap, and otherwise the sound would stay late for a minute (24 Nov: 190 ms)
	if float64(frames)-a.pos > maxSec*a.inRate {
		drop := int(float64(frames) - a.pos - targetSec*a.inRate)
		if drop > 0 {
			a.buf = a.buf[drop*a.ch:]
			a.over++
		}
		a.pos = 0
	}
}

// interleaved samples with `from` channels per frame, laid out with `to` (extra channels silent, missing ones left out)
func relay(buf []float32, from, to int) []float32 {
	if from == to || from < 1 || to < 1 {
		return buf
	}
	n := len(buf) / from
	out := make([]float32, n*to)
	k := from
	if to < k {
		k = to
	}
	for i := 0; i < n; i++ {
		copy(out[i*to:i*to+k], buf[i*from:i*from+k])
	}
	return out
}

func cubic(p0, p1, p2, p3 float32, t float32) float32 {
	// Catmull-Rom
	a := -0.5*p0 + 1.5*p1 - 1.5*p2 + 0.5*p3
	b := p0 - 2.5*p1 + 2*p2 - 0.5*p3
	c := -0.5*p0 + 0.5*p2
	return ((a*t+b)*t+c)*t + p1
}

// n output frames (48 kHz) as 16-bit little-endian PCM, and how many channels each frame has
func (a *Audio) pull(n int) ([]byte, int) {
	a.mu.Lock()
	defer a.mu.Unlock()
	C := a.ch
	out := make([]byte, n*C*2)
	frames := len(a.buf) / C
	waiting := float64(frames) - a.pos
	target := targetSec * a.inRate
	if !a.started {
		if waiting >= target {
			a.started = true
			a.level = waiting
		} else {
			return out, C // silence while the first sound arrives
		}
	}
	a.level += (waiting - a.level) * 0.01
	// keep the waiting sound near the target: ±0.5 % speed at most (a twelfth of a semitone).
	// The picture is delayed to match the target, so sound that is short of it is early by the difference. With the gentle
	// ±0.03 % this had (27 Nov: 60–200 ms waiting instead of 400 after the window lost some sound at the start) getting
	// back took a quarter of an hour; now about a minute.
	errv := (a.level - target) / target
	a.adj = math.Max(-0.005, math.Min(0.005, errv*0.02))
	step := a.inRate / outRate * (1 + a.adj)
	for i := 0; i < n; i++ {
		ip := int(a.pos)
		if ip+2 >= frames || ip < 1 {
			if ip < 1 && ip+2 < frames {
				// at the very start: use the first samples as neighbours
			} else {
				a.under++
				a.started = false
				break
			}
		}
		t := float32(a.pos - float64(ip))
		i0 := ip - 1
		if i0 < 0 {
			i0 = 0
		}
		for c := 0; c < C; c++ {
			p0 := a.buf[i0*C+c]
			p1 := a.buf[ip*C+c]
			p2 := a.buf[(ip+1)*C+c]
			p3 := a.buf[(ip+2)*C+c]
			v := cubic(p0, p1, p2, p3, t)
			if v > 1 {
				v = 1
			} else if v < -1 {
				v = -1
			}
			s := int16(math.Round(float64(v) * 32767))
			binary.LittleEndian.PutUint16(out[(i*C+c)*2:], uint16(s))
		}
		a.pos += step
	}
	// forget what has been used (keep one sample before the read position)
	k := int(a.pos) - 1
	if k > 0 {
		a.buf = append(a.buf[:0], a.buf[k*C:]...)
		a.pos -= float64(k)
	}
	return out, C
}

func (a *Audio) stats() (ms float64, under, over int, ppm float64) {
	a.mu.Lock()
	defer a.mu.Unlock()
	w := float64(len(a.buf)/a.ch) - a.pos
	if w < 0 {
		w = 0
	}
	ms = w / a.inRate * 1000
	under, over = a.under, a.over
	a.under, a.over = 0, 0
	return ms, under, over, a.adj * 1e6
}
