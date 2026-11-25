package main

import (
	"fmt"
	"math"
	"sync"
)

/* Green screen (chroma key) — the same maths as the window's shader and OBS's chroma key:
   distance of the pixel's colour (Cb, Cr) from the key colour, minus "similarity", over "smoothness" → how much
   of the picture is kept; over "spill" → how much colour is kept (the rest is turned grey, which takes the green
   glow off hair and edges). Works directly on the cameras' YUV: alpha is worked out per colour sample (half size),
   then spread smoothly over the full-size brightness. */

type Green struct {
	Cb, Cr, Sim, Smooth, Spill float64
	Bg                         *Base
	lut                        *keyLUT
}

// alpha and colour kept for every (U, V) pair, worked out once per key setting
type keyLUT struct{ a, s [65536]uint8 }

var (
	keyLUTMu    sync.Mutex
	keyLUTCache = map[string]*keyLUT{}
)

func greenOf(m Msg, key string) *Green {
	if m == nil || !m.has("cb") {
		return nil
	}
	g := &Green{Cb: m.num("cb"), Cr: m.num("cr"), Sim: 0.4, Smooth: 0.08, Spill: 0.1}
	if m.has("sim") {
		g.Sim = m.num("sim")
	}
	if m.has("smooth") {
		g.Smooth = m.num("smooth")
	}
	if m.has("spill") {
		g.Spill = m.num("spill")
	}
	g.Smooth = math.Max(g.Smooth, 0.001)
	g.Spill = math.Max(g.Spill, 0.001)
	if bg := baseOf(m.obj("bg")); bg != nil {
		bg.Key = "bg:" + key
		bg.Zoom, bg.X, bg.Y = 1, 0.5, 0.5
		g.Bg = bg
	}
	g.lut = lutFor(g)
	return g
}

func lutFor(g *Green) *keyLUT {
	k := fmt.Sprintf("%.4f/%.4f/%.4f/%.4f/%.4f", g.Cb, g.Cr, g.Sim, g.Smooth, g.Spill)
	keyLUTMu.Lock()
	defer keyLUTMu.Unlock()
	if L := keyLUTCache[k]; L != nil {
		return L
	}
	if len(keyLUTCache) > 32 {
		keyLUTCache = map[string]*keyLUT{}
	}
	L := &keyLUT{}
	for u := 0; u < 256; u++ {
		cb := (float64(u) - 128) / 224 // TV range: 16…240 → −0.5…+0.5
		for v := 0; v < 256; v++ {
			cr := (float64(v) - 128) / 224
			base := math.Hypot(cb-g.Cb, cr-g.Cr) - g.Sim
			a := math.Pow(math.Max(0, math.Min(1, base/g.Smooth)), 1.5)
			s := math.Pow(math.Max(0, math.Min(1, base/g.Spill)), 1.5)
			L.a[u<<8|v] = uint8(a*255 + 0.5)
			L.s[u<<8|v] = uint8(s*255 + 0.5)
		}
	}
	keyLUTCache[k] = L
	return L
}

// fg (keyed, colour-corrected with lut afterwards) over dst
func (e *Engine) keyOver(dst, fg *Frame, g *Green, lut *colorLUT) {
	W, H := dst.W, dst.H
	cw, ch := W/2, H/2
	n := cw * ch
	if cap(e.kA) < n {
		e.kA, e.kS = make([]byte, n), make([]byte, n)
	}
	kA, kS := e.kA[:n], e.kS[:n]
	L := g.lut
	fu, fv := fg.U(), fg.V()
	// 1. how much to keep, from the untouched picture
	parallel(ch, func(y0, y1 int) {
		for i := y0 * cw; i < y1*cw; i++ {
			k := int(fu[i])<<8 | int(fv[i])
			kA[i], kS[i] = L.a[k], L.s[k]
		}
	})
	if lut != nil {
		applyColor(fg, lut)
	}
	// 2. colour: the green glow taken out, then mixed with the background
	du, dv := dst.U(), dst.V()
	parallel(ch, func(y0, y1 int) {
		for i := y0 * cw; i < y1*cw; i++ {
			a := int32(kA[i])
			if a == 0 {
				continue
			}
			s := int32(kS[i])
			u := 128 + ((int32(fu[i])-128)*s)/255
			v := 128 + ((int32(fv[i])-128)*s)/255
			if a == 255 {
				du[i], dv[i] = uint8(u), uint8(v)
				continue
			}
			du[i] = uint8((u*a + int32(du[i])*(255-a) + 127) / 255)
			dv[i] = uint8((v*a + int32(dv[i])*(255-a) + 127) / 255)
		}
	})
	// 3. brightness, with the half-size alpha spread smoothly (weights 3/4 near, 1/4 far, like scaling up)
	dy, fy := dst.Y(), fg.Y()
	parallel(H, func(y0, y1 int) {
		for y := y0; y < y1; y++ {
			j := y >> 1
			jf := j - 1 // the other colour row
			if y&1 == 1 {
				jf = j + 1
			}
			if jf < 0 {
				jf = 0
			}
			if jf >= ch {
				jf = ch - 1
			}
			rn, rf := kA[j*cw:j*cw+cw], kA[jf*cw:jf*cw+cw]
			row := y * W
			for x := 0; x < W; x++ {
				i := x >> 1
				xf := i - 1
				if x&1 == 1 {
					xf = i + 1
				}
				if xf < 0 {
					xf = 0
				}
				if xf >= cw {
					xf = cw - 1
				}
				a := (9*int32(rn[i]) + 3*int32(rn[xf]) + 3*int32(rf[i]) + int32(rf[xf]) + 8) >> 4
				if a == 0 {
					continue
				}
				if a >= 255 {
					dy[row+x] = fy[row+x]
					continue
				}
				dy[row+x] = uint8((int32(fy[row+x])*a + int32(dy[row+x])*(255-a) + 127) / 255)
			}
		}
	})
}

// a full-size scratch picture (shared with the output frames' pool)
func (e *Engine) scratch() *Frame {
	select {
	case f := <-e.pool:
		return f
	default:
		return newFrame(e.W, e.H)
	}
}

func (e *Engine) unscratch(f *Frame) {
	select {
	case e.pool <- f:
	default:
	}
}
