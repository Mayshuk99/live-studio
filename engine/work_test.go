package main

import (
	"encoding/binary"
	"math"
	"testing"
	"time"
)

// Sound must not wait behind a big picture: pictures are prepared on the work thread, sound is taken straight away.
func TestSoundDoesNotWaitForPictures(t *testing.T) {
	e := newEngine(Msg{"w": float64(1920), "h": float64(1080), "fpsNum": float64(30000), "fpsDen": float64(1001)})
	q := newWorkQueue()
	// three 4K pictures, each of them takes a while to prepare
	big := make([]byte, 3840*2160*4)
	for i := range big {
		big[i] = byte(i * 7)
	}
	start := time.Now()
	for _, id := range []string{"a", "b", "c"} {
		q.add(e, "overlay", Msg{"id": id, "sw": float64(3840), "sh": float64(2160), "x": float64(0), "y": float64(0), "w": float64(1920), "h": float64(1080)}, big)
	}
	handed := time.Since(start)
	// sound right behind them, as the reader thread does it
	pcm := make([]byte, 4*2*480)
	for i := 0; i < 2*480; i++ {
		binary.LittleEndian.PutUint32(pcm[i*4:], math.Float32bits(0.25))
	}
	e.command("audio", Msg{"rate": float64(48000), "ch": float64(2)}, pcm)
	soundAt := time.Since(start)
	e.audio.mu.Lock()
	got := len(e.audio.buf)
	e.audio.mu.Unlock()
	if got != 2*480 {
		t.Fatalf("sound not taken: %d samples", got)
	}
	q.wait()
	all := time.Since(start)
	e.mu.Lock()
	n := len(e.overlays)
	e.mu.Unlock()
	if n != 3 {
		t.Fatalf("pictures prepared: %d of 3", n)
	}
	t.Logf("handed over in %v, sound taken after %v, the three pictures ready after %v", handed, soundAt, all)
	if soundAt > all/3 {
		t.Fatalf("sound waited for the pictures: taken after %v of %v", soundAt, all)
	}
}

// Commands keep their order on the work thread.
func TestWorkKeepsOrder(t *testing.T) {
	e := newEngine(Msg{"w": float64(640), "h": float64(360), "fpsNum": float64(30), "fpsDen": float64(1)})
	q := newWorkQueue()
	px := make([]byte, 64*36*4)
	for i := 0; i < 50; i++ {
		q.add(e, "overlay", Msg{"id": "x", "sw": float64(64), "sh": float64(36), "x": float64(0), "y": float64(0), "w": float64(64), "h": float64(36)}, px)
		q.add(e, "overlay-remove", Msg{"id": "x"}, nil)
	}
	q.add(e, "still", Msg{"id": "last", "w": float64(64), "h": float64(36)}, px)
	q.wait()
	e.mu.Lock()
	defer e.mu.Unlock()
	if len(e.overlays) != 0 {
		t.Fatalf("an overlay is left: the removal ran before the picture")
	}
	if e.stills["last"] == nil {
		t.Fatalf("the last command was not carried out")
	}
}
