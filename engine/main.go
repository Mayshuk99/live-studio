// Live Studio native engine.
//
// Captures the cameras itself (through FFmpeg), mixes the program on its own steady clock (locked to the camera
// on air), and feeds the YouTube / recording encoders — the picture never goes through Chrome. Live Studio's
// window tells it what to show and sends graphics, captions and sound.
//
// Messages in both directions (stdin / stdout):  [u32 header length][u32 payload length][JSON header][payload]
package main

import (
	"bufio"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"runtime"
	"sync"
	"time"
)

type Msg map[string]any

func (m Msg) str(k string) string { s, _ := m[k].(string); return s }
func (m Msg) num(k string) float64 {
	switch v := m[k].(type) {
	case float64:
		return v
	case int:
		return float64(v)
	}
	return 0
}
func (m Msg) boolean(k string) bool { b, _ := m[k].(bool); return b }
func (m Msg) has(k string) bool     { _, ok := m[k]; return ok }
func (m Msg) strs(k string) []string {
	a, _ := m[k].([]any)
	out := make([]string, 0, len(a))
	for _, x := range a {
		if s, ok := x.(string); ok {
			out = append(out, s)
		}
	}
	return out
}
func (m Msg) obj(k string) Msg { o, _ := m[k].(map[string]any); return Msg(o) }

/* ---------- sending to Live Studio ---------- */

// everything goes out through one writer, so the clock never waits for Live Studio to read
var outq = make(chan []byte, 256)

func init() {
	go func() {
		w := bufio.NewWriterSize(os.Stdout, 1<<20)
		for p := range outq {
			w.Write(p)
			if len(outq) == 0 {
				w.Flush()
			}
		}
	}()
}

func packet(h Msg, payload []byte) []byte {
	hb, _ := json.Marshal(h)
	p := make([]byte, 8+len(hb)+len(payload))
	binary.LittleEndian.PutUint32(p[0:], uint32(len(hb)))
	binary.LittleEndian.PutUint32(p[4:], uint32(len(payload)))
	copy(p[8:], hb)
	copy(p[8+len(hb):], payload)
	return p
}

func send(h Msg, payload []byte) { outq <- packet(h, payload) }

// pictures for the monitors: skipped when Live Studio is behind
func sendRoom() bool { return len(outq) < 24 }
func sendLossy(h Msg, payload []byte) {
	select {
	case outq <- packet(h, payload):
	default:
	}
}

func logf(format string, a ...any) {
	send(Msg{"ev": "log", "line": fmt.Sprintf(format, a...)}, nil)
}

/* ---------- reading commands ---------- */

func readMsg(r io.Reader) (Msg, []byte, error) {
	var pre [8]byte
	if _, err := io.ReadFull(r, pre[:]); err != nil {
		return nil, nil, err
	}
	hl := binary.LittleEndian.Uint32(pre[0:])
	pl := binary.LittleEndian.Uint32(pre[4:])
	if hl > 1<<20 || pl > 256<<20 {
		return nil, nil, fmt.Errorf("bad message size %d/%d", hl, pl)
	}
	hb := make([]byte, hl)
	if _, err := io.ReadFull(r, hb); err != nil {
		return nil, nil, err
	}
	var payload []byte
	if pl > 0 {
		payload = make([]byte, pl)
		if _, err := io.ReadFull(r, payload); err != nil {
			return nil, nil, err
		}
	}
	var m Msg
	if err := json.Unmarshal(hb, &m); err != nil {
		return nil, nil, err
	}
	return m, payload, nil
}

func main() {
	runtime.GOMAXPROCS(runtime.NumCPU())
	setOwnPriority()
	in := bufio.NewReaderSize(os.Stdin, 4<<20)
	var eng *Engine
	for {
		m, payload, err := readMsg(in)
		if err != nil {
			// Live Studio closed: stop everything cleanly (encoders finish their files)
			if eng != nil {
				eng.shutdown()
			}
			return
		}
		cmd := m.str("cmd")
		if cmd == "hello" {
			if eng != nil {
				eng.shutdown()
			}
			eng = newEngine(m)
			go eng.run()
			send(Msg{"ev": "ready", "w": eng.W, "h": eng.H, "threads": runtime.NumCPU()}, nil)
			continue
		}
		if eng == nil {
			continue
		}
		if cmd == "quit" {
			eng.shutdown()
			return
		}
		eng.command(cmd, m, payload)
	}
}

// for messages that should not flood the log
type rateLog struct {
	mu   sync.Mutex
	last map[string]time.Time
}

var rl = rateLog{last: map[string]time.Time{}}

func logOnce(key string, every time.Duration, format string, a ...any) {
	rl.mu.Lock()
	t, ok := rl.last[key]
	if ok && time.Since(t) < every {
		rl.mu.Unlock()
		return
	}
	rl.last[key] = time.Now()
	rl.mu.Unlock()
	logf(format, a...)
}
