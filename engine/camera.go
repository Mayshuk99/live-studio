package main

import (
	"bufio"
	"fmt"
	"io"
	"os/exec"
	"strings"
	"sync"
	"time"
)

/*
A camera: FFmpeg reads the capture card and hands over every frame (YUV 4:2:0, frame size) through a pipe.

Frames do not arrive evenly through the pipe (24 Nov evening log: a frame shown twice and one skipped 5–6
times a second when the mixer went by arrival time). So every frame gets an "ideal" time on the camera's own
steady rhythm — the earliest-arrival line, which follows the card's clock — and the mixer picks frames by
that time, a little in the past (camLatency), so a frame that comes late through the pipe is still there in time.
*/
const camBufs = 8
const camKeep = 6 // finished frames kept for the mixer to choose from

type camSlot struct {
	buf   int
	n     uint64
	ideal time.Time
}

type Camera struct {
	id      string
	W, H    int // captured size
	args    []string
	period  time.Duration // the camera's own frame time
	lock    bool          // same rate as the output: the output clock may follow it
	e       *Engine
	mu      sync.Mutex
	bufs    [camBufs]*Frame
	ring    []camSlot // finished frames, oldest first
	held    int
	filling int
	count   uint64
	lastAt  time.Time
	ideal   time.Time // ideal time of the newest frame
	ok      bool
	status  string
	stopped bool
	cmd     *exec.Cmd
	secN    int // frames this second
	fps     float64
	jitMax  time.Duration // how late (after its ideal time) the latest frame came, worst this second
	jit     time.Duration
	tooLate int // frames that came later than the mixer's cushion
	lateSec int
}

// w, h: the size it is captured at (the camera's own; 0 = the output size). It is scaled to the output when drawn,
// so a 1080p camera in a 4K output is captured — and piped — at 1080p.
func newCamera(e *Engine, id string, args []string, fps float64, w, h int) *Camera {
	if w < 16 || h < 16 || w%2 != 0 || h%2 != 0 {
		w, h = e.W, e.H
	}
	c := &Camera{id: id, args: args, e: e, held: -1, filling: 0, period: e.period, lock: true, W: w, H: h}
	if fps > 1 {
		c.period = time.Duration(float64(time.Second) / fps)
		// a 59.94 camera into a 60 output (or the other way): show it, but never pull the output clock to it
		outFps := float64(e.fpsNum) / float64(e.fpsDen)
		c.lock = abs(fps-outFps) < 0.01
	}
	for i := range c.bufs {
		c.bufs[i] = newFrame(w, h)
		fillBlack(c.bufs[i])
	}
	go c.loop()
	return c
}

func (c *Camera) setStatus(ok bool, text string) {
	c.mu.Lock()
	changed := c.ok != ok || c.status != text
	c.ok, c.status = ok, text
	c.mu.Unlock()
	if changed {
		send(Msg{"ev": "cam-status", "id": c.id, "ok": ok, "text": text}, nil)
	}
}

func (c *Camera) inRing(b int) bool {
	for _, s := range c.ring {
		if s.buf == b {
			return true
		}
	}
	return false
}

// a frame arrived: place it on the camera's steady timeline
func (c *Camera) arrived(now time.Time) {
	T := c.period
	c.mu.Lock()
	defer c.mu.Unlock()
	c.count++
	c.secN++
	c.lastAt = now
	var ideal time.Time
	if c.ideal.IsZero() {
		ideal = now
	} else {
		ideal = c.ideal.Add(T)
		d := now.Sub(ideal)
		switch {
		case d < 0 || d > 6*T: // earlier than the line (it moves down), or the card stopped for a while (start again)
			ideal = now
		default: // later than the line: creep toward it slowly, so the line follows the card's clock
			ideal = ideal.Add(d / 256)
		}
	}
	if d := now.Sub(ideal); d > c.jitMax {
		c.jitMax = d
	}
	if now.Sub(ideal) > camLatency {
		c.lateSec++
	}
	c.ideal = ideal
	c.ring = append(c.ring, camSlot{buf: c.filling, n: c.count, ideal: ideal})
	if len(c.ring) > camKeep {
		c.ring = c.ring[len(c.ring)-camKeep:]
	}
	for i := 0; i < camBufs; i++ {
		if i != c.held && !c.inRing(i) {
			c.filling = i
			break
		}
	}
}

func (c *Camera) loop() {
	for attempt := 0; ; attempt++ {
		c.mu.Lock()
		if c.stopped {
			c.mu.Unlock()
			return
		}
		c.mu.Unlock()
		args := append([]string{"-hide_banner", "-loglevel", "error", "-nostats", "-nostdin"}, c.args...)
		// every frame exactly as the card delivers it (no copies added to fill gaps: the mixer counts real gaps)
		args = append(args, "-an", "-sn", "-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", "yuv420p", "-s", fmt.Sprintf("%dx%d", c.W, c.H), "-")
		cmd := exec.Command(c.e.ffmpeg, args...)
		procAttr(cmd, true)
		out, err := cmd.StdoutPipe()
		if err != nil {
			c.setStatus(false, err.Error())
			time.Sleep(2 * time.Second)
			continue
		}
		errp, _ := cmd.StderrPipe()
		var lastErr string
		var errMu sync.Mutex
		if err := cmd.Start(); err != nil {
			c.setStatus(false, "could not start FFmpeg: "+err.Error())
			time.Sleep(3 * time.Second)
			continue
		}
		c.mu.Lock()
		c.cmd = cmd
		c.ideal = time.Time{}
		c.mu.Unlock()
		go func() {
			sc := bufio.NewScanner(errp)
			for sc.Scan() {
				line := strings.TrimSpace(sc.Text())
				if line == "" {
					continue
				}
				errMu.Lock()
				lastErr = line
				errMu.Unlock()
				logOnce("cam-err-"+c.id+line, 30*time.Second, "camera %s: %s", c.id, line)
			}
		}()
		c.setStatus(false, "Connecting…")
		r := bufio.NewReaderSize(out, 4<<20)
		got := 0
		for {
			c.mu.Lock()
			buf := c.bufs[c.filling]
			c.mu.Unlock()
			if _, err := io.ReadFull(r, buf.Buf); err != nil {
				break
			}
			c.arrived(time.Now())
			got++
			if got == 2 {
				c.setStatus(true, "Running")
			}
		}
		cmd.Wait()
		c.mu.Lock()
		stopped := c.stopped
		c.cmd = nil
		c.mu.Unlock()
		if stopped {
			return
		}
		errMu.Lock()
		le := lastErr
		errMu.Unlock()
		if le == "" {
			le = "the capture stopped"
		}
		c.setStatus(false, "No picture — retrying ("+le+")")
		time.Sleep(2 * time.Second)
	}
}

// how far behind "now" the mixer shows the camera: frames may come this late through the pipe without a hitch
const camLatency = 2 * 16683 * time.Microsecond

// the frame for output time t (its ideal time at most camLatency before t), kept still until release()
func (c *Camera) acquireAt(t time.Time) (*Frame, uint64, time.Time) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.ring) == 0 {
		return nil, c.count, time.Time{}
	}
	target := t.Add(-camLatency)
	pick := 0 // the oldest, if all are newer than wanted (just started)
	for i := len(c.ring) - 1; i >= 0; i-- {
		if !c.ring[i].ideal.After(target) {
			pick = i
			break
		}
	}
	s := c.ring[pick]
	c.held = s.buf
	return c.bufs[s.buf], s.n, s.ideal
}

// the newest frame (small pictures for the window)
func (c *Camera) acquire() (*Frame, uint64, time.Time) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.ring) == 0 {
		return nil, c.count, c.lastAt
	}
	s := c.ring[len(c.ring)-1]
	c.held = s.buf
	return c.bufs[s.buf], s.n, s.ideal
}

func (c *Camera) release() {
	c.mu.Lock()
	c.held = -1
	c.mu.Unlock()
}

func (c *Camera) stop() {
	c.mu.Lock()
	c.stopped = true
	cmd := c.cmd
	c.mu.Unlock()
	if cmd != nil && cmd.Process != nil {
		cmd.Process.Kill()
	}
}

func (c *Camera) secondTick() {
	c.mu.Lock()
	c.fps = float64(c.secN)
	c.secN = 0
	c.jit, c.jitMax = c.jitMax, 0
	c.tooLate, c.lateSec = c.lateSec, 0
	c.mu.Unlock()
}

func abs(v float64) float64 {
	if v < 0 {
		return -v
	}
	return v
}
