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
	"net"
	"os"
	"runtime"
	"runtime/debug"
	"runtime/pprof"
	"sync"
	"sync/atomic"
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

// a packet whose payload is written straight into it (a big picture is not copied a second time)
func packetFill(h Msg, n int, fill func([]byte)) []byte {
	hb, _ := json.Marshal(h)
	p := make([]byte, 8+len(hb)+n)
	binary.LittleEndian.PutUint32(p[0:], uint32(len(hb)))
	binary.LittleEndian.PutUint32(p[4:], uint32(n))
	copy(p[8:], hb)
	fill(p[8+len(hb):])
	return p
}

// pictures for the monitors: skipped when Live Studio is behind
func sendRoom() bool { return len(outq) < 24 }
func sendLossy(h Msg, payload []byte) {
	select {
	case outq <- packet(h, payload):
	default:
	}
}
func sendLossyPacket(p []byte) {
	select {
	case outq <- p:
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
	debug.SetGCPercent(300)
	setOwnPriority()
	if f := os.Getenv("LS_ENGINE_PROFILE"); f != "" { // for development: where the engine spends its processor time
		if pf, err := os.Create(f); err == nil {
			pprof.StartCPUProfile(pf)
			defer pprof.StopCPUProfile()
		}
	}
	in := bufio.NewReaderSize(os.Stdin, 4<<20)
	var eng *Engine
	// Sound is taken straight off the line; every other command is carried out in order on its own thread.
	// (A big picture — a slide, a graphic — takes 50–200 ms to prepare; done on this thread, the sound queued up
	// behind it waited that long and the stream got a gap.)
	work := newWorkQueue()
	for {
		m, payload, err := readMsg(in)
		if err != nil {
			// Live Studio closed: stop everything cleanly (encoders finish their files)
			work.wait()
			if eng != nil {
				eng.shutdown()
			}
			return
		}
		cmd := m.str("cmd")
		if cmd == "hello" {
			work.wait()
			if eng != nil {
				eng.shutdown()
			}
			eng = newEngine(m)
			go eng.run()
			soundEng.Store(eng)
			soundKey.Store(m.str("soundKey"))
			send(Msg{"ev": "ready", "w": eng.W, "h": eng.H, "threads": runtime.NumCPU(), "soundPort": soundLine()}, nil)
			continue
		}
		if eng == nil {
			continue
		}
		if cmd == "quit" {
			work.wait()
			eng.shutdown()
			return
		}
		if cmd == "audio" {
			eng.command(cmd, m, payload)
			continue
		}
		work.add(eng, cmd, m, payload)
	}
}

// Sound has a line of its own (a local connection), so it never queues up behind pictures on the command line:
// 100 MB of graphics on that line held the sound back for half a second on a slow PC.
var (
	soundEng  atomic.Pointer[Engine]
	soundKey  atomic.Value // string: what the program must say first on the sound line
	soundOnce sync.Once
	soundPort int
)

func soundLine() int {
	soundOnce.Do(func() {
		ln, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			return
		}
		soundPort = ln.Addr().(*net.TCPAddr).Port
		go func() {
			for {
				c, err := ln.Accept()
				if err != nil {
					return
				}
				go serveSound(c)
			}
		}()
	})
	return soundPort
}

func serveSound(c net.Conn) {
	defer c.Close()
	r := bufio.NewReaderSize(c, 256<<10)
	known := false
	for {
		var pre [8]byte
		if _, err := io.ReadFull(r, pre[:]); err != nil {
			return
		}
		hl, pl := binary.LittleEndian.Uint32(pre[0:4]), binary.LittleEndian.Uint32(pre[4:8])
		if hl > 4096 || pl > 4<<20 { // not ours
			return
		}
		hb, payload := make([]byte, hl), make([]byte, pl)
		if _, err := io.ReadFull(r, hb); err != nil {
			return
		}
		if _, err := io.ReadFull(r, payload); err != nil {
			return
		}
		var m Msg
		if json.Unmarshal(hb, &m) != nil {
			return
		}
		if !known {
			key, _ := soundKey.Load().(string)
			if m.str("cmd") != "sound-hello" || key == "" || m.str("key") != key {
				return
			}
			known = true
			continue
		}
		if e := soundEng.Load(); e != nil && m.str("cmd") == "audio" {
			e.command("audio", m, payload)
		}
	}
}

// commands in the order they came, one at a time, off the thread that reads the line
type workItem struct {
	e       *Engine
	cmd     string
	m       Msg
	payload []byte
}

type workQueue struct {
	ch chan workItem
	wg sync.WaitGroup
}

func newWorkQueue() *workQueue {
	q := &workQueue{ch: make(chan workItem, 512)}
	go func() {
		for it := range q.ch {
			it.e.command(it.cmd, it.m, it.payload)
			q.wg.Done()
		}
	}()
	return q
}

func (q *workQueue) add(e *Engine, cmd string, m Msg, payload []byte) {
	q.wg.Add(1)
	q.ch <- workItem{e, cmd, m, payload}
}

// until everything handed over so far is done
func (q *workQueue) wait() { q.wg.Wait() }

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
