package main

import (
	"math/rand"
	"testing"
	"time"
)

// the quick 2× gives the same picture as the general scaler (within rounding) and is faster
func TestScale2x(t *testing.T) {
	src := newFrame(1920, 1080)
	rand.New(rand.NewSource(1)).Read(src.Buf)
	a, b := newFrame(3840, 2160), newFrame(3840, 2160)
	t0 := time.Now()
	drawFramed(a, src, Rect{0, 0, 1, 1})
	fast := time.Since(t0)
	t0 = time.Now()
	scalePlane(b.Y(), b.W, b.H, src.Y(), src.W, src.H, Rect{0, 0, 1, 1})
	scalePlane(b.U(), b.W/2, b.H/2, src.U(), src.W/2, src.H/2, Rect{0, 0, 1, 1})
	scalePlane(b.V(), b.W/2, b.H/2, src.V(), src.W/2, src.H/2, Rect{0, 0, 1, 1})
	slow := time.Since(t0)
	worst := 0
	for i := range a.Buf {
		if d := absd(a.Buf[i], b.Buf[i]); d > worst {
			worst = d
		}
	}
	t.Logf("1080p → 4K: quick 2× %v, general %v, largest difference %d", fast, slow, worst)
	if worst > 2 {
		t.Errorf("the quick 2× differs by %d", worst)
	}
}
