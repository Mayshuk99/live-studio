package main

import "testing"

// a small picture anywhere, any size, with a white border, over the main picture
func TestPip(t *testing.T) {
	const W, H = 320, 180
	e := newEngine(Msg{"w": float64(W), "h": float64(H)})
	solid := func(r, g, b uint8) []byte {
		p := make([]byte, 64*36*4)
		for i := 0; i < len(p); i += 4 {
			p[i], p[i+1], p[i+2], p[i+3] = r, g, b, 255
		}
		return p
	}
	e.command("still", Msg{"id": "main", "w": float64(64), "h": float64(36)}, solid(200, 30, 30))
	e.command("still", Msg{"id": "small", "w": float64(64), "h": float64(36)}, solid(30, 30, 200))
	e.command("program", Msg{"base": map[string]any{"key": "s1", "src": "main",
		"pip": map[string]any{"key": "s1:p", "src": "small", "rect": []any{0.4, 0.5, 0.25, 0.4}, "border": true}}, "ms": float64(0)}, nil)
	if e.cur == nil || e.cur.Pip == nil {
		t.Fatal("pip not parsed")
	}
	f := newFrame(W, H)
	e.renderBase(f, e.cur, 1)
	my, _, _ := rgbToYUV(200, 30, 30)
	sy, _, _ := rgbToYUV(30, 30, 200)
	Y := func(x, y int) uint8 { return f.Y()[y*W+x] }
	// box: x 128…208, y 90…162
	if d := absd(Y(168, 126), sy); d > 2 {
		t.Errorf("inside the box should be the small picture: %d want %d", Y(168, 126), sy)
	}
	if d := absd(Y(20, 20), my); d > 2 {
		t.Errorf("outside should be the main picture: %d want %d", Y(20, 20), my)
	}
	if Y(126, 126) != 235 {
		t.Errorf("border should be white: %d", Y(126, 126))
	}
	if d := absd(Y(122, 126), my); d > 2 {
		t.Errorf("beyond the border should be the main picture: %d", Y(122, 126))
	}
	// a box partly off the picture is kept inside
	e.command("program", Msg{"base": map[string]any{"key": "s1", "src": "main",
		"pip": map[string]any{"src": "small", "rect": []any{0.9, 0.9, 0.3, 0.3}, "border": false}}, "ms": float64(0)}, nil)
	e.renderBase(f, e.cur, 2)
	if d := absd(Y(W-2, H-2), sy); d > 2 {
		t.Errorf("box should be moved inside: corner %d want %d", Y(W-2, H-2), sy)
	}
}
