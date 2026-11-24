package main

import (
	"bufio"
	"io"
	"net"
	"os/exec"
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
}

func (e *Engine) startOutput(id string, args []string) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		send(Msg{"ev": "out-exit", "id": id, "code": -1, "error": "no local port for the sound: " + err.Error()}, nil)
		return
	}
	port := strconv.Itoa(ln.Addr().(*net.TCPAddr).Port)
	a := make([]string, len(args))
	for i, s := range args {
		a[i] = strings.ReplaceAll(s, "{AUDIOPORT}", port)
	}
	cmd := exec.Command(e.ffmpeg, a...)
	procAttr(cmd, false)
	stdin, err1 := cmd.StdinPipe()
	errp, err2 := cmd.StderrPipe()
	if err1 != nil || err2 != nil {
		ln.Close()
		send(Msg{"ev": "out-exit", "id": id, "code": -1, "error": "pipe error"}, nil)
		return
	}
	if err := cmd.Start(); err != nil {
		ln.Close()
		send(Msg{"ev": "out-exit", "id": id, "code": -1, "error": "Encoder could not start: " + err.Error()}, nil)
		return
	}
	o := &Output{id: id, e: e, cmd: cmd, stdin: stdin, vch: make(chan *OutFrame, 20), ach: make(chan []byte, 600), ln: ln, started: time.Now()}
	e.mu.Lock()
	e.outputs[id] = o
	e.mu.Unlock()
	send(Msg{"ev": "out-started", "id": id, "pid": cmd.Process.Pid}, nil)

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
	go func() { // picture
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
	go func() { // sound
		defer wg.Done()
		ln.(*net.TCPListener).SetDeadline(time.Now().Add(30 * time.Second))
		conn, err := ln.Accept()
		ln.Close()
		if err == nil {
			o.live.Store(true)
		}
		for b := range o.ach {
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

// called by the clock with the engine lock held
func (e *Engine) dispatch(of *OutFrame, pcm []byte) {
	for _, o := range e.outputs {
		if o.closing || !o.live.Load() {
			continue
		}
		// picture and sound are dropped together, so they always stay paired
		if len(o.vch) < cap(o.vch) && len(o.ach) < cap(o.ach) {
			atomic.AddInt32(&of.refs, 1)
			o.vch <- of
			o.ach <- pcm
		} else {
			o.dropped++
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
