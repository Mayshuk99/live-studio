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
	keeps the waiting sound near 60 ms.
*/
type Audio struct {
	mu      sync.Mutex
	buf     []float32 // stereo, interleaved
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
const targetSec = 0.06
const maxSec = 0.16

func newAudio() *Audio { return &Audio{inRate: 48000} }

func (a *Audio) push(samples []float32, ch int, rate float64) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if rate > 8000 && rate != a.inRate {
		a.inRate = rate
		a.started = false
	}
	if ch == 1 {
		for _, s := range samples {
			a.buf = append(a.buf, s, s)
		}
	} else {
		a.buf = append(a.buf, samples...)
	}
	a.gotAny = true
	frames := len(a.buf) / 2
	// far too much waiting (the window was busy, then sent everything at once): skip to the target now —
	// the moment already had a gap, and otherwise the sound would stay late for a minute (24 Nov: 190 ms)
	if float64(frames)-a.pos > maxSec*a.inRate {
		// far too much waiting (the window was busy, then sent a burst): skip to the target
		drop := int(float64(frames) - a.pos - targetSec*a.inRate)
		if drop > 0 {
			a.buf = a.buf[drop*2:]
			a.over++
		}
		a.pos = 0
	}
}

func cubic(p0, p1, p2, p3 float32, t float32) float32 {
	// Catmull-Rom
	a := -0.5*p0 + 1.5*p1 - 1.5*p2 + 0.5*p3
	b := p0 - 2.5*p1 + 2*p2 - 0.5*p3
	c := -0.5*p0 + 0.5*p2
	return ((a*t+b)*t+c)*t + p1
}

// n output frames (48 kHz stereo) as 16-bit little-endian PCM
func (a *Audio) pull(n int) []byte {
	out := make([]byte, n*4)
	a.mu.Lock()
	defer a.mu.Unlock()
	frames := len(a.buf) / 2
	waiting := float64(frames) - a.pos
	target := targetSec * a.inRate
	if !a.started {
		if waiting >= target {
			a.started = true
			a.level = waiting
		} else {
			return out // silence while the first sound arrives
		}
	}
	a.level += (waiting - a.level) * 0.01
	// keep the waiting sound near the target: ±0.2 % speed at most (inaudible)
	errv := (a.level - target) / target
	a.adj = math.Max(-0.002, math.Min(0.002, errv*0.0006))
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
		for c := 0; c < 2; c++ {
			i0 := ip - 1
			if i0 < 0 {
				i0 = 0
			}
			p0 := a.buf[i0*2+c]
			p1 := a.buf[ip*2+c]
			p2 := a.buf[(ip+1)*2+c]
			p3 := a.buf[(ip+2)*2+c]
			v := cubic(p0, p1, p2, p3, t)
			if v > 1 {
				v = 1
			} else if v < -1 {
				v = -1
			}
			s := int16(math.Round(float64(v) * 32767))
			binary.LittleEndian.PutUint16(out[i*4+c*2:], uint16(s))
		}
		a.pos += step
	}
	// forget what has been used (keep one sample before the read position)
	k := int(a.pos) - 1
	if k > 0 {
		a.buf = append(a.buf[:0], a.buf[k*2:]...)
		a.pos -= float64(k)
	}
	return out
}

func (a *Audio) stats() (ms float64, under, over int, ppm float64) {
	a.mu.Lock()
	defer a.mu.Unlock()
	w := float64(len(a.buf)/2) - a.pos
	if w < 0 {
		w = 0
	}
	ms = w / a.inRate * 1000
	under, over = a.under, a.over
	a.under, a.over = 0, 0
	return ms, under, over, a.adj * 1e6
}
