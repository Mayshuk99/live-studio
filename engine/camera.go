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

	Three buffers: one being filled, the newest finished one, and one the mixer may be reading.
*/
type Camera struct {
	id      string
	args    []string
	e       *Engine
	mu      sync.Mutex
	bufs    [3]*Frame
	latest  int
	held    int
	filling int
	count   uint64
	lastAt  time.Time
	ok      bool
	status  string
	stopped bool
	cmd     *exec.Cmd
	secN    int // frames this second
	fps     float64
}

func newCamera(e *Engine, id string, args []string) *Camera {
	c := &Camera{id: id, args: args, e: e, latest: -1, held: -1, filling: 0}
	for i := range c.bufs {
		c.bufs[i] = newFrame(e.W, e.H)
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

func (c *Camera) loop() {
	frameSize := c.e.W * c.e.H * 3 / 2
	for attempt := 0; ; attempt++ {
		c.mu.Lock()
		if c.stopped {
			c.mu.Unlock()
			return
		}
		c.mu.Unlock()
		args := append([]string{"-hide_banner", "-loglevel", "error", "-nostats", "-nostdin"}, c.args...)
		// every frame exactly as the card delivers it (no copies added to fill gaps: the mixer counts real gaps)
		args = append(args, "-an", "-sn", "-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", "yuv420p", "-s", fmt.Sprintf("%dx%d", c.e.W, c.e.H), "-")
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
			now := time.Now()
			got++
			if got == 2 {
				c.setStatus(true, "Running")
			}
			c.mu.Lock()
			c.latest = c.filling
			c.count++
			c.secN++
			c.lastAt = now
			for i := 0; i < 3; i++ {
				if i != c.latest && i != c.held {
					c.filling = i
					break
				}
			}
			c.mu.Unlock()
		}
		_ = frameSize
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

// the newest frame, kept still until release()
func (c *Camera) acquire() (*Frame, uint64, time.Time) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.latest < 0 {
		return nil, c.count, c.lastAt
	}
	c.held = c.latest
	return c.bufs[c.held], c.count, c.lastAt
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
	c.mu.Unlock()
}
