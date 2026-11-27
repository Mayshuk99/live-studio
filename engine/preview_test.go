package main

import (
	"testing"
	"time"
)

func fillPlanes(f *Frame, y, u, v func(x, yy int) uint8) {
	Y, U, V := f.Y(), f.U(), f.V()
	for yy := 0; yy < f.H; yy++ {
		for x := 0; x < f.W; x++ {
			Y[yy*f.W+x] = y(x, yy)
		}
	}
	for yy := 0; yy < f.H/2; yy++ {
		for x := 0; x < f.W/2; x++ {
			U[yy*(f.W/2)+x] = u(x, yy)
			V[yy*(f.W/2)+x] = v(x, yy)
		}
	}
}

func TestTapsAddUp(t *testing.T) {
	for _, c := range [][2]int{{1920, 384}, {1920, 640}, {1920, 960}, {1920, 1280}, {1280, 1280}, {1280, 1920}, {3840, 384}, {960, 640}, {1080, 216}, {7, 3}} {
		tp := makeTaps(c[0], c[1])
		for x := 0; x < c[1]; x++ {
			var s int32
			for _, w := range tp.w[tp.off[x] : tp.off[x]+tp.cnt[x]] {
				s += w
			}
			if s != 1<<tapBits {
				t.Fatalf("%v pixel %d: weights add up to %d", c, x, s)
			}
			if int(tp.start[x]+tp.cnt[x]) > c[0] {
				t.Fatalf("%v pixel %d reads past the line", c, x)
			}
		}
	}
}

func TestYUVSmallLayout(t *testing.T) {
	f := newFrame(1920, 1080)
	fillPlanes(f, func(x, y int) uint8 { return 180 }, func(x, y int) uint8 { return 90 }, func(x, y int) uint8 { return 200 })
	for _, sz := range [][2]int{{384, 216}, {640, 360}, {960, 540}, {1280, 720}, {1920, 1080}} {
		pw, ph := sz[0], sz[1]
		out := make([]byte, pw*ph*3/2)
		toYUVSmall(f, pw, ph, out)
		for i := 0; i < pw*ph; i++ {
			if out[i] != 180 {
				t.Fatalf("%dx%d: Y[%d]=%d", pw, ph, i, out[i])
			}
		}
		for cy := 0; cy < ph/2; cy++ {
			row := out[pw*ph+cy*pw:]
			for x := 0; x < pw/2; x++ {
				if row[x] != 90 || row[pw/2+x] != 200 {
					t.Fatalf("%dx%d: chroma row %d col %d = %d/%d", pw, ph, cy, x, row[x], row[pw/2+x])
				}
			}
		}
	}
}

// fine stripes (one pixel black, one white) must come out even grey, not as a pattern (that was the shimmer)
func TestYUVSmallAverages(t *testing.T) {
	f := newFrame(1920, 1080)
	fillPlanes(f, func(x, y int) uint8 {
		if (x+y)%2 == 0 {
			return 16
		}
		return 236
	}, func(x, y int) uint8 { return 128 }, func(x, y int) uint8 { return 128 })
	for _, sz := range [][2]int{{384, 216}, {640, 360}, {960, 540}} {
		pw, ph := sz[0], sz[1]
		r := 1920 / pw
		out := make([]byte, pw*ph*3/2)
		toYUVSmall(f, pw, ph, out)
		Y := f.Y()
		for y := 0; y < ph; y++ {
			for x := 0; x < pw; x++ {
				sum := 0
				for j := 0; j < r; j++ {
					for i := 0; i < r; i++ {
						sum += int(Y[(y*r+j)*1920+x*r+i])
					}
				}
				want := (sum + r*r/2) / (r * r)
				if d := int(out[y*pw+x]) - want; d < -1 || d > 1 {
					t.Fatalf("%dx%d: Y at %d,%d = %d, the area's average is %d", pw, ph, x, y, out[y*pw+x], want)
				}
			}
		}
	}
	// a left-to-right ramp keeps its shape
	fillPlanes(f, func(x, y int) uint8 { return uint8(x * 255 / 1919) }, func(x, y int) uint8 { return 128 }, func(x, y int) uint8 { return 128 })
	pw, ph := 1280, 720
	out := make([]byte, pw*ph*3/2)
	toYUVSmall(f, pw, ph, out)
	for x := 1; x < pw; x++ {
		if out[100*pw+x] < out[100*pw+x-1] {
			t.Fatalf("ramp goes down at %d", x)
		}
	}
	if out[100*pw] > 2 || out[100*pw+pw-1] < 253 {
		t.Fatalf("ramp ends %d … %d", out[100*pw], out[100*pw+pw-1])
	}
}

func TestYUVSmallSpeed(t *testing.T) {
	f := newFrame(1920, 1080)
	fillPlanes(f, func(x, y int) uint8 { return uint8(x ^ y) }, func(x, y int) uint8 { return uint8(x) }, func(x, y int) uint8 { return uint8(y) })
	for _, sz := range [][2]int{{384, 216}, {640, 360}, {960, 540}, {1280, 720}} {
		pw, ph := sz[0], sz[1]
		out := make([]byte, pw*ph*3/2)
		toYUVSmall(f, pw, ph, out)
		t0 := time.Now()
		const n = 30
		for i := 0; i < n; i++ {
			toYUVSmall(f, pw, ph, out)
		}
		t.Logf("%dx%d: %.2f ms a picture (%d threads)", pw, ph, float64(time.Since(t0).Microseconds())/1000/n, workers)
	}
}

// the fast ways give the same picture as the general one (within one level)
func TestFastPathsMatch(t *testing.T) {
	sw, sh := 1920, 1080
	src := make([]byte, sw*sh)
	for i := range src {
		src[i] = uint8((i*7919 + i/sw*31) % 251)
	}
	for _, d := range [][2]int{{960, 540}, {640, 360}, {384, 216}, {1280, 720}, {1000, 560}, {2400, 1350}} {
		dw, dh := d[0], d[1]
		fast := make([]byte, dw*dh)
		resizePlane(src, sw, sh, sw, fast, 0, dw, dh, dw)
		slow := make([]byte, dw*dh)
		tx, ty := makeTaps(sw, dw), makeTaps(sh, dh)
		for y := 0; y < dh; y++ {
			for x := 0; x < dw; x++ {
				var acc int64
				for j := 0; j < int(ty.cnt[y]); j++ {
					for i := 0; i < int(tx.cnt[x]); i++ {
						acc += int64(ty.w[int(ty.off[y])+j]) * int64(tx.w[int(tx.off[x])+i]) * int64(src[(int(ty.start[y])+j)*sw+int(tx.start[x])+i])
					}
				}
				slow[y*dw+x] = uint8((acc + 1<<23) >> 24)
			}
		}
		for i := range fast {
			if d := int(fast[i]) - int(slow[i]); d < -1 || d > 1 {
				t.Fatalf("%dx%d: pixel %d fast %d, exact %d", dw, dh, i, fast[i], slow[i])
			}
		}
	}
}
