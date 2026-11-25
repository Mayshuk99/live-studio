package main

import "testing"

// an interlaced picture with movement (two moments woven line by line) is seen as combed; a progressive one,
// even with thin lines and text-like detail, is not
func TestCombScore(t *testing.T) {
	const W, H = 1920, 1080
	draw := func(f *Frame, shift int, weave bool) {
		Y := f.Y()
		for y := 0; y < H; y++ {
			s := 0
			if weave && y%2 == 1 {
				s = shift
			}
			for x := 0; x < W; x++ {
				v := 60
				// several moving bright bars, and some fixed fine detail
				if ((x+s)/120)%3 == 0 {
					v = 200
				}
				if y%97 == 0 || (x%300 < 3 && y%5 == 0) {
					v = 235
				}
				Y[y*W+x] = uint8(v)
			}
		}
	}
	p, i := newFrame(W, H), newFrame(W, H)
	draw(p, 0, false)
	draw(i, 24, true)
	cp, mp := combScore(p)
	ci, _ := combScore(i)
	t.Logf("progressive %.1f‰ · interlaced with movement %.1f‰ · brightness %.0f", cp, ci, mp)
	if cp > 2 || ci < 20 {
		t.Errorf("combing not told apart: progressive %.1f‰, interlaced %.1f‰", cp, ci)
	}
	b := newFrame(W, H)
	fillBlack(b)
	if _, m := combScore(b); m >= 20 {
		t.Errorf("black not seen as dark: %.1f", m)
	}
}
