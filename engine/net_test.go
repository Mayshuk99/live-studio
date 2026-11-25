package main

import (
	"testing"
	"time"
)

// a network source's frame time is learned from three seconds of counted frames, snapped to the usual rates
func TestLearnPeriod(t *testing.T) {
	per := func(f float64) time.Duration { return time.Duration(float64(time.Second) / f) }
	cases := []struct {
		h    [3]float64
		want time.Duration
	}{
		{[3]float64{30, 29, 30}, per(29.97)},
		{[3]float64{60, 59, 60}, per(59.94)},
		{[3]float64{25, 25, 25}, per(25)},
		{[3]float64{0, 30, 30}, 0},  // just connected: not steady yet
		{[3]float64{30, 45, 60}, 0}, // all over the place
		{[3]float64{12, 12, 12}, per(12)},
	}
	for _, c := range cases {
		if got := learnPeriod(c.h); got != c.want {
			t.Errorf("%v: got %v, want %v", c.h, got, c.want)
		}
	}
}
