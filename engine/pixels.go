package main

import (
	"math"
	"runtime"
	"sync"
)

/* Pictures are YUV 4:2:0 (BT.709, TV range) — what the cameras deliver and the encoders take. */

type Frame struct {
	W, H int
	Buf  []byte
}

func newFrame(w, h int) *Frame { return &Frame{W: w, H: h, Buf: make([]byte, w*h*3/2)} }
func (f *Frame) Y() []byte     { return f.Buf[:f.W*f.H] }
func (f *Frame) U() []byte     { n := f.W * f.H; return f.Buf[n : n+n/4] }
func (f *Frame) V() []byte     { n := f.W * f.H; return f.Buf[n+n/4 : n+n/2] }

var workers = func() int {
	n := runtime.NumCPU()
	if n > 8 {
		n = 8
	}
	if n < 1 {
		n = 1
	}
	return n
}()

// split rows [0,h) over a few threads
func parallel(h int, fn func(y0, y1 int)) {
	n := workers
	if h < 64 || n == 1 {
		fn(0, h)
		return
	}
	var wg sync.WaitGroup
	step := (h + n - 1) / n
	for y := 0; y < h; y += step {
		y1 := y + step
		if y1 > h {
			y1 = h
		}
		wg.Add(1)
		go func(a, b int) { defer wg.Done(); fn(a, b) }(y, y1)
	}
	wg.Wait()
}

func fillBlack(f *Frame) {
	y := f.Y()
	for i := range y {
		y[i] = 16
	}
	c := f.Buf[f.W*f.H:]
	for i := range c {
		c[i] = 128
	}
}

func fillColor(f *Frame, r, g, b uint8) {
	yy, cb, cr := rgbToYUV(int(r), int(g), int(b))
	y := f.Y()
	for i := range y {
		y[i] = yy
	}
	u, v := f.U(), f.V()
	for i := range u {
		u[i] = cb
		v[i] = cr
	}
}

// BT.709 TV range
func rgbToYUV(r, g, b int) (uint8, uint8, uint8) {
	y := ((47*r + 157*g + 16*b + 128) >> 8) + 16
	cb := ((-26*r - 86*g + 112*b + 128) >> 8) + 128
	cr := ((112*r - 102*g - 10*b + 128) >> 8) + 128
	return clamp8(y), clamp8(cb), clamp8(cr)
}

func clamp8(v int) uint8 {
	if v < 0 {
		return 0
	}
	if v > 255 {
		return 255
	}
	return uint8(v)
}

/* ---------- framing: a part of the source (normalised rectangle) scaled to the whole frame ---------- */

type Rect struct{ X, Y, W, H float64 }

var full = Rect{0, 0, 1, 1}

// like the window's uvFor: fill the frame, zoom, keep the picture inside the source
func framing(sw, sh, dw, dh int, zoom, cx, cy float64) Rect {
	sa := float64(sw) / float64(sh)
	da := float64(dw) / float64(dh)
	uw, uh := 1.0, 1.0
	if sa > da {
		uw = da / sa
	} else {
		uh = sa / da
	}
	if zoom < 1 {
		zoom = 1
	}
	if zoom > 8 {
		zoom = 8
	}
	uw /= zoom
	uh /= zoom
	cx = math.Max(uw/2, math.Min(1-uw/2, cx))
	cy = math.Max(uh/2, math.Min(1-uh/2, cy))
	return Rect{cx - uw/2, cy - uh/2, uw, uh}
}

func isFull(r Rect) bool {
	return math.Abs(r.X) < 1e-6 && math.Abs(r.Y) < 1e-6 && math.Abs(r.W-1) < 1e-6 && math.Abs(r.H-1) < 1e-6
}

// draw the part r of src over the whole of dst
func drawFramed(dst, src *Frame, r Rect) {
	if src.W == dst.W && src.H == dst.H && isFull(r) {
		copy(dst.Buf, src.Buf)
		return
	}
	scalePlane(dst.Y(), dst.W, dst.H, src.Y(), src.W, src.H, r)
	scalePlane(dst.U(), dst.W/2, dst.H/2, src.U(), src.W/2, src.H/2, r)
	scalePlane(dst.V(), dst.W/2, dst.H/2, src.V(), src.W/2, src.H/2, r)
}

// bilinear, 8-bit weights
func scalePlane(dst []byte, dw, dh int, src []byte, sw, sh int, r Rect) {
	xi := make([]int32, dw)
	xf := make([]int32, dw)
	for x := 0; x < dw; x++ {
		fx := (r.X+(float64(x)+0.5)/float64(dw)*r.W)*float64(sw) - 0.5
		if fx < 0 {
			fx = 0
		}
		i := int(fx)
		if i >= sw-1 {
			i = sw - 2
			fx = float64(sw - 1)
		}
		xi[x] = int32(i)
		xf[x] = int32((fx - float64(i)) * 256)
	}
	parallel(dh, func(y0, y1 int) {
		for y := y0; y < y1; y++ {
			fy := (r.Y+(float64(y)+0.5)/float64(dh)*r.H)*float64(sh) - 0.5
			if fy < 0 {
				fy = 0
			}
			j := int(fy)
			if j >= sh-1 {
				j = sh - 2
				fy = float64(sh - 1)
			}
			wy := int32((fy - float64(j)) * 256)
			r0 := src[j*sw : j*sw+sw]
			r1 := src[(j+1)*sw : (j+1)*sw+sw]
			d := dst[y*dw : y*dw+dw]
			for x := range d {
				i := xi[x]
				wx := xf[x]
				a := int32(r0[i])*(256-wx) + int32(r0[i+1])*wx
				b := int32(r1[i])*(256-wx) + int32(r1[i+1])*wx
				d[x] = uint8((a*(256-wy) + b*wy + 32768) >> 16)
			}
		}
	})
}

/* ---------- mixing ---------- */

// dst = a·(1-t) + b·t   (t in 0..256)
func lerpFrames(dst, a, b *Frame, t int) {
	n := len(dst.Buf)
	parallel(n/4096, func(c0, c1 int) {
		s, e := c0*4096, c1*4096
		if c1*4096 > n || c1 == n/4096 {
			e = n
		}
		da, aa, bb := dst.Buf[s:e], a.Buf[s:e], b.Buf[s:e]
		it := int32(256 - t)
		tt := int32(t)
		for i := range da {
			da[i] = uint8((int32(aa[i])*it + int32(bb[i])*tt + 128) >> 8)
		}
	})
}

// toward black by t (0..256)
func fadeToBlack(f *Frame, t int) {
	it := int32(256 - t)
	ky := int32(16 * t)
	kc := int32(128 * t)
	ny := f.W * f.H
	parallel(len(f.Buf)/4096, func(c0, c1 int) {
		s, e := c0*4096, c1*4096
		if c1 == len(f.Buf)/4096 {
			e = len(f.Buf)
		}
		b := f.Buf[s:e]
		for i := range b {
			k := ky
			if s+i >= ny {
				k = kc
			}
			b[i] = uint8((int32(b[i])*it + k + 128) >> 8)
		}
	})
}

/* ---------- colour (cheap version of the window's colour controls, done in YUV with tables) ---------- */

type Color struct {
	Exposure, Contrast, Saturation, Temp, Tint, Gamma, Black float64
}

func (c Color) neutral() bool {
	return c.Exposure == 0 && c.Contrast == 1 && c.Saturation == 1 && c.Temp == 0 && c.Tint == 0 && c.Gamma == 1 && c.Black == 0
}

type colorLUT struct {
	y      [256]uint8
	sat    int32 // ·256
	du, dv int32
}

func makeColorLUT(c Color) *colorLUT {
	L := &colorLUT{}
	for i := 0; i < 256; i++ {
		v := (float64(i) - 16) / 219
		v = math.Max(0, math.Min(1, v))
		lin := math.Pow(v, 2.2) * math.Exp2(c.Exposure)
		v = math.Pow(math.Max(lin, 0), 1/2.2)
		v = math.Pow(math.Max(v, 0), 1/math.Max(c.Gamma, 0.05))
		v = (v-0.5)*c.Contrast + 0.5
		if c.Black >= 0 {
			v = v*(1-c.Black) + c.Black
		} else {
			v = (v + c.Black) / (1 + c.Black)
		}
		v = math.Max(0, math.Min(1, v))
		L.y[i] = uint8(16 + v*219 + 0.5)
	}
	L.sat = int32(c.Saturation * 256)
	// warm = more red, less blue; magenta = less green
	L.du = int32(-c.Temp*14 + c.Tint*6)
	L.dv = int32(c.Temp*14 + c.Tint*8)
	return L
}

func applyColor(f *Frame, L *colorLUT) {
	y := f.Y()
	parallel(f.H, func(y0, y1 int) {
		row := y[y0*f.W : y1*f.W]
		for i, v := range row {
			row[i] = L.y[v]
		}
	})
	u, v := f.U(), f.V()
	for i := range u {
		cu := (int32(u[i])-128)*L.sat>>8 + 128 + L.du
		cv := (int32(v[i])-128)*L.sat>>8 + 128 + L.dv
		u[i] = clamp8(int(cu))
		v[i] = clamp8(int(cv))
	}
}

/* ---------- graphics layers: premultiplied YUV + alpha, kept for as long as the picture does not change ---------- */

type Layer struct {
	X, Y, W, H int // position in the frame (even), size (even)
	Yp, A      []byte
	Up, Vp, Ac []byte   // half size
	spans      [][2]int // per luma row: first / last+1 column with any alpha
	cspans     [][2]int
	empty      bool
}

type Key struct {
	On      bool
	R, G, B float64 // 0..1
	Tol     float64
}

/* Build a layer from RGBA/BGRA pixels (sw × sh) to be shown at x,y with size w×h (frame pixels). */
func buildLayer(px []byte, sw, sh int, bgra, premult bool, key Key, x, y, w, h, fw, fh int) *Layer {
	if sw <= 0 || sh <= 0 || len(px) < sw*sh*4 {
		return &Layer{empty: true}
	}
	// 1. premultiplied RGBA (key applied)
	pm := make([]byte, sw*sh*4)
	parallel(sh, func(y0, y1 int) {
		for i := y0 * sw; i < y1*sw; i++ {
			o := i * 4
			r, g, b, a := px[o], px[o+1], px[o+2], px[o+3]
			if bgra {
				r, b = b, r
			}
			R, G, B, A := float64(r), float64(g), float64(b), float64(a)
			if key.On {
				ur, ug, ub := R, G, B
				if premult && A > 0 {
					ur, ug, ub = R*255/A, G*255/A, B*255/A
				}
				d := math.Sqrt(sq(ur/255-key.R) + sq(ug/255-key.G) + sq(ub/255-key.B))
				k := smoothstep(key.Tol, key.Tol+0.12, d)
				if premult {
					R, G, B = R*k, G*k, B*k
				}
				A *= k
			}
			if !premult {
				R, G, B = R*A/255, G*A/255, B*A/255
			}
			pm[o], pm[o+1], pm[o+2], pm[o+3] = uint8(R+0.5), uint8(G+0.5), uint8(B+0.5), uint8(A+0.5)
		}
	})
	// 2. place on even pixels, clip to the frame
	if x%2 != 0 {
		x--
	}
	if y%2 != 0 {
		y--
	}
	if w%2 != 0 {
		w++
	}
	if h%2 != 0 {
		h++
	}
	if w <= 0 || h <= 0 {
		return &Layer{empty: true}
	}
	// 3. scale to w×h if needed (premultiplied, so no dark fringes)
	if sw != w || sh != h {
		pm = scaleRGBA(pm, sw, sh, w, h)
	}
	L := &Layer{X: x, Y: y, W: w, H: h}
	L.Yp = make([]byte, w*h)
	L.A = make([]byte, w*h)
	cw, ch := w/2, h/2
	L.Up = make([]byte, cw*ch)
	L.Vp = make([]byte, cw*ch)
	L.Ac = make([]byte, cw*ch)
	parallel(ch, func(c0, c1 int) {
		for cy := c0; cy < c1; cy++ {
			for cx := 0; cx < cw; cx++ {
				var su, sv, sa int
				for dy := 0; dy < 2; dy++ {
					for dx := 0; dx < 2; dx++ {
						px := (cy*2+dy)*w + cx*2 + dx
						o := px * 4
						r, g, b, a := int(pm[o]), int(pm[o+1]), int(pm[o+2]), int(pm[o+3])
						// premultiplied luma: offset 16 scaled by alpha
						L.Yp[px] = clamp8(((47*r + 157*g + 16*b + 128) >> 8) + (16*a+127)/255)
						L.A[px] = uint8(a)
						su += ((-26*r - 86*g + 112*b + 128) >> 8) + (128*a+127)/255
						sv += ((112*r - 102*g - 10*b + 128) >> 8) + (128*a+127)/255
						sa += a
					}
				}
				ci := cy*cw + cx
				L.Up[ci] = clamp8((su + 2) / 4)
				L.Vp[ci] = clamp8((sv + 2) / 4)
				L.Ac[ci] = uint8((sa + 2) / 4)
			}
		}
	})
	L.spans = rowSpans(L.A, w, h)
	L.cspans = rowSpans(L.Ac, cw, ch)
	L.empty = true
	for _, s := range L.spans {
		if s[1] > s[0] {
			L.empty = false
			break
		}
	}
	return L
}

func sq(v float64) float64 { return v * v }
func smoothstep(e0, e1, x float64) float64 {
	t := math.Max(0, math.Min(1, (x-e0)/(e1-e0)))
	return t * t * (3 - 2*t)
}

func rowSpans(a []byte, w, h int) [][2]int {
	s := make([][2]int, h)
	for y := 0; y < h; y++ {
		row := a[y*w : y*w+w]
		x0, x1 := 0, w
		for x0 < w && row[x0] == 0 {
			x0++
		}
		for x1 > x0 && row[x1-1] == 0 {
			x1--
		}
		s[y] = [2]int{x0, x1}
	}
	return s
}

func scaleRGBA(src []byte, sw, sh, dw, dh int) []byte {
	dst := make([]byte, dw*dh*4)
	parallel(dh, func(y0, y1 int) {
		for y := y0; y < y1; y++ {
			fy := (float64(y)+0.5)*float64(sh)/float64(dh) - 0.5
			if fy < 0 {
				fy = 0
			}
			j := int(fy)
			if j >= sh-1 {
				j = sh - 1
			}
			j1 := j + 1
			if j1 > sh-1 {
				j1 = sh - 1
			}
			wy := fy - float64(j)
			for x := 0; x < dw; x++ {
				fx := (float64(x)+0.5)*float64(sw)/float64(dw) - 0.5
				if fx < 0 {
					fx = 0
				}
				i := int(fx)
				if i >= sw-1 {
					i = sw - 1
				}
				i1 := i + 1
				if i1 > sw-1 {
					i1 = sw - 1
				}
				wx := fx - float64(i)
				for c := 0; c < 4; c++ {
					a := float64(src[(j*sw+i)*4+c])*(1-wx) + float64(src[(j*sw+i1)*4+c])*wx
					b := float64(src[(j1*sw+i)*4+c])*(1-wx) + float64(src[(j1*sw+i1)*4+c])*wx
					dst[(y*dw+x)*4+c] = uint8(a*(1-wy) + b*wy + 0.5)
				}
			}
		}
	})
	return dst
}

/* out = layer·g + out·(1 − a·g)   with g = 0..256 */
func blendLayer(f *Frame, L *Layer, g int) {
	if L == nil || L.empty || g <= 0 {
		return
	}
	if g > 256 {
		g = 256
	}
	var inv [256]int32
	for a := 0; a < 256; a++ {
		inv[a] = int32(256 - (a*g+127)/255)
	}
	G := int32(g)
	blendPlane(f.Y(), f.W, f.H, L.Yp, L.A, L.W, L.H, L.X, L.Y, L.spans, G, &inv)
	blendPlane(f.U(), f.W/2, f.H/2, L.Up, L.Ac, L.W/2, L.H/2, L.X/2, L.Y/2, L.cspans, G, &inv)
	blendPlane(f.V(), f.W/2, f.H/2, L.Vp, L.Ac, L.W/2, L.H/2, L.X/2, L.Y/2, L.cspans, G, &inv)
}

func blendPlane(dst []byte, dw, dh int, P, A []byte, lw, lh, ox, oy int, spans [][2]int, G int32, inv *[256]int32) {
	parallel(lh, func(y0, y1 int) {
		for ly := y0; ly < y1; ly++ {
			fy := oy + ly
			if fy < 0 || fy >= dh {
				continue
			}
			s := spans[ly]
			for lx := s[0]; lx < s[1]; lx++ {
				fx := ox + lx
				if fx < 0 || fx >= dw {
					continue
				}
				li := ly*lw + lx
				a := A[li]
				if a == 0 {
					continue
				}
				di := fy*dw + fx
				dst[di] = uint8((int32(P[li])*G + int32(dst[di])*inv[a] + 128) >> 8)
			}
		}
	})
}

/* ---------- small RGBA pictures for the window's monitors ---------- */

func toRGBA(f *Frame, pw, ph int, out []byte) {
	W, H := f.W, f.H
	Y, U, V := f.Y(), f.U(), f.V()
	parallel(ph, func(y0, y1 int) {
		for y := y0; y < y1; y++ {
			sy := (y * H / ph) &^ 1 // even row
			for x := 0; x < pw; x++ {
				sx := (x * W / pw) &^ 1
				// average 2×2 luma (less flicker than single pixels)
				yy := (int(Y[sy*W+sx]) + int(Y[sy*W+sx+1]) + int(Y[(sy+1)*W+sx]) + int(Y[(sy+1)*W+sx+1]) + 2) / 4
				ci := (sy/2)*(W/2) + sx/2
				u, v := int(U[ci])-128, int(V[ci])-128
				c := (yy - 16) * 298
				r := (c + 459*v + 128) >> 8
				g := (c - 55*u - 136*v + 128) >> 8
				b := (c + 541*u + 128) >> 8
				o := (y*pw + x) * 4
				out[o], out[o+1], out[o+2], out[o+3] = clamp8(r), clamp8(g), clamp8(b), 255
			}
		}
	})
}

// RGBA (straight alpha, opaque or not) → YUV frame of the same size, on black
func rgbaToFrame(px []byte, w, h int) *Frame {
	f := newFrame(w&^1, h&^1)
	w2, h2 := f.W, f.H
	Y, U, V := f.Y(), f.U(), f.V()
	parallel(h2/2, func(c0, c1 int) {
		for cy := c0; cy < c1; cy++ {
			for cx := 0; cx < w2/2; cx++ {
				var su, sv int
				for dy := 0; dy < 2; dy++ {
					for dx := 0; dx < 2; dx++ {
						x, y := cx*2+dx, cy*2+dy
						o := (y*w + x) * 4
						a := int(px[o+3])
						r, g, b := int(px[o])*a/255, int(px[o+1])*a/255, int(px[o+2])*a/255
						yy, cb, cr := rgbToYUV(r, g, b)
						Y[y*w2+x] = yy
						su += int(cb)
						sv += int(cr)
					}
				}
				U[cy*(w2/2)+cx] = uint8((su + 2) / 4)
				V[cy*(w2/2)+cx] = uint8((sv + 2) / 4)
			}
		}
	})
	return f
}
