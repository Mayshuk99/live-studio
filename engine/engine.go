package main

import (
	"encoding/binary"
	"math"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

type Base struct {
	Key, Src   string
	Zoom, X, Y float64
}

type acqInfo struct {
	cnt uint64
	at  time.Time
	ok  bool
}

type Trans struct {
	to    *Base
	start time.Time
	dur   float64 // ms
}

type smoothState struct {
	zoom, x, y float64
	tick       uint64
}

type Still struct {
	f        *Frame
	cache    *Frame
	cacheFor Rect
	cached   bool
}

type Overlay struct {
	id              string
	z               float64
	src             []byte
	sw, sh          int
	bgra, premult   bool
	key             Key
	x, y, w, h      int
	layer           *Layer
	alpha, target   float64
	fadeMs, opacity float64
}

type Engine struct {
	W, H           int
	fpsNum, fpsDen int
	period         time.Duration
	ffmpeg         string
	moveSpeed      float64

	mu     sync.Mutex
	cams   map[string]*Camera
	videos map[string]*Video
	stills map[string]*Still
	colors map[string]*colorLUT
	cur    *Base
	trans  *Trans
	sm     map[string]*smoothState
	black  struct {
		from, to float64
		start    time.Time
		dur      float64
	}
	overlays map[string]*Overlay
	order    []*Overlay
	orderOK  bool
	audio    *Audio
	outputs  map[string]*Output
	pool     chan *Frame
	scA, scB *Frame
	vidTick  map[string]uint64

	pvPgmW, pvPgmH, pvPgmEvery int
	pvCamW, pvCamH, pvCamEvery int
	pvCams                     []string

	clockCam  string
	lastCount uint64
	tickAt    time.Time          // the time this output frame stands for
	acq       map[string]acqInfo // cameras drawn this frame: which frame, when it arrived
	stopped   atomic.Bool

	// stats for the last second
	st struct {
		ticks, late, resync, pgmRepeat, pgmSkip int
		maxLate, renderSum, renderMax           time.Duration
		phaseErr                                time.Duration
	}
}

func newEngine(m Msg) *Engine {
	e := &Engine{
		W: int(m.num("w")), H: int(m.num("h")), fpsNum: int(m.num("fpsNum")), fpsDen: int(m.num("fpsDen")),
		ffmpeg: m.str("ffmpeg"), moveSpeed: 0.12,
		cams: map[string]*Camera{}, videos: map[string]*Video{}, stills: map[string]*Still{}, colors: map[string]*colorLUT{},
		sm: map[string]*smoothState{}, overlays: map[string]*Overlay{}, outputs: map[string]*Output{},
		audio: newAudio(), pool: make(chan *Frame, 64), vidTick: map[string]uint64{}, acq: map[string]acqInfo{},
	}
	if e.W <= 0 || e.H <= 0 {
		e.W, e.H = 1920, 1080
	}
	e.W &^= 1
	e.H &^= 1
	if e.fpsNum <= 0 || e.fpsDen <= 0 {
		e.fpsNum, e.fpsDen = 60000, 1001
	}
	if e.ffmpeg == "" {
		e.ffmpeg = "ffmpeg"
	}
	if m.has("moveSpeed") {
		e.moveSpeed = m.num("moveSpeed")
	}
	e.period = time.Duration(float64(time.Second) * float64(e.fpsDen) / float64(e.fpsNum))
	e.scA, e.scB = newFrame(e.W, e.H), newFrame(e.W, e.H)
	e.black.dur = 1
	return e
}

func ease(t float64) float64 {
	if t < 0.5 {
		return 2 * t * t
	}
	return 1 - math.Pow(-2*t+2, 2)/2
}

func (e *Engine) getFrame() *OutFrame {
	var f *Frame
	select {
	case f = <-e.pool:
	default:
		f = newFrame(e.W, e.H)
	}
	return &OutFrame{f: f, refs: 1, pool: e.pool}
}

/* ---------- commands from Live Studio ---------- */

func baseOf(m Msg) *Base {
	if m == nil || m.str("src") == "" {
		return nil
	}
	b := &Base{Key: m.str("key"), Src: m.str("src"), Zoom: 1, X: 0.5, Y: 0.5}
	if m.has("zoom") {
		b.Zoom = m.num("zoom")
	}
	if m.has("x") {
		b.X = m.num("x")
	}
	if m.has("y") {
		b.Y = m.num("y")
	}
	if b.Key == "" {
		b.Key = b.Src
	}
	return b
}

func keyOf(m Msg) Key {
	k := Key{}
	if m == nil {
		return k
	}
	k.On = m.boolean("on")
	k.R, k.G, k.B = m.num("r"), m.num("g"), m.num("b")
	k.Tol = 0.15
	if m.has("tol") {
		k.Tol = m.num("tol")
	}
	return k
}

func (e *Engine) command(cmd string, m Msg, payload []byte) {
	switch cmd {
	case "camera":
		id := m.str("id")
		c := newCamera(e, id, m.strs("args"), m.num("fps"))
		e.mu.Lock()
		old := e.cams[id]
		e.cams[id] = c
		e.mu.Unlock()
		if old != nil {
			old.stop()
		}
	case "camera-close", "source-remove":
		id := m.str("id")
		e.mu.Lock()
		c, v := e.cams[id], e.videos[id]
		delete(e.cams, id)
		delete(e.videos, id)
		delete(e.stills, id)
		e.mu.Unlock()
		if c != nil {
			c.stop()
		}
		if v != nil {
			v.stop()
		}
	case "color":
		id := m.str("id")
		c := Color{Exposure: m.num("exposure"), Contrast: 1, Saturation: 1, Gamma: 1, Temp: m.num("temp"), Tint: m.num("tint"), Black: m.num("black")}
		if m.has("contrast") {
			c.Contrast = m.num("contrast")
		}
		if m.has("saturation") {
			c.Saturation = m.num("saturation")
		}
		if m.has("gamma") {
			c.Gamma = m.num("gamma")
		}
		var lut *colorLUT
		if !c.neutral() {
			lut = makeColorLUT(c)
		}
		e.mu.Lock()
		if lut == nil {
			delete(e.colors, id)
		} else {
			e.colors[id] = lut
		}
		e.mu.Unlock()
	case "still":
		w, h := int(m.num("w")), int(m.num("h"))
		if w < 2 || h < 2 || len(payload) < w*h*4 {
			return
		}
		f := rgbaToFrame(payload, w, h)
		e.mu.Lock()
		e.stills[m.str("id")] = &Still{f: f}
		e.mu.Unlock()
	case "video":
		id := m.str("id")
		v := newVideo(e, id, m.str("path"), m.boolean("loop"))
		e.mu.Lock()
		old := e.videos[id]
		e.videos[id] = v
		e.mu.Unlock()
		if old != nil {
			old.stop()
		}
	case "video-state":
		e.mu.Lock()
		v := e.videos[m.str("id")]
		e.mu.Unlock()
		if v != nil {
			v.setState(m.boolean("playing"), m.num("t"))
		}
	case "program":
		b := baseOf(m.obj("base"))
		ms := m.num("ms")
		e.mu.Lock()
		if ms <= 0 {
			e.trans = nil
			e.cur = b
		} else {
			if e.trans != nil {
				e.cur = e.trans.to
			}
			e.trans = &Trans{to: b, start: time.Now(), dur: ms}
		}
		e.mu.Unlock()
	case "black":
		e.mu.Lock()
		v := e.blackNow(time.Now())
		to := 0.0
		if m.boolean("on") {
			to = 1
		}
		ms := m.num("ms")
		if ms < 1 {
			ms = 1
		}
		e.black.from, e.black.to, e.black.start, e.black.dur = v, to, time.Now(), ms
		e.mu.Unlock()
	case "move-speed":
		e.mu.Lock()
		e.moveSpeed = m.num("v")
		e.mu.Unlock()
	case "overlay":
		e.setOverlay(m, payload)
	case "overlay-patch":
		e.patchOverlay(m, payload)
	case "overlay-set":
		e.overlaySet(m)
	case "overlay-remove":
		e.mu.Lock()
		delete(e.overlays, m.str("id"))
		e.orderOK = false
		e.mu.Unlock()
	case "audio":
		if len(payload) >= 4 {
			n := len(payload) / 4
			s := make([]float32, n)
			for i := 0; i < n; i++ {
				s[i] = math.Float32frombits(binary.LittleEndian.Uint32(payload[i*4:]))
			}
			ch := int(m.num("ch"))
			if ch < 1 {
				ch = 2
			}
			e.audio.push(s, ch, m.num("rate"))
		}
	case "output-start":
		e.startOutput(m.str("id"), m.strs("args"))
	case "output-stop":
		e.stopOutput(m.str("id"), false)
	case "output-kill":
		e.stopOutput(m.str("id"), true)
	case "preview":
		e.mu.Lock()
		if p := m.obj("pgm"); p != nil {
			e.pvPgmW, e.pvPgmH, e.pvPgmEvery = int(p.num("w")), int(p.num("h")), int(p.num("every"))
		}
		if p := m.obj("cam"); p != nil {
			e.pvCamW, e.pvCamH, e.pvCamEvery = int(p.num("w")), int(p.num("h")), int(p.num("every"))
		}
		if m.has("cams") {
			e.pvCams = m.strs("cams")
		}
		e.mu.Unlock()
	}
}

func (e *Engine) setOverlay(m Msg, payload []byte) {
	id := m.str("id")
	sw, sh := int(m.num("sw")), int(m.num("sh"))
	if sw <= 0 || sh <= 0 || len(payload) < sw*sh*4 {
		return
	}
	e.mu.Lock()
	o := e.overlays[id]
	e.mu.Unlock()
	n := &Overlay{id: id, opacity: 1, fadeMs: 400}
	if o != nil {
		cp := *o
		n = &cp
	}
	n.src = payload[:sw*sh*4]
	n.sw, n.sh = sw, sh
	n.bgra, n.premult = m.boolean("bgra"), m.boolean("premult")
	if m.has("key") {
		n.key = keyOf(m.obj("key"))
	}
	n.x, n.y, n.w, n.h = int(m.num("x")), int(m.num("y")), int(m.num("w")), int(m.num("h"))
	if n.w <= 0 || n.h <= 0 {
		n.w, n.h = sw, sh
	}
	if m.has("z") {
		n.z = m.num("z")
	}
	applyOverlayOpts(n, m)
	n.layer = buildLayer(n.src, n.sw, n.sh, n.bgra, n.premult, n.key, n.x, n.y, n.w, n.h, e.W, e.H)
	e.mu.Lock()
	if cur := e.overlays[id]; cur != nil && o != nil && cur != o {
		// changed meanwhile (fades): keep its current fade state
		n.alpha, n.target = cur.alpha, cur.target
	} else if o != nil && !m.has("alpha") {
		n.alpha = o.alpha
	}
	e.overlays[id] = n
	e.orderOK = false
	e.mu.Unlock()
}

func applyOverlayOpts(n *Overlay, m Msg) {
	if m.has("opacity") {
		n.opacity = m.num("opacity")
	}
	if m.has("fadeMs") {
		n.fadeMs = m.num("fadeMs")
	}
	if m.has("visible") {
		if m.boolean("visible") {
			n.target = 1
		} else {
			n.target = 0
		}
	}
	if m.has("alpha") {
		n.alpha = m.num("alpha")
		n.target = n.alpha
	}
}

// a changed part of a web page
func (e *Engine) patchOverlay(m Msg, payload []byte) {
	id := m.str("id")
	px, py, pw, ph := int(m.num("px")), int(m.num("py")), int(m.num("pw")), int(m.num("ph"))
	e.mu.Lock()
	o := e.overlays[id]
	e.mu.Unlock()
	if o == nil || pw <= 0 || ph <= 0 || len(payload) < pw*ph*4 || px < 0 || py < 0 || px+pw > o.sw || py+ph > o.sh {
		return
	}
	cp := *o
	cp.src = append([]byte(nil), o.src...)
	for r := 0; r < ph; r++ {
		copy(cp.src[((py+r)*o.sw+px)*4:((py+r)*o.sw+px+pw)*4], payload[r*pw*4:(r+1)*pw*4])
	}
	cp.layer = buildLayer(cp.src, cp.sw, cp.sh, cp.bgra, cp.premult, cp.key, cp.x, cp.y, cp.w, cp.h, e.W, e.H)
	e.mu.Lock()
	if cur := e.overlays[id]; cur != nil {
		cp.alpha, cp.target, cp.opacity, cp.fadeMs, cp.z = cur.alpha, cur.target, cur.opacity, cur.fadeMs, cur.z
		e.overlays[id] = &cp
		e.orderOK = false
	}
	e.mu.Unlock()
}

func (e *Engine) overlaySet(m Msg) {
	id := m.str("id")
	e.mu.Lock()
	o := e.overlays[id]
	if o == nil {
		e.mu.Unlock()
		return
	}
	cp := *o
	e.mu.Unlock()
	applyOverlayOpts(&cp, m)
	rebuild := false
	if m.has("z") {
		cp.z = m.num("z")
	}
	if m.has("w") {
		x, y, w, h := int(m.num("x")), int(m.num("y")), int(m.num("w")), int(m.num("h"))
		if x != cp.x || y != cp.y || w != cp.w || h != cp.h {
			cp.x, cp.y, cp.w, cp.h = x, y, w, h
			rebuild = true
		}
	}
	if m.has("key") {
		if k := keyOf(m.obj("key")); k != cp.key {
			cp.key = k
			rebuild = true
		}
	}
	if rebuild {
		cp.layer = buildLayer(cp.src, cp.sw, cp.sh, cp.bgra, cp.premult, cp.key, cp.x, cp.y, cp.w, cp.h, e.W, e.H)
	}
	e.mu.Lock()
	if cur := e.overlays[id]; cur != nil {
		if !m.has("alpha") {
			cp.alpha = cur.alpha
		}
		e.overlays[id] = &cp
		e.orderOK = false
	}
	e.mu.Unlock()
}

func (e *Engine) blackNow(now time.Time) float64 {
	p := float64(now.Sub(e.black.start).Milliseconds()) / e.black.dur
	if p > 1 {
		p = 1
	}
	if p < 0 {
		p = 0
	}
	return e.black.from + (e.black.to-e.black.from)*p
}

/* ---------- drawing one output frame ---------- */

func (e *Engine) smoothFor(b *Base, n uint64) *smoothState {
	s := e.sm[b.Key]
	if s == nil || s.tick+1 < n {
		s = &smoothState{zoom: b.Zoom, x: b.X, y: b.Y, tick: n}
		e.sm[b.Key] = s
		return s
	}
	if s.tick != n {
		k := math.Max(0, math.Min(1, e.moveSpeed*(60*float64(e.fpsDen)/float64(e.fpsNum))))
		s.zoom += (b.Zoom - s.zoom) * k
		s.x += (b.X - s.x) * k
		s.y += (b.Y - s.y) * k
		if math.Abs(b.Zoom-s.zoom) < 1e-4 {
			s.zoom = b.Zoom
		}
		if math.Abs(b.X-s.x) < 1e-5 {
			s.x = b.X
		}
		if math.Abs(b.Y-s.y) < 1e-5 {
			s.y = b.Y
		}
		s.tick = n
	}
	return s
}

func (e *Engine) renderBase(dst *Frame, b *Base, n uint64) {
	if b == nil {
		fillBlack(dst)
		return
	}
	if strings.HasPrefix(b.Src, "#") && len(b.Src) == 7 { // a plain colour
		var c [3]uint8
		for i := 0; i < 3; i++ {
			v := hexVal(b.Src[1+i*2])<<4 | hexVal(b.Src[2+i*2])
			c[i] = uint8(v)
		}
		fillColor(dst, c[0], c[1], c[2])
		return
	}
	sm := e.smoothFor(b, n)
	if c := e.cams[b.Src]; c != nil {
		f, cnt, at := c.acquireAt(e.tickAt)
		e.acq[b.Src] = acqInfo{cnt, at, f != nil}
		if f == nil {
			c.release()
			fillBlack(dst)
			return
		}
		drawFramed(dst, f, framing(f.W, f.H, e.W, e.H, sm.zoom, sm.x, sm.y))
		c.release()
	} else if v := e.videos[b.Src]; v != nil {
		var f *Frame
		if e.vidTick[b.Src] == n+1 { // already advanced this frame (the same video on both sides of a fade)
			v.mu.Lock()
			f = v.cur
			v.mu.Unlock()
		} else {
			f = v.frame()
			e.vidTick[b.Src] = n + 1
		}
		if f == nil {
			fillBlack(dst)
			return
		}
		drawFramed(dst, f, framing(f.W, f.H, e.W, e.H, sm.zoom, sm.x, sm.y))
	} else if s := e.stills[b.Src]; s != nil {
		r := framing(s.f.W, s.f.H, e.W, e.H, sm.zoom, sm.x, sm.y)
		if !s.cached || s.cacheFor != r {
			if s.cache == nil {
				s.cache = newFrame(e.W, e.H)
			}
			drawFramed(s.cache, s.f, r)
			s.cacheFor, s.cached = r, true
		}
		copy(dst.Buf, s.cache.Buf)
	} else {
		fillBlack(dst)
		return
	}
	if lut := e.colors[b.Src]; lut != nil {
		applyColor(dst, lut)
	}
}

func hexVal(c byte) int {
	switch {
	case c >= '0' && c <= '9':
		return int(c - '0')
	case c >= 'a' && c <= 'f':
		return int(c-'a') + 10
	case c >= 'A' && c <= 'F':
		return int(c-'A') + 10
	}
	return 0
}

func (e *Engine) samplesFor(n uint64) int {
	num, den := uint64(e.fpsNum), uint64(e.fpsDen)
	return int((n+1)*48000*den/num - n*48000*den/num)
}

// one output frame; returns how much to move the clock to stay half a frame after the camera on air
func (e *Engine) tick(n uint64, now time.Time) time.Duration {
	t0 := time.Now()
	of := e.getFrame()
	e.mu.Lock()
	e.tickAt = now
	for k := range e.acq {
		delete(e.acq, k)
	}
	dt := e.period.Seconds() * 1000
	// program picture
	if e.trans != nil {
		p := float64(now.Sub(e.trans.start).Microseconds()) / 1000 / e.trans.dur
		if p >= 1 {
			e.cur = e.trans.to
			e.trans = nil
			e.renderBase(of.f, e.cur, n)
		} else {
			e.renderBase(e.scA, e.cur, n)
			e.renderBase(e.scB, e.trans.to, n)
			lerpFrames(of.f, e.scA, e.scB, int(ease(math.Max(0, p))*256+0.5))
		}
	} else {
		e.renderBase(of.f, e.cur, n)
	}
	// graphics and captions, lowest first
	if !e.orderOK {
		e.order = e.order[:0]
		for _, o := range e.overlays {
			e.order = append(e.order, o)
		}
		sort.Slice(e.order, func(i, j int) bool {
			if e.order[i].z != e.order[j].z {
				return e.order[i].z < e.order[j].z
			}
			return e.order[i].id < e.order[j].id
		})
		e.orderOK = true
	}
	for _, o := range e.order {
		if o.alpha < o.target {
			if o.fadeMs <= 0 {
				o.alpha = o.target
			} else {
				o.alpha = math.Min(o.target, o.alpha+dt/o.fadeMs)
			}
		} else if o.alpha > o.target {
			if o.fadeMs <= 0 {
				o.alpha = o.target
			} else {
				o.alpha = math.Max(o.target, o.alpha-dt/o.fadeMs)
			}
		}
		if o.alpha > 0 {
			blendLayer(of.f, o.layer, int(ease(o.alpha)*o.opacity*256+0.5))
		}
	}
	if b := e.blackNow(now); b > 0.001 {
		fadeToBlack(of.f, int(b*256+0.5))
	}
	// the camera on air sets the pace: one new camera frame per output frame
	var corr time.Duration
	clock := ""
	if e.trans != nil && e.trans.to != nil {
		clock = e.trans.to.Src
	} else if e.cur != nil {
		clock = e.cur.Src
	}
	if c := e.cams[clock]; c != nil {
		// the frame actually shown, and its ideal time
		a, drawn := e.acq[clock]
		if !drawn {
			c.mu.Lock()
			a = acqInfo{c.count, c.ideal, len(c.ring) > 0}
			c.mu.Unlock()
		}
		cnt, at, ok := a.cnt, a.at, a.ok
		c.mu.Lock()
		ok = ok && c.ok
		c.mu.Unlock()
		if clock == e.clockCam && ok {
			switch d := cnt - e.lastCount; {
			case d == 0:
				e.st.pgmRepeat++
			case d > 1:
				e.st.pgmSkip += int(d - 1)
			}
		}
		e.clockCam, e.lastCount = clock, cnt
		// keep the moment we pick from (now − cushion) half way between two ideal frame times
		if ok && c.lock && !at.IsZero() && now.Sub(at) < camLatency+3*e.period {
			ph := now.Add(-camLatency).Sub(at) % e.period
			if ph < 0 {
				ph += e.period
			}
			errv := ph - e.period/2
			e.st.phaseErr = errv
			corr = -errv / 50
			lim := 150 * time.Microsecond
			if corr > lim {
				corr = lim
			} else if corr < -lim {
				corr = -lim
			}
		}
	} else {
		e.clockCam = ""
	}
	pcm := e.audio.pull(e.samplesFor(n))
	e.dispatch(of, pcm)
	pgmW, pgmH, pgmEvery := e.pvPgmW, e.pvPgmH, e.pvPgmEvery
	camW, camH, camEvery := e.pvCamW, e.pvCamH, e.pvCamEvery
	var pvCams []*Camera
	var pvIDs []string
	if camEvery > 0 && n%uint64(camEvery) == uint64(camEvery/2) {
		for _, id := range e.pvCams {
			if c := e.cams[id]; c != nil {
				pvCams = append(pvCams, c)
				pvIDs = append(pvIDs, id)
			}
		}
	}
	e.mu.Unlock()
	rt := time.Since(t0)
	e.st.renderSum += rt
	if rt > e.st.renderMax {
		e.st.renderMax = rt
	}
	// small pictures for the window (sent only if the window keeps up)
	if pgmEvery > 0 && pgmW > 0 && n%uint64(pgmEvery) == 0 && sendRoom() {
		buf := make([]byte, pgmW*pgmH*4)
		toRGBA(of.f, pgmW, pgmH, buf)
		sendLossy(Msg{"ev": "pgm-frame", "w": pgmW, "h": pgmH}, buf)
	}
	for i, c := range pvCams {
		if !sendRoom() {
			break
		}
		f, _, _ := c.acquire()
		if f != nil {
			buf := make([]byte, camW*camH*4)
			toRGBA(f, camW, camH, buf)
			c.release()
			sendLossy(Msg{"ev": "cam-frame", "id": pvIDs[i], "w": camW, "h": camH}, buf)
		} else {
			c.release()
		}
	}
	of.release()
	return corr
}

/* ---------- the clock ---------- */

func (e *Engine) run() {
	T := e.period
	next := time.Now().Add(T)
	secAt := time.Now()
	var n uint64
	for !e.stopped.Load() {
		if d := time.Until(next); d > 0 {
			time.Sleep(d)
		}
		now := time.Now()
		late := now.Sub(next)
		if late > 300*time.Millisecond { // the PC stalled: start counting again from now
			e.st.resync++
			next = now
		}
		if late > T/2 {
			e.st.late++
		}
		if late > e.st.maxLate {
			e.st.maxLate = late
		}
		corr := e.tick(n, now)
		e.st.ticks++
		n++
		next = next.Add(T + corr)
		if now.Sub(secAt) >= time.Second {
			secAt = now
			e.sendStats()
		}
	}
}

func (e *Engine) sendStats() {
	cams := Msg{}
	vids := Msg{}
	outs := Msg{}
	e.mu.Lock()
	for id, c := range e.cams {
		c.secondTick()
		c.mu.Lock()
		cams[id] = Msg{"fps": c.fps, "ok": c.ok, "jitMs": float64(c.jit.Microseconds()) / 1000, "late": c.tooLate}
		c.mu.Unlock()
	}
	for id, v := range e.videos {
		v.mu.Lock()
		vids[id] = Msg{"playing": v.playing, "pos": math.Round(v.pos*100) / 100, "repeats": v.repeats, "ended": v.ended}
		v.repeats = 0
		v.mu.Unlock()
	}
	for id, o := range e.outputs {
		outs[id] = Msg{"dropped": o.dropped}
	}
	st := e.st
	e.st.ticks, e.st.late, e.st.resync, e.st.pgmRepeat, e.st.pgmSkip = 0, 0, 0, 0, 0
	e.st.maxLate, e.st.renderSum, e.st.renderMax = 0, 0, 0
	clock := e.clockCam
	e.mu.Unlock()
	ams, under, over, ppm := e.audio.stats()
	avg := 0.0
	if st.ticks > 0 {
		avg = float64(st.renderSum.Microseconds()) / float64(st.ticks) / 1000
	}
	send(Msg{"ev": "stats", "ticks": st.ticks, "late": st.late, "resync": st.resync, "maxLateMs": float64(st.maxLate.Microseconds()) / 1000,
		"repeat": st.pgmRepeat, "skip": st.pgmSkip, "clock": clock, "phaseMs": float64(st.phaseErr.Microseconds()) / 1000,
		"renderMs": math.Round(avg*100) / 100, "renderMaxMs": float64(st.renderMax.Microseconds()) / 1000,
		"cams": cams, "videos": vids, "outputs": outs, "audioMs": math.Round(ams), "audioUnder": under, "audioOver": over, "audioPpm": math.Round(ppm)}, nil)
}

func (e *Engine) shutdown() {
	e.stopped.Store(true)
	e.mu.Lock()
	ids := []string{}
	for id := range e.outputs {
		ids = append(ids, id)
	}
	e.mu.Unlock()
	for _, id := range ids {
		e.stopOutput(id, false)
	}
	// give the encoders time to finish their files
	for i := 0; i < 100; i++ {
		e.mu.Lock()
		left := len(e.outputs)
		e.mu.Unlock()
		if left == 0 {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	e.mu.Lock()
	for _, c := range e.cams {
		c.stop()
	}
	for _, v := range e.videos {
		v.stop()
	}
	e.mu.Unlock()
	time.Sleep(200 * time.Millisecond)
}
