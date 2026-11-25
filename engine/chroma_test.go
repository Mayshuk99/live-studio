package main

import (
	"math"
	"testing"
	"time"
)

// a grey square in front of a green screen, keyed over red
func TestKeyOver(t *testing.T) {
	const W, H = 1920, 1080
	e := &Engine{W: W, H: H, pool: make(chan *Frame, 4)}
	fg, dst := newFrame(W, H), newFrame(W, H)
	fillColor(fg, 58, 157, 74) // a real green screen colour, not pure green
	gy, gu, gv := rgbToYUV(128, 128, 128)
	for y := 400; y < 680; y++ {
		for x := 800; x < 1120; x++ {
			fg.Y()[y*W+x] = gy
		}
	}
	for y := 200; y < 340; y++ {
		for x := 400; x < 560; x++ {
			fg.U()[y*W/2+x], fg.V()[y*W/2+x] = gu, gv
		}
	}
	fillColor(dst, 220, 20, 20)
	ry, ru, rv := rgbToYUV(220, 20, 20)
	// key colour picked from the screen (as the window's "pick" does)
	cb, cr := keyCbCrRGB(58, 157, 74)
	R := math.Hypot(cb, cr) // the window sends the sliders as fractions of this
	g := &Green{Cb: cb, Cr: cr, Sim: 0.55 * R, Smooth: 0.2 * R, Spill: 0.35 * R}
	g.lut = lutFor(g)
	t0 := time.Now()
	for i := 0; i < 20; i++ {
		d := newFrame(W, H)
		copy(d.Buf, dst.Buf)
		e.keyOver(d, cloneFrame(fg), g, nil)
		if i == 19 {
			dst = d
		}
	}
	per := time.Since(t0) / 20
	t.Logf("keying a 1080p frame: %v", per)
	if per > 40*time.Millisecond {
		t.Errorf("too slow: %v per frame", per)
	}
	at := func(x, y int) (uint8, uint8, uint8) {
		return dst.Y()[y*W+x], dst.U()[(y/2)*W/2+x/2], dst.V()[(y/2)*W/2+x/2]
	}
	if y, u, v := at(100, 100); y != ry || u != ru || v != rv {
		t.Errorf("green area should show the background: got %d,%d,%d want %d,%d,%d", y, u, v, ry, ru, rv)
	}
	if y, u, v := at(960, 540); y != gy || absd(u, gu) > 1 || absd(v, gv) > 1 {
		t.Errorf("the person should stay: got %d,%d,%d want %d,%d,%d", y, u, v, gy, gu, gv)
	}
	// the edge is a blend (no hard 2-pixel steps)
	y0, _, _ := at(797, 540)
	y1, _, _ := at(799, 540)
	y2, _, _ := at(801, 540)
	t.Logf("edge brightness: %d %d %d (background %d, person %d)", y0, y1, y2, ry, gy)
}

func keyCbCrRGB(r, g, b float64) (float64, float64) {
	r, g, b = r/255, g/255, b/255
	return -0.1146*r - 0.3854*g + 0.5*b, 0.5*r - 0.4542*g - 0.0458*b
}

func cloneFrame(f *Frame) *Frame { c := newFrame(f.W, f.H); copy(c.Buf, f.Buf); return c }

func absd(a, b uint8) int {
	if a > b {
		return int(a - b)
	}
	return int(b - a)
}

// the "program" message with a green screen: parsed, background drawn, picture keyed over it
func TestGreenProgram(t *testing.T) {
	e := newEngine(Msg{"w": float64(64), "h": float64(36)})
	px := func(r, g, b uint8, box bool) []byte {
		p := make([]byte, 64*36*4)
		for y := 0; y < 36; y++ {
			for x := 0; x < 64; x++ {
				i := (y*64 + x) * 4
				p[i], p[i+1], p[i+2], p[i+3] = r, g, b, 255
				if box && x >= 24 && x < 40 && y >= 10 && y < 26 {
					p[i], p[i+1], p[i+2] = 200, 160, 140 // skin-ish
				}
			}
		}
		return p
	}
	e.command("still", Msg{"id": "cam", "w": float64(64), "h": float64(36)}, px(40, 200, 60, true))
	e.command("still", Msg{"id": "pic", "w": float64(64), "h": float64(36)}, px(30, 60, 200, false))
	cb, cr := keyCbCrRGB(40, 200, 60)
	R := math.Hypot(cb, cr)
	e.command("program", Msg{"base": map[string]any{"key": "s1", "src": "cam", "green": map[string]any{"cb": cb, "cr": cr, "sim": 0.55 * R, "smooth": 0.2 * R, "spill": 0.35 * R, "bg": map[string]any{"src": "pic"}}}, "ms": float64(0)}, nil)
	if e.cur == nil || e.cur.Green == nil || e.cur.Green.Bg == nil || e.cur.Green.Bg.Src != "pic" {
		t.Fatalf("green screen not parsed: %+v", e.cur)
	}
	f := newFrame(64, 36)
	e.renderBase(f, e.cur, 1)
	by, _, _ := rgbToYUV(30, 60, 200)
	sy, _, _ := rgbToYUV(200, 160, 140)
	if d := absd(f.Y()[2*64+2], by); d > 2 {
		t.Errorf("corner should be the blue background: Y %d want %d", f.Y()[2*64+2], by)
	}
	if d := absd(f.Y()[18*64+32], sy); d > 2 {
		t.Errorf("middle should be the person: Y %d want %d", f.Y()[18*64+32], sy)
	}
	// without a background: black behind
	e.command("program", Msg{"base": map[string]any{"key": "s1", "src": "cam", "green": map[string]any{"cb": cb, "cr": cr, "sim": 0.55 * R, "smooth": 0.2 * R, "spill": 0.35 * R}}, "ms": float64(0)}, nil)
	e.renderBase(f, e.cur, 2)
	if f.Y()[2*64+2] != 16 {
		t.Errorf("no background should be black: Y %d", f.Y()[2*64+2])
	}
}
