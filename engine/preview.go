package main

import "sync"

/* ---------- pictures of the cameras for the window's monitors ----------

   Made smaller the way a photo editor does it: every small pixel is the average of the whole area of the camera
   picture it covers (so fine detail, text and edges stay clean instead of shimmering), or blended from its four
   neighbours when the picture is made bigger. Sent as YUV 4:2:0 — 1.5 bytes a pixel instead of 4 for RGBA — laid out
   for one single-channel texture of w × h·3/2:

     rows 0 … h-1          Y  (w wide)
     rows h … h + h/2 - 1  U in the left half, V in the right half (w/2 wide each)

   The window's graphics card turns it into colour (renderer/engine.js, u_yuv). */

// how one output pixel along a line is made: input pixels start … start+len(w)-1, weights summing to 1<<12
type taps struct {
	start []int32
	off   []int32 // where this pixel's weights begin in w
	cnt   []int32
	w     []int32
}

const tapBits = 12

var (
	tapMu    sync.Mutex
	tapCache = map[[2]int]*taps{}
)

func tapsFor(src, dst int) *taps {
	k := [2]int{src, dst}
	tapMu.Lock()
	t := tapCache[k]
	tapMu.Unlock()
	if t != nil {
		return t
	}
	t = makeTaps(src, dst)
	tapMu.Lock()
	if len(tapCache) > 64 {
		tapCache = map[[2]int]*taps{}
	}
	tapCache[k] = t
	tapMu.Unlock()
	return t
}

func makeTaps(src, dst int) *taps {
	t := &taps{start: make([]int32, dst), off: make([]int32, dst), cnt: make([]int32, dst)}
	r := float64(src) / float64(dst)
	one := float64(int(1) << tapBits)
	for x := 0; x < dst; x++ {
		var idx []int
		var wf []float64
		if r >= 1 { // smaller: the area [x·r, (x+1)·r) of the input
			a, b := float64(x)*r, float64(x+1)*r
			for i := int(a); float64(i) < b && i < src; i++ {
				lo, hi := float64(i), float64(i+1)
				if lo < a {
					lo = a
				}
				if hi > b {
					hi = b
				}
				if hi-lo > 1e-9 {
					idx = append(idx, i)
					wf = append(wf, (hi-lo)/r)
				}
			}
		} else { // bigger: between the two nearest input pixels
			p := (float64(x)+0.5)*r - 0.5
			i0 := int(p)
			if p < 0 {
				i0, p = 0, 0
			}
			f := p - float64(i0)
			i1 := i0 + 1
			if i1 >= src {
				i1, f = src-1, 0
				if i0 >= src {
					i0 = src - 1
				}
			}
			idx = append(idx, i0)
			wf = append(wf, 1-f)
			if f > 1e-9 && i1 != i0 {
				idx = append(idx, i1)
				wf = append(wf, f)
			}
		}
		// whole-number weights that add up exactly
		w := make([]int32, len(wf))
		sum, big := int32(0), 0
		for i, v := range wf {
			w[i] = int32(v*one + 0.5)
			sum += w[i]
			if w[i] > w[big] {
				big = i
			}
		}
		if len(w) > 0 {
			w[big] += int32(one) - sum
		}
		t.start[x] = int32(idx[0])
		t.off[x] = int32(len(t.w))
		t.cnt[x] = int32(len(w))
		t.w = append(t.w, w...)
	}
	return t
}

// resize one plane (sw × sh, rows sstride apart) into dw × dh at dst[doff …], rows dstride apart
func resizePlane(src []byte, sw, sh, sstride int, dst []byte, doff, dw, dh, dstride int) {
	if sw == dw && sh == dh {
		parallel(dh, func(y0, y1 int) {
			for y := y0; y < y1; y++ {
				copy(dst[doff+y*dstride:doff+y*dstride+dw], src[y*sstride:y*sstride+sw])
			}
		})
		return
	}
	tx, ty := tapsFor(sw, dw), tapsFor(sh, dh)
	const round = int64(1) << (2*tapBits - 1)
	parallel(dh, func(y0, y1 int) {
		for y := y0; y < y1; y++ {
			ys, yo, yn := int(ty.start[y]), int(ty.off[y]), int(ty.cnt[y])
			row := dst[doff+y*dstride : doff+y*dstride+dw]
			for x := 0; x < dw; x++ {
				xs, xo, xn := int(tx.start[x]), int(tx.off[x]), int(tx.cnt[x])
				wx := tx.w[xo : xo+xn]
				var acc int64
				for j := 0; j < yn; j++ {
					line := src[(ys+j)*sstride+xs : (ys+j)*sstride+xs+xn]
					var s int32
					for i, w := range wx {
						s += w * int32(line[i])
					}
					acc += int64(s) * int64(ty.w[yo+j])
				}
				v := (acc + round) >> (2 * tapBits)
				if v > 255 {
					v = 255
				}
				row[x] = uint8(v)
			}
		}
	})
}

// the camera picture f as a pw × ph YUV picture in the layout above; out must hold pw·ph·3/2 bytes (pw, ph even)
func toYUVSmall(f *Frame, pw, ph int, out []byte) {
	W, H := f.W, f.H
	resizePlane(f.Y(), W, H, W, out, 0, pw, ph, pw)
	n := pw * ph
	resizePlane(f.U(), W/2, H/2, W/2, out, n, pw/2, ph/2, pw)
	resizePlane(f.V(), W/2, H/2, W/2, out, n+pw/2, pw/2, ph/2, pw)
}
