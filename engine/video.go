package main

import (
	"bufio"
	"fmt"
	"io"
	"math"
	"os/exec"
	"regexp"
	"strings"
	"sync"
	"time"
)

/*
A video file: FFmpeg decodes it at the output frame rate; the mixer takes exactly one frame per output frame

	while it plays (the pipe makes FFmpeg wait while paused). The sound still plays in Live Studio's window.
	FFmpeg decodes on the graphics card when it can (-hwaccel auto: a 4K HEVC phone video took two processor cores
	in software, and at a full processor the video stuttered on air); if that fails before the first picture it
	tries once more on the processor.
*/
type Video struct {
	id, path string
	name     string
	loop     bool
	soft     bool    // the graphics card could not decode it: the processor does
	step     int     // output frames per decoded frame: 2 for a 29.97 video in a 59.94 program (half the data)
	phase    int     // output frames the current picture has been shown
	srcFps   float64 // the file's own frame rate (0: not known)
	probed   bool
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

func newVideo(e *Engine, id, path, name string, loop bool) *Video {
	if name == "" {
		name = id
	}
	v := &Video{id: id, path: path, name: name, loop: loop, e: e, free: make(chan *Frame, 6), step: 1}
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
	v.phase = 99 // the new position's first picture as soon as it comes
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

// what FFmpeg says about the file and the decoding (it prints this before the first picture)
var (
	reVidStream = regexp.MustCompile(`Stream #0:\d+.*?: Video: (\w+)`)
	reVidSize   = regexp.MustCompile(`, (\d{2,5})x(\d{2,5})`)
	reVidFps    = regexp.MustCompile(`, ([\d.]+) fps`)
	reVidHW     = regexp.MustCompile(`Using auto hwaccel type (\w+)`)
)

// the file's own frame rate, from FFmpeg's description of it (0 if it can't tell)
func probeFps(ffmpeg, path string) float64 {
	cmd := exec.Command(ffmpeg, "-hide_banner", "-nostdin", "-i", path)
	procAttr(cmd, 0)
	out, _ := cmd.CombinedOutput() // (FFmpeg says it needs an output file: fine, the description came first)
	for _, l := range strings.Split(string(out), "\n") {
		if reVidStream.MatchString(l) {
			if f := reVidFps.FindStringSubmatch(l); f != nil {
				var x float64
				fmt.Sscanf(f[1], "%g", &x)
				return x
			}
			return 0
		}
	}
	return 0
}

func (v *Video) decode(gen int, t float64) {
	e := v.e
	v.mu.Lock()
	soft, probed := v.soft, v.probed
	v.mu.Unlock()
	if !probed {
		fps := probeFps(e.ffmpeg, v.path)
		v.mu.Lock()
		v.srcFps, v.probed = fps, true
		v.mu.Unlock()
	}
	// a video at half the program's rate or less (29.97 in 59.94) comes at half the rate and each picture shows
	// twice, instead of FFmpeg sending every picture twice through the pipe
	out := float64(e.fpsNum) / float64(e.fpsDen)
	step := 1
	v.mu.Lock()
	if v.srcFps > 0 && v.srcFps <= out/2+0.6 {
		step = 2
	}
	if v.gen == gen {
		v.step = step
	}
	v.mu.Unlock()
	args := []string{"-hide_banner", "-loglevel", "verbose", "-nostats", "-nostdin"}
	if !soft {
		args = append(args, "-hwaccel", "auto")
	}
	if v.loop {
		args = append(args, "-stream_loop", "-1")
	}
	if t > 0.05 {
		args = append(args, "-ss", fmt.Sprintf("%.3f", t))
	}
	args = append(args, "-i", v.path, "-an", "-sn",
		"-vf", fmt.Sprintf("scale=%d:%d:force_original_aspect_ratio=decrease,pad=%d:%d:(ow-iw)/2:(oh-ih)/2,setsar=1", e.W, e.H, e.W, e.H),
		"-r", fmt.Sprintf("%d/%d", e.fpsNum, e.fpsDen*step), "-f", "rawvideo", "-pix_fmt", "yuv420p", "-")
	cmd := exec.Command(e.ffmpeg, args...)
	procAttr(cmd, 0) // normal: it is on air like the cameras, but must not crowd out the engine and the encoders
	pr, pw, err := bigPipe()
	if err != nil {
		return
	}
	cmd.Stdout = pw
	errp, _ := cmd.StderrPipe()
	err = cmd.Start()
	pw.Close() // (FFmpeg has its own copy)
	if err != nil {
		pr.Close()
		logf("video %s: could not start FFmpeg: %v", v.id, err)
		return
	}
	defer pr.Close()
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
	var infoMu sync.Mutex
	var codec, hw, hwFail string
	var errs []string
	errDone := make(chan struct{})
	go func() {
		defer close(errDone)
		sc := bufio.NewScanner(errp)
		for sc.Scan() {
			l := strings.TrimSpace(sc.Text())
			infoMu.Lock()
			if m := reVidStream.FindStringSubmatch(l); m != nil && codec == "" { // the file's (the first one)
				codec = m[1]
				if z := reVidSize.FindStringSubmatch(l); z != nil {
					codec += " " + z[1] + "×" + z[2]
				}
				if f := reVidFps.FindStringSubmatch(l); f != nil {
					codec += " " + f[1] + " fps"
				}
			} else if m := reVidHW.FindStringSubmatch(l); m != nil {
				hw = m[1]
			} else if strings.Contains(l, "Failed setup for format") || strings.Contains(l, "hwaccel initialisation returned error") ||
				(strings.Contains(l, "AVHWFramesContext") && strings.Contains(l, "rror")) {
				// the graphics card took it on but could not: FFmpeg goes on with the processor
				if hwFail == "" {
					hwFail = l
					if i := strings.Index(l, "] "); i >= 0 {
						hwFail = l[i+2:]
					}
				}
			} else if strings.Contains(l, "Device creation") || strings.Contains(l, "AVHWDeviceContext") || strings.Contains(l, "hwaccel") ||
				strings.Contains(l, "packets read") || strings.Contains(l, "frames decoded") || strings.Contains(l, "packets muxed") || strings.Contains(l, "frames encoded") {
				// trying the graphics card's decoders one by one: not worth a line in the log
			} else if strings.Contains(l, "rror") || strings.Contains(l, "ailed") || strings.Contains(l, "nvalid") {
				if len(errs) < 6 {
					errs = append(errs, l)
				}
				infoMu.Unlock()
				logOnce("vid-"+v.id+l, 30*time.Second, "video %s: %s", v.name, l)
				continue
			}
			infoMu.Unlock()
		}
	}()
	frames := 0
	r := pr // (straight into the frame: no second copy through a read buffer)
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
		if frames++; frames == 1 {
			time.AfterFunc(700*time.Millisecond, func() { // (FFmpeg's own lines may still be on their way)
				infoMu.Lock()
				c, h, hf := codec, hw, hwFail
				infoMu.Unlock()
				how := "decoded by the processor"
				if step == 2 {
					c += fmt.Sprintf(" · sent at %.4g fps, each picture shown twice", out/2)
				}
				if h != "" && hf != "" {
					how = "decoded by the processor (the graphics card, " + h + ", could not: " + hf + ")"
				} else if h != "" {
					how = "decoded on the graphics card (" + h + ")"
				} else if !soft {
					how = "decoded by the processor (the graphics card can't decode this one)"
				}
				if c == "" {
					c = "?"
				}
				logOnce("vid-info-"+v.id, 20*time.Second, "video %s: %s · %s", v.name, c, how)
			})
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
	<-errDone
	v.mu.Lock()
	retry := v.gen == gen && frames == 0 && !v.soft
	if retry {
		v.soft = true
	} else if v.gen == gen {
		v.ended = true
	}
	v.mu.Unlock()
	if retry { // nothing came with the graphics card: once more on the processor
		infoMu.Lock()
		why := strings.Join(errs, " / ")
		infoMu.Unlock()
		logf("video %s: no picture with graphics-card decoding — decoding on the processor instead (%s)", v.name, why)
		go v.decode(gen, t)
	}
}

// called once per output frame: the frame to show
func (v *Video) frame() *Frame {
	v.mu.Lock()
	ch, playing, cur, step := v.next, v.playing, v.cur, v.step
	// phase: how many frames the picture on screen has been shown; step 2 = a new picture every other frame
	due := cur == nil || (playing && v.phase >= step)
	if playing && !due {
		v.phase++
	}
	v.mu.Unlock()
	if due {
		select {
		case f := <-ch:
			v.mu.Lock()
			old := v.cur
			v.cur = f
			v.phase = 1
			if playing && old != nil {
				v.pos += float64(step) * float64(v.e.fpsDen) / float64(v.e.fpsNum)
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
