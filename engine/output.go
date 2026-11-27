package main

import (
	"bufio"
	"io"
	"net"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

/* frames shared by the encoders: back to the pool when every encoder has written them */
type OutFrame struct {
	f    *Frame
	refs int32
	pool chan *Frame
}

func (o *OutFrame) release() {
	if atomic.AddInt32(&o.refs, -1) == 0 {
		select {
		case o.pool <- o.f:
		default:
		}
	}
}

/*
An encoder (YouTube or recording): FFmpeg reads the picture from its input pipe and the sound from a local

	connection. Live Studio builds its options; "{AUDIOPORT}" is replaced here.
*/
type Output struct {
	id      string
	e       *Engine
	cmd     *exec.Cmd
	stdin   io.WriteCloser
	vch     chan *OutFrame
	ach     chan []byte
	ln      net.Listener
	closing bool
	dropped int64
	started time.Time
	live    atomic.Bool // FFmpeg has connected for the sound: frames go to it from now on
	src     string      // ISO: record this camera instead of the program
	iso     *OutFrame   // ISO: this tick's picture
	group   string      // started together with others: frames begin for all of them on the same tick
	gsize   int
	encName string       // encoded inside the engine by this (else by FFmpeg)
	encNs   atomic.Int64 // time spent encoding since the last report, and how many pictures
	encN    atomic.Int64
}

func max64(a, b int64) int64 {
	if a > b {
		return a
	}
	return b
}

// once an encoder inside the engine has failed while on air, the outputs that follow go the FFmpeg way
var encGaveUp atomic.Bool

/*
The encoder inside the engine for one output, opened on a thread of its own that it keeps (the card's encoder belongs
to the thread that opened it). Nil when it is not to be used: not asked for, its test did not pass, or it would not open.
The thread waits for the output to be ready (begin), encodes until the pictures end, and closes the encoder.
*/
type encThread struct {
	enc   picEncoder
	begin chan *Output // nil: not needed after all
	done  chan struct{}
}

func startEncThread(id string, c *encCfg, ffmpeg string) *encThread {
	if c == nil || encGaveUp.Load() {
		return nil
	}
	if p := probeEncoder(*c, ffmpeg); !p.OK {
		return nil
	}
	t := &encThread{begin: make(chan *Output, 1), done: make(chan struct{})}
	opened := make(chan error, 1)
	go func() {
		runtime.LockOSThread() // (never unlocked: the thread ends with this function)
		defer close(t.done)
		enc, err := newEncoder(*c)
		if err != nil {
			opened <- err
			return
		}
		t.enc = enc
		opened <- nil
		o := <-t.begin
		if o == nil {
			enc.close()
			return
		}
		o.encodeLoop(enc)
	}()
	select {
	case err := <-opened:
		if err != nil {
			logf("output %s: the encoder inside the engine would not open (%v) — FFmpeg encodes this one", id, err)
			return nil
		}
	case <-time.After(10 * time.Second):
		logf("output %s: the encoder inside the engine did not open in 10 s — FFmpeg encodes this one", id)
		t.begin <- nil
		return nil
	}
	return t
}

// pictures in, H.264 out to FFmpeg's pipe
func (o *Output) encodeLoop(enc picEncoder) {
	ok := true
	for f := range o.vch {
		if ok {
			t0 := time.Now()
			au, err := enc.encode(f.f)
			o.encNs.Add(int64(time.Since(t0)))
			o.encN.Add(1)
			if err != nil {
				// the output ends here (FFmpeg closes the stream / file); Live Studio starts it again, encoded by FFmpeg
				ok = false
				encGaveUp.Store(true)
				logf("output %s: the encoder inside the engine stopped (%v) — from now on FFmpeg encodes", o.id, err)
				send(Msg{"ev": "enc-failed", "id": o.id, "error": err.Error()}, nil)
				o.stdin.Close()
			} else if len(au) > 0 {
				if _, err := o.stdin.Write(au); err != nil {
					ok = false
				}
			}
		}
		f.release()
	}
	if tail := enc.close(); ok && len(tail) > 0 {
		o.stdin.Write(tail)
	}
	o.stdin.Close()
}

// enc, encArgs, skipMs: encode inside the engine if that works here, with these FFmpeg options (ready-made H.264 in) and
// this much of the sound left out at the start, so that picture and sound line up without -itsoffset
func (e *Engine) startOutput(id string, args []string, src, group string, gsize, prio int, enc *encCfg, encArgs []string, skipMs int) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		send(Msg{"ev": "out-exit", "id": id, "code": -1, "error": "no local port for the sound: " + err.Error()}, nil)
		return
	}
	et := startEncThread(id, enc, e.ffmpeg)
	if et != nil {
		args = encArgs
	}
	giveUpEnc := func() {
		if et != nil {
			et.begin <- nil
		}
	}
	port := strconv.Itoa(ln.Addr().(*net.TCPAddr).Port)
	a := make([]string, len(args))
	for i, s := range args {
		a[i] = strings.ReplaceAll(s, "{AUDIOPORT}", port)
	}
	cmd := exec.Command(e.ffmpeg, a...)
	procAttr(cmd, prio)
	pr, stdin, err1 := bigPipe()
	if err1 == nil {
		cmd.Stdin = pr
	}
	errp, err2 := cmd.StderrPipe()
	if err1 != nil || err2 != nil {
		if err1 == nil {
			pr.Close()
			stdin.Close()
		}
		ln.Close()
		giveUpEnc()
		send(Msg{"ev": "out-exit", "id": id, "code": -1, "error": "pipe error"}, nil)
		return
	}
	err = cmd.Start()
	pr.Close() // (the encoder has its own copy)
	if err != nil {
		stdin.Close()
		ln.Close()
		giveUpEnc()
		send(Msg{"ev": "out-exit", "id": id, "code": -1, "error": "Encoder could not start: " + err.Error()}, nil)
		return
	}
	o := &Output{id: id, e: e, cmd: cmd, stdin: stdin, vch: make(chan *OutFrame, 20), ach: make(chan []byte, 600), ln: ln, started: time.Now(), src: src, group: group, gsize: gsize}
	skip := 0 // bytes of sound (16-bit stereo, 48 kHz) left out at the start
	if et != nil {
		o.encName = et.enc.info()
		if skipMs > 0 && skipMs < 5000 {
			skip = skipMs * 48 * 4
		}
	}
	e.mu.Lock()
	e.outputs[id] = o
	e.mu.Unlock()
	send(Msg{"ev": "out-started", "id": id, "pid": cmd.Process.Pid, "enc": o.encName}, nil)

	go func() { // FFmpeg's messages and once-a-second stats go to Live Studio as they are
		sc := bufio.NewScanner(errp)
		sc.Split(scanLinesCR)
		for sc.Scan() {
			if l := strings.TrimSpace(sc.Text()); l != "" {
				send(Msg{"ev": "out-log", "id": id, "line": l}, nil)
			}
		}
	}()
	var wg sync.WaitGroup
	wg.Add(2)
	if et != nil { // picture, encoded here (on the encoder's own thread)
		et.begin <- o
		go func() {
			defer wg.Done()
			<-et.done
		}()
	} else {
		go func() { // picture as it is; FFmpeg encodes
			defer wg.Done()
			ok := true
			for f := range o.vch {
				if ok {
					if _, err := o.stdin.Write(f.f.Buf); err != nil {
						ok = false
					}
				}
				f.release()
			}
			o.stdin.Close()
		}()
	}
	go func() { // sound
		defer wg.Done()
		ln.(*net.TCPListener).SetDeadline(time.Now().Add(30 * time.Second))
		conn, err := ln.Accept()
		ln.Close()
		if err == nil {
			o.live.Store(true)
		}
		for b := range o.ach {
			if skip > 0 {
				if len(b) <= skip {
					skip -= len(b)
					continue
				}
				b, skip = b[skip:], 0
			}
			if err == nil && conn != nil {
				if _, werr := conn.Write(b); werr != nil {
					err = werr
				}
			}
		}
		if conn != nil {
			conn.Close()
		}
	}()
	go func() {
		err := cmd.Wait()
		code := 0
		if err != nil {
			if ee, ok := err.(*exec.ExitError); ok {
				code = ee.ExitCode()
			} else {
				code = -1
			}
		}
		ln.Close() // a sound connection that never came is given up now
		e.mu.Lock()
		if !o.closing {
			o.closing = true
			close(o.vch)
			close(o.ach)
		}
		delete(e.outputs, id)
		e.mu.Unlock()
		wg.Wait()
		send(Msg{"ev": "out-exit", "id": id, "code": code}, nil)
	}()
}

// finish: no more frames; FFmpeg closes the file / stream by itself
func (e *Engine) stopOutput(id string, kill bool) {
	e.mu.Lock()
	o := e.outputs[id]
	if o != nil && !o.closing {
		o.closing = true
		close(o.vch)
		close(o.ach)
	}
	e.mu.Unlock()
	if o != nil && kill && o.cmd.Process != nil {
		o.cmd.Process.Kill()
	}
	if o != nil && !kill {
		go func() { // a stuck encoder is ended after 10 s
			time.Sleep(10 * time.Second)
			if o.cmd.ProcessState == nil && o.cmd.Process != nil {
				o.cmd.Process.Kill()
			}
		}()
	}
}

// a group (the recording and its ISO files) starts when all its encoders are ready — at most 5 s after the first
func (e *Engine) groupReady(g string, size int) bool {
	if e.groupGo[g] {
		return true
	}
	n, live := 0, 0
	var first time.Time
	for _, x := range e.outputs {
		if x.group != g {
			continue
		}
		n++
		if x.live.Load() {
			live++
		}
		if first.IsZero() || x.started.Before(first) {
			first = x.started
		}
	}
	if (live >= size && live == n) || (!first.IsZero() && time.Since(first) > 5*time.Second) {
		e.groupGo[g] = true
		logf("outputs %s start together (%d of %d ready)", g, live, size)
	}
	return e.groupGo[g]
}

// called by the clock with the engine lock held
func (e *Engine) dispatch(of *OutFrame, pcm []byte) {
	for _, o := range e.outputs {
		f := of
		if o.src != "" {
			f, o.iso = o.iso, nil
			if f == nil {
				continue
			}
		}
		if o.closing || !o.live.Load() || (o.group != "" && !e.groupReady(o.group, o.gsize)) {
			if o.src != "" {
				f.release()
			}
			continue
		}
		// picture and sound are dropped together, so they always stay paired
		if len(o.vch) < cap(o.vch) && len(o.ach) < cap(o.ach) {
			if o.src == "" {
				atomic.AddInt32(&f.refs, 1)
			}
			o.vch <- f
			o.ach <- pcm
		} else {
			o.dropped++
			if o.src != "" {
				f.release()
			}
		}
	}
}

// FFmpeg ends its progress lines with \r
func scanLinesCR(data []byte, atEOF bool) (int, []byte, error) {
	for i, b := range data {
		if b == '\n' || b == '\r' {
			return i + 1, data[:i], nil
		}
	}
	if atEOF && len(data) > 0 {
		return len(data), data, nil
	}
	return 0, nil, nil
}
