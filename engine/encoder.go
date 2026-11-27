package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

/*
A picture encoder inside the engine, the way OBS does it: the program's pictures go straight from the engine's memory
to the graphics card's encoder, and only the finished H.264 (a few megabits a second) goes on to FFmpeg, which adds
the sound and sends or saves it. Without it every picture travels to an FFmpeg process through a pipe first
(187 MB a second per encoder at 1080p59.94).

So far: NVIDIA (nvenc_windows.go). Anything that does not work — no NVIDIA card, an old driver, a failed test —
and the output is encoded by FFmpeg as before.
*/
type encCfg struct {
	Kind           string // "nvenc" ("x264pipe": a stand-in for tests, see below)
	W, H           int
	FpsNum, FpsDen int
	Kbps           int // average
	MaxKbps        int
	BufKbps        int
	Gop            int    // pictures between key frames
	Preset         int    // 1 (quickest) … 7 (best)
	Profile        string // baseline / main / high
	CBR            bool
	Tune           string // "ll" low latency (as the stream uses through FFmpeg), "hq"
}

type picEncoder interface {
	// one picture in, its H.264 out (Annex B; may be empty while the encoder is still filling up).
	// Called on the thread that opened the encoder, always.
	encode(f *Frame) ([]byte, error)
	close() []byte // and whatever was still inside
	info() string
}

// the stand-in may be asked for only when a test sets this (the build's self-test, the sync test)
var testEncoders = os.Getenv("LS_ENGINE_TEST_ENC") == "1"

func encCfgOf(m Msg, e *Engine) *encCfg {
	if m == nil {
		return nil
	}
	c := &encCfg{Kind: m.str("kind"), W: e.W, H: e.H, FpsNum: e.fpsNum, FpsDen: e.fpsDen, Kbps: int(m.num("kbps")), MaxKbps: int(m.num("maxKbps")), BufKbps: int(m.num("bufKbps")),
		Gop: int(m.num("gop")), Preset: int(m.num("preset")), Profile: m.str("profile"), CBR: m.boolean("cbr"), Tune: m.str("tune")}
	if c.Kind == "" || c.Kbps < 100 {
		return nil
	}
	if c.MaxKbps < c.Kbps {
		c.MaxKbps = c.Kbps
	}
	if c.BufKbps < 1 {
		c.BufKbps = c.Kbps * 2
	}
	if c.Gop < 1 {
		c.Gop = int(float64(c.FpsNum)/float64(c.FpsDen)*2 + 0.5)
	}
	if c.Preset < 1 || c.Preset > 7 {
		c.Preset = 4
	}
	if c.Profile != "baseline" && c.Profile != "main" {
		c.Profile = "high"
	}
	if c.Tune != "hq" {
		c.Tune = "ll"
	}
	return c
}

// (unit tests put their own encoder here)
var encoderHook func(c encCfg) (picEncoder, error)

func newEncoder(c encCfg) (picEncoder, error) {
	if encoderHook != nil {
		return encoderHook(c)
	}
	if c.Kind == "x264pipe" {
		if !testEncoders {
			return nil, errors.New("the stand-in encoder is for tests only")
		}
		return openPipeEncoder(c)
	}
	return openEncoder(c)
}

/*
Is the encoder inside the engine safe to use here? Asked once per picture size and rate, in a process of its own
(this program started again with --nvenc-test): it opens the card's encoder, encodes half a second of pictures and
checks what comes out. A driver that crashes or hangs on our calls ends that process, not the program on air.
*/
type encProbe struct {
	OK     bool   `json:"ok"`
	Error  string `json:"error,omitempty"`
	Stage  string `json:"stage,omitempty"`
	Card   string `json:"card,omitempty"`
	API    string `json:"api,omitempty"`
	Frames int    `json:"frames,omitempty"`
	Bytes  int    `json:"bytes,omitempty"`
	Ms     int    `json:"ms,omitempty"`
	Nals   []int  `json:"nals,omitempty"`
	Match  string `json:"match,omitempty"`  // how close the decoded pictures are to the originals
	NoCard bool   `json:"noCard,omitempty"` // not a failure: there is simply no NVIDIA encoder here
}

var (
	probeMu   sync.Mutex
	probeDone = map[string]encProbe{}
)

func probeEncoder(c encCfg, ffmpeg string) encProbe {
	if encoderHook != nil {
		return encProbe{OK: true}
	}
	if c.Kind == "x264pipe" {
		return encProbe{OK: testEncoders, Card: "stand-in (x264 in a pipe)", Error: "for tests only"}
	}
	key := fmt.Sprintf("%s %dx%d %d/%d", c.Kind, c.W, c.H, c.FpsNum, c.FpsDen)
	probeMu.Lock()
	defer probeMu.Unlock()
	if p, ok := probeDone[key]; ok {
		return p
	}
	p := runProbe(c, ffmpeg)
	probeDone[key] = p
	switch {
	case p.OK:
		logf("NVIDIA encoder inside the engine: test passed on %s (driver interface %s) — %d×%d, %d pictures in %d ms, decoded again they match the originals (%s)", p.Card, p.API, c.W, c.H, p.Frames, p.Ms, p.Match)
	case p.NoCard:
		logf("NVIDIA encoder inside the engine: not here (%s) — FFmpeg encodes, as before", p.Error)
	default:
		logf("NVIDIA encoder inside the engine: test failed at “%s” (%s) — FFmpeg encodes, as before", p.Stage, p.Error)
	}
	return p
}

func runProbe(c encCfg, ffmpeg string) encProbe {
	exe, err := os.Executable()
	if err != nil {
		return encProbe{Error: err.Error(), Stage: "starting the test"}
	}
	cmd := exec.Command(exe, "--nvenc-test", strconv.Itoa(c.W), strconv.Itoa(c.H), strconv.Itoa(c.FpsNum), strconv.Itoa(c.FpsDen), ffmpeg)
	procAttr(cmd, 0)
	var out bytes.Buffer
	cmd.Stdout = &out
	if err := cmd.Start(); err != nil {
		return encProbe{Error: err.Error(), Stage: "starting the test"}
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case err = <-done:
	case <-time.After(20 * time.Second):
		cmd.Process.Kill()
		<-done
		return encProbe{Error: "no answer in 20 s", Stage: "the test"}
	}
	var p encProbe
	lines := bytes.Split(bytes.TrimSpace(out.Bytes()), []byte("\n"))
	if json.Unmarshal(bytes.TrimSpace(lines[len(lines)-1]), &p) != nil {
		msg := "the test ended without a result"
		if err != nil {
			msg += " (" + err.Error() + ")" // e.g. exit status 0xc0000005: the driver crashed on our calls
		}
		return encProbe{Error: msg, Stage: "the test"}
	}
	return p
}

// the test itself (in its own process): half a second of moving bars through the encoder
func encoderSelfTest(args []string) int {
	num := func(i, def int) int {
		if i < len(args) {
			if v, err := strconv.Atoi(args[i]); err == nil && v > 0 {
				return v
			}
		}
		return def
	}
	c := encCfg{Kind: "nvenc", W: num(0, 1920), H: num(1, 1080), FpsNum: num(2, 60000), FpsDen: num(3, 1001), Kbps: 9000, MaxKbps: 9000, BufKbps: 18000, Preset: 4, Profile: "high", CBR: true, Tune: "ll"}
	c.Gop = int(float64(c.FpsNum)/float64(c.FpsDen)*2 + 0.5)
	res := encProbe{}
	say := func(code int) int {
		b, _ := json.Marshal(res)
		fmt.Println(string(b))
		return code
	}
	// (for the build's check of this test itself: the stand-in encoder, and a deliberate colour mix-up it must catch)
	mixUp := false
	if testEncoders && os.Getenv("LS_ENGINE_TEST_KIND") == "x264pipe" {
		c.Kind, mixUp = "x264pipe", os.Getenv("LS_ENGINE_TEST_MIXUP") == "1"
	}
	runtime.LockOSThread() // the encoder belongs to the thread that opens it
	t0 := time.Now()
	enc, err := newEncoder(c)
	if err != nil {
		var ne *noEncoderError
		res.Error, res.Stage = err.Error(), "opening the encoder"
		if errors.As(err, &ne) {
			res.NoCard = true
			return say(2)
		}
		return say(1)
	}
	res.Card = enc.info()
	if a, ok := enc.(interface{ api() string }); ok {
		res.API = a.api()
	}
	f := newFrame(c.W, c.H)
	const n = 30
	var all []byte
	for i := 0; i < n; i++ {
		testPicture(f, i)
		if mixUp {
			u, v := f.U(), f.V()
			for j := range u {
				u[j], v[j] = v[j], u[j]
			}
		}
		au, err := enc.encode(f)
		if err != nil {
			enc.close()
			res.Error, res.Stage = err.Error(), fmt.Sprintf("encoding picture %d", i+1)
			return say(1)
		}
		all = append(all, au...)
	}
	all = append(all, enc.close()...)
	res.Ms = int(time.Since(t0).Milliseconds())
	res.Bytes = len(all)
	// what came out: one picture (a slice: part kind 1 or 5) per picture that went in, the first a complete key frame
	for i, t := range nalTypes(all) {
		if t == 1 || t == 5 {
			res.Frames++
		}
		if res.Frames <= 1 && i < 12 {
			res.Nals = append(res.Nals, t)
		}
	}
	has := func(t int) bool {
		for _, x := range res.Nals {
			if x == t {
				return true
			}
		}
		return false
	}
	switch {
	case res.Frames != n:
		res.Error, res.Stage = fmt.Sprintf("%d of %d pictures came out", res.Frames, n), "checking the result"
	case !has(7) || !has(8) || !has(5):
		res.Error, res.Stage = fmt.Sprintf("the first picture is not a complete key frame (parts %v)", res.Nals), "checking the result"
	case res.Bytes < n*200:
		res.Error, res.Stage = fmt.Sprintf("only %d bytes for %d pictures", res.Bytes, n), "checking the result"
	default:
		// the real proof: FFmpeg decodes it, and the pictures are the ones that went in (colours in the right places too)
		ffmpeg := ""
		if len(args) > 4 {
			ffmpeg = args[4]
		}
		match, err := decodedMatch(ffmpeg, all, c, n)
		res.Match = match
		if err != nil {
			res.Error, res.Stage = err.Error(), "decoding the result"
			return say(1)
		}
		res.OK = true
		return say(0)
	}
	return say(1)
}

// FFmpeg decodes the encoder's H.264; the first and the last picture are compared with what went in
func decodedMatch(ffmpeg string, h264 []byte, c encCfg, n int) (string, error) {
	if ffmpeg == "" {
		return "", errors.New("FFmpeg was not given")
	}
	cmd := exec.Command(ffmpeg, "-hide_banner", "-loglevel", "error", "-f", "h264", "-i", "pipe:0", "-f", "rawvideo", "-pix_fmt", "yuv420p", "pipe:1")
	procAttr(cmd, 0)
	cmd.Stdin = bytes.NewReader(h264)
	var out, errb bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errb
	done := make(chan error, 1)
	if err := cmd.Start(); err != nil {
		return "", err
	}
	go func() { done <- cmd.Wait() }()
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		cmd.Process.Kill()
		<-done
		return "", errors.New("FFmpeg did not finish decoding in 10 s")
	}
	size := c.W * c.H * 3 / 2
	got := out.Len() / size
	if got < n-1 { // (a decoder may hold the last picture back)
		msg := strings.TrimSpace(errb.String())
		if len(msg) > 200 {
			msg = msg[:200]
		}
		return "", fmt.Errorf("FFmpeg decoded %d of %d pictures %s", got, n, msg)
	}
	want := newFrame(c.W, c.H)
	worst := 99.0
	for _, i := range []int{0, got - 1} {
		testPicture(want, i)
		dec := &Frame{W: c.W, H: c.H, Buf: out.Bytes()[i*size : (i+1)*size]}
		for _, pl := range [][2][]byte{{want.Y(), dec.Y()}, {want.U(), dec.U()}, {want.V(), dec.V()}} {
			if p := psnr(pl[0], pl[1]); p < worst {
				worst = p
			}
		}
	}
	match := fmt.Sprintf("%.0f dB", worst)
	if worst < 24 {
		return match, fmt.Errorf("the decoded pictures do not match what went in (%s; a good encode is above 30)", match)
	}
	return match, nil
}

func psnr(a, b []byte) float64 {
	var se float64
	for i := range a {
		d := float64(int(a[i]) - int(b[i]))
		se += d * d
	}
	if se == 0 {
		return 99
	}
	return 10 * math.Log10(255*255/(se/float64(len(a))))
}

// moving bars with a soft pattern: easy to encode well, and each colour plane has its own shape (a swap would show)
func testPicture(f *Frame, n int) {
	y, u, v := f.Y(), f.U(), f.V()
	bw := f.W/8 + 1
	for r := 0; r < f.H; r++ {
		row := y[r*f.W : (r+1)*f.W]
		for x := range row {
			row[x] = byte(40 + ((x+n*8)/bw)%8*22 + (r*16/f.H)%2*10)
		}
	}
	cw := f.W / 2
	for r := 0; r < f.H/2; r++ {
		for x := 0; x < cw; x++ {
			u[r*cw+x] = byte(70 + ((x*2+n*8)/bw)%4*36)
			v[r*cw+x] = byte(70 + (r*4/(f.H/2))*36)
		}
	}
}

// the kinds of parts (NAL units) in a piece of H.264: 7 = picture format, 8 = its settings, 5 = a key frame's picture, 1 = any other picture
func nalTypes(b []byte) []int {
	var t []int
	for i := 0; i+3 < len(b); i++ {
		if b[i] == 0 && b[i+1] == 0 && b[i+2] == 1 {
			t = append(t, int(b[i+3]&31))
			i += 3
		}
	}
	return t
}

// no encoder of this kind on this computer (as opposed to one that is there and fails)
type noEncoderError struct{ why string }

func (e *noEncoderError) Error() string { return e.why }

/*
A stand-in for tests: x264 in an FFmpeg process, pictures in and H.264 out through pipes. It makes no sense for real
use (it is the detour the real encoder removes) but lets the build and the sync test check everything around the
encoder — the options FFmpeg gets for ready-made H.264, picture and sound staying together, starting and stopping —
on machines without an NVIDIA card.
*/
type pipeEncoder struct {
	cmd   *exec.Cmd
	in    io.WriteCloser
	mu    sync.Mutex
	buf   []byte
	err   error
	sent  int
	got   chan struct{}
	ended chan struct{}
}

func openPipeEncoder(c encCfg) (picEncoder, error) {
	ff := os.Getenv("LS_ENGINE_TEST_FFMPEG")
	if ff == "" {
		ff = "ffmpeg"
	}
	cmd := exec.Command(ff, "-hide_banner", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "yuv420p", "-video_size", fmt.Sprintf("%dx%d", c.W, c.H),
		"-framerate", fmt.Sprintf("%d/%d", c.FpsNum, c.FpsDen), "-i", "pipe:0", "-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency", "-bf", "0",
		"-b:v", fmt.Sprintf("%dk", c.Kbps), "-g", strconv.Itoa(c.Gop), "-x264-params", "aud=1:repeat-headers=1:sliced-threads=0", "-flush_packets", "1", "-f", "h264", "pipe:1")
	in, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	out, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	p := &pipeEncoder{cmd: cmd, in: in, got: make(chan struct{}, 1), ended: make(chan struct{})}
	go func() {
		r := bufio.NewReaderSize(out, 1<<20)
		b := make([]byte, 256<<10)
		for {
			n, err := r.Read(b)
			if n > 0 {
				p.mu.Lock()
				p.buf = append(p.buf, b[:n]...)
				p.mu.Unlock()
				select {
				case p.got <- struct{}{}:
				default:
				}
			}
			if err != nil {
				p.mu.Lock()
				p.err = err
				p.mu.Unlock()
				close(p.ended)
				return
			}
		}
	}()
	return p, nil
}

func (p *pipeEncoder) encode(f *Frame) ([]byte, error) {
	if _, err := p.in.Write(f.Buf); err != nil {
		return nil, err
	}
	p.sent++
	// (with -tune zerolatency each picture comes out before the next goes in: wait for it a moment, so the
	// timing is like the real encoder's)
	select {
	case <-p.got:
	case <-time.After(250 * time.Millisecond):
	case <-p.ended:
	}
	p.mu.Lock()
	b := p.buf
	p.buf = nil
	p.mu.Unlock()
	return b, nil
}

func (p *pipeEncoder) close() []byte {
	p.in.Close()
	select {
	case <-p.ended:
	case <-time.After(3 * time.Second):
		p.cmd.Process.Kill()
		<-p.ended
	}
	p.cmd.Wait()
	p.mu.Lock()
	defer p.mu.Unlock()
	b := p.buf
	p.buf = nil
	return b
}

func (p *pipeEncoder) info() string { return "stand-in (x264 in a pipe)" }
