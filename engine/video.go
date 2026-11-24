package main

import (
	"bufio"
	"fmt"
	"io"
	"math"
	"os/exec"
	"strings"
	"sync"
	"time"
)

/*
A video file: FFmpeg decodes it at the output frame rate; the mixer takes exactly one frame per output frame

	while it plays (the pipe makes FFmpeg wait while paused). The sound still plays in Live Studio's window.
*/
type Video struct {
	id, path string
	loop     bool
	e        *Engine
	mu       sync.Mutex
	cur      *Frame
	next     chan *Frame
	free     chan *Frame
	playing  bool
	pos      float64 // seconds of the frame on screen
	gen      int
	cmd      *exec.Cmd
	ended    bool
	repeats  int
}

func newVideo(e *Engine, id, path string, loop bool) *Video {
	v := &Video{id: id, path: path, loop: loop, e: e, free: make(chan *Frame, 6)}
	v.restart(0)
	return v
}

func (v *Video) restart(t float64) {
	v.mu.Lock()
	if v.cmd != nil && v.cmd.Process != nil {
		v.cmd.Process.Kill()
	}
	v.gen++
	gen := v.gen
	old := v.next
	v.next = make(chan *Frame, 3)
	v.pos = t
	v.ended = false
	v.mu.Unlock()
	if old != nil {
		go func() { // recycle what the old decoder left
			for {
				select {
				case f := <-old:
					v.recycle(f)
				case <-time.After(2 * time.Second):
					return
				}
			}
		}()
	}
	go v.decode(gen, t)
}

func (v *Video) recycle(f *Frame) {
	if f == nil {
		return
	}
	select {
	case v.free <- f:
	default:
	}
}

func (v *Video) decode(gen int, t float64) {
	e := v.e
	args := []string{"-hide_banner", "-loglevel", "error", "-nostats", "-nostdin"}
	if v.loop {
		args = append(args, "-stream_loop", "-1")
	}
	if t > 0.05 {
		args = append(args, "-ss", fmt.Sprintf("%.3f", t))
	}
	args = append(args, "-i", v.path, "-an", "-sn",
		"-vf", fmt.Sprintf("scale=%d:%d:force_original_aspect_ratio=decrease,pad=%d:%d:(ow-iw)/2:(oh-ih)/2,setsar=1", e.W, e.H, e.W, e.H),
		"-r", fmt.Sprintf("%d/%d", e.fpsNum, e.fpsDen), "-f", "rawvideo", "-pix_fmt", "yuv420p", "-")
	cmd := exec.Command(e.ffmpeg, args...)
	procAttr(cmd, false)
	out, err := cmd.StdoutPipe()
	if err != nil {
		return
	}
	errp, _ := cmd.StderrPipe()
	if err := cmd.Start(); err != nil {
		logf("video %s: could not start FFmpeg: %v", v.id, err)
		return
	}
	v.mu.Lock()
	if v.gen != gen {
		v.mu.Unlock()
		cmd.Process.Kill()
		cmd.Wait()
		return
	}
	v.cmd = cmd
	ch := v.next
	v.mu.Unlock()
	go func() {
		sc := bufio.NewScanner(errp)
		for sc.Scan() {
			if l := strings.TrimSpace(sc.Text()); l != "" {
				logOnce("vid-"+v.id+l, 30*time.Second, "video %s: %s", v.id, l)
			}
		}
	}()
	r := bufio.NewReaderSize(out, 4<<20)
	for {
		var f *Frame
		select {
		case f = <-v.free:
		default:
			f = newFrame(e.W, e.H)
		}
		if _, err := io.ReadFull(r, f.Buf); err != nil {
			v.recycle(f)
			break
		}
		v.mu.Lock()
		cur := v.gen == gen
		v.mu.Unlock()
		if !cur {
			v.recycle(f)
			break
		}
		ch <- f // waits while paused / ahead
	}
	cmd.Wait()
	v.mu.Lock()
	if v.gen == gen {
		v.ended = true
	}
	v.mu.Unlock()
}

// called once per output frame: the frame to show
func (v *Video) frame() *Frame {
	v.mu.Lock()
	ch, playing, cur := v.next, v.playing, v.cur
	v.mu.Unlock()
	if cur == nil || playing {
		select {
		case f := <-ch:
			v.mu.Lock()
			old := v.cur
			v.cur = f
			if playing && old != nil {
				v.pos += float64(v.e.fpsDen) / float64(v.e.fpsNum)
			}
			v.mu.Unlock()
			v.recycle(old)
		default:
			if playing && cur != nil {
				v.mu.Lock()
				if !v.ended {
					v.repeats++
				}
				v.mu.Unlock()
			}
		}
	}
	v.mu.Lock()
	defer v.mu.Unlock()
	return v.cur
}

// Live Studio's window played / paused / moved the video
func (v *Video) setState(playing bool, t float64) {
	v.mu.Lock()
	far := math.Abs(t-v.pos) > 0.25 || (v.ended && t < v.pos-0.25)
	v.mu.Unlock()
	if far {
		v.restart(t)
	}
	v.mu.Lock()
	v.playing = playing
	v.mu.Unlock()
}

func (v *Video) stop() {
	v.mu.Lock()
	v.gen++
	if v.cmd != nil && v.cmd.Process != nil {
		v.cmd.Process.Kill()
	}
	v.mu.Unlock()
}
