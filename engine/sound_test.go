package main

import (
	"encoding/binary"
	"encoding/json"
	"fmt"
	"math"
	"net"
	"testing"
	"time"
)

func soundPacket(h Msg, payload []byte) []byte {
	hb, _ := json.Marshal(h)
	p := make([]byte, 8, 8+len(hb)+len(payload))
	binary.LittleEndian.PutUint32(p[0:], uint32(len(hb)))
	binary.LittleEndian.PutUint32(p[4:], uint32(len(payload)))
	return append(append(p, hb...), payload...)
}

// The sound line: sound sent on it reaches the engine; a caller that does not know the key is not listened to.
func TestSoundLine(t *testing.T) {
	e := newEngine(Msg{"w": float64(640), "h": float64(360), "fpsNum": float64(30), "fpsDen": float64(1)})
	soundEng.Store(e)
	soundKey.Store("secret")
	port := soundLine()
	if port == 0 {
		t.Fatal("no sound line")
	}
	pcm := make([]byte, 4*2*480)
	for i := 0; i < 2*480; i++ {
		binary.LittleEndian.PutUint32(pcm[i*4:], math.Float32bits(0.5))
	}
	got := func() int { e.audio.mu.Lock(); defer e.audio.mu.Unlock(); return len(e.audio.buf) }
	dial := func() net.Conn {
		c, err := net.Dial("tcp", fmt.Sprintf("127.0.0.1:%d", port))
		if err != nil {
			t.Fatal(err)
		}
		return c
	}
	// a stranger: wrong key, then sound
	c := dial()
	c.Write(soundPacket(Msg{"cmd": "sound-hello", "key": "guess"}, nil))
	c.Write(soundPacket(Msg{"cmd": "audio", "rate": float64(48000), "ch": float64(2)}, pcm))
	time.Sleep(150 * time.Millisecond)
	c.Close()
	if n := got(); n != 0 {
		t.Fatalf("sound from a caller without the key was taken (%d samples)", n)
	}
	// no hello at all
	c = dial()
	c.Write(soundPacket(Msg{"cmd": "audio", "rate": float64(48000), "ch": float64(2)}, pcm))
	time.Sleep(150 * time.Millisecond)
	c.Close()
	if n := got(); n != 0 {
		t.Fatalf("sound without a hello was taken (%d samples)", n)
	}
	// the program
	c = dial()
	defer c.Close()
	c.Write(soundPacket(Msg{"cmd": "sound-hello", "key": "secret"}, nil))
	for i := 0; i < 5; i++ {
		c.Write(soundPacket(Msg{"cmd": "audio", "rate": float64(48000), "ch": float64(2)}, pcm))
	}
	// only sound is carried out on this line
	c.Write(soundPacket(Msg{"cmd": "still", "id": "x", "w": float64(2), "h": float64(2)}, make([]byte, 16)))
	deadline := time.Now().Add(2 * time.Second)
	for got() < 5*2*480 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if n := got(); n != 5*2*480 {
		t.Fatalf("sound on the line: %d samples, want %d", n, 5*2*480)
	}
	time.Sleep(50 * time.Millisecond)
	e.mu.Lock()
	_, bad := e.stills["x"]
	e.mu.Unlock()
	if bad {
		t.Fatal("a picture command was carried out on the sound line")
	}
}
