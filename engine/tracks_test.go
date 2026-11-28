package main

import (
	"encoding/binary"
	"testing"
)

func s16(b []byte, i int) int16 { return int16(binary.LittleEndian.Uint16(b[i*2:])) }

// the program and two recording tracks (6 channels) come out as they went in, each channel its own level
func TestAudioTracksKeepTheirChannels(t *testing.T) {
	a := newAudio()
	lv := []float32{0.1, -0.1, 0.2, -0.2, 0.3, -0.3}
	in := make([]float32, 0, 48000*6)
	for i := 0; i < 48000; i++ {
		in = append(in, lv...)
	}
	a.push(in, 6, 48000)
	out, ch := a.pull(4800)
	if ch != 6 || len(out) != 4800*6*2 {
		t.Fatalf("channels %d, bytes %d", ch, len(out))
	}
	for c, v := range lv {
		got := s16(out, 100*6+c)
		want := int16(v * 32767)
		if d := int(got) - int(want); d > 2 || d < -2 {
			t.Fatalf("channel %d: %d, want %d", c, got, want)
		}
	}
}

// tracks switched on while sound is waiting: nothing is lost, the program stays where it was, the new track starts silent
func TestAudioChannelsChangeWithoutGap(t *testing.T) {
	a := newAudio()
	st := make([]float32, 0, 48000*2)
	for i := 0; i < 24000; i++ {
		st = append(st, 0.5, -0.5)
	}
	a.push(st, 2, 48000)
	quad := make([]float32, 0, 24000*4)
	for i := 0; i < 24000; i++ {
		quad = append(quad, 0.5, -0.5, 0.25, 0.25)
	}
	a.push(quad, 4, 48000)
	out, ch := a.pull(960)
	if ch != 4 {
		t.Fatalf("channels %d", ch)
	}
	if l, r, t3 := s16(out, 10*4), s16(out, 10*4+1), s16(out, 10*4+2); l < 16000 || r > -16000 || t3 != 0 {
		t.Fatalf("first frames: L %d R %d track %d (want the program, and a silent track before it was switched on)", l, r, t3)
	}
}

func TestRemixPCM(t *testing.T) {
	p := make([]byte, 3*6*2)
	for i := 0; i < 18; i++ {
		binary.LittleEndian.PutUint16(p[i*2:], uint16(i+1))
	}
	st := remixPCM(p, 6, 2) // the stream: the program only
	if len(st) != 3*2*2 || s16(st, 0) != 1 || s16(st, 1) != 2 || s16(st, 2) != 7 || s16(st, 5) != 14 {
		t.Fatalf("6→2: %v", st)
	}
	wide := remixPCM(st, 2, 4) // a recording that wants a track the program is not sending (yet): silent
	if len(wide) != 3*4*2 || s16(wide, 0) != 1 || s16(wide, 2) != 0 || s16(wide, 4) != 7 {
		t.Fatalf("2→4: %v", wide)
	}
}
