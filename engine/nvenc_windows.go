//go:build windows

package main

import (
	"encoding/binary"
	"errors"
	"fmt"
	"path/filepath"
	"runtime"
	"syscall"
	"unsafe"
)

/*
NVIDIA's encoder (NVENC), called straight from the engine — no cgo, no extra files: the two libraries come with the
NVIDIA driver (System32\nvcuda.dll, nvEncodeAPI64.dll). The same steps FFmpeg's h264_nvenc takes for pictures that
come from memory: a CUDA context, an encode session on it, input buffers the pictures are copied into (YV12),
one finished access unit back per picture.

Structures are plain byte buffers; sizes, offsets and bit positions are in nvenc_layout.go, generated from NVIDIA's
header (tools/nvlayout). Interface version 12.0: drivers 522.25 (October 2022) and newer.

Everything here runs on ONE thread, locked by the caller for as long as the encoder lives: the CUDA context belongs
to the thread that made it.
*/

var procSystemFolder = kernel32.NewProc("GetSystemDirectoryW")

// a library from Windows' own System32 folder only (never from beside the program or the working folder)
func systemDLL(name string) (*syscall.DLL, error) {
	buf := make([]uint16, 320)
	n, _, _ := procSystemFolder.Call(uintptr(unsafe.Pointer(&buf[0])), uintptr(len(buf)))
	if n == 0 || int(n) >= len(buf) {
		return nil, errors.New("Windows' system folder was not found")
	}
	return syscall.LoadDLL(filepath.Join(syscall.UTF16ToString(buf[:n]), name))
}

type nvenc struct {
	cfg        encCfg
	cuda, lib  *syscall.DLL
	ctx        uintptr // CUDA context (current on this thread)
	h          uintptr // encode session
	fn         []byte  // NV_ENCODE_API_FUNCTION_LIST
	inBuf      []uintptr
	outBuf     []uintptr
	n          uint32
	pic        []byte
	lockIn     []byte
	lockBs     []byte
	card       string
	apiMax     uint32
	u32        uint32 // scratch for calls that fill a number
	dev        int32
	keep       [][]byte // structures the driver was given: kept until the encoder is closed
	guidA      [16]byte
	guidB      [16]byte
	closed     bool
	sizeWarned bool
}

func p32(b []byte, off int, v uint32)   { binary.LittleEndian.PutUint32(b[off:], v) }
func g32(b []byte, off int) uint32      { return binary.LittleEndian.Uint32(b[off:]) }
func pptr(b []byte, off int, v uintptr) { binary.LittleEndian.PutUint64(b[off:], uint64(v)) }
func gptr(b []byte, off int) uintptr    { return uintptr(binary.LittleEndian.Uint64(b[off:])) }
func bit(b []byte, off int, mask uint32, on bool) {
	v := g32(b, off) &^ mask
	if on {
		v |= mask
	}
	p32(b, off, v)
}
func addr(b []byte) uintptr { return uintptr(unsafe.Pointer(&b[0])) }

// memory that belongs to the driver, as a byte slice
func foreign(p uintptr, n int) []byte {
	return unsafe.Slice((*byte)(*(*unsafe.Pointer)(unsafe.Pointer(&p))), n)
}

// a zeroed structure that stays where it is and alive while the encoder is
func (e *nvenc) mem(n int) []byte {
	b := make([]byte, n)
	e.keep = append(e.keep, b)
	return b
}

var nvStatus = map[int32]string{1: "no encode device", 2: "unsupported device", 3: "invalid encoder device", 4: "invalid device", 5: "device does not exist", 6: "invalid pointer",
	7: "invalid event", 8: "invalid parameter", 9: "invalid call", 10: "out of memory", 11: "encoder not initialized", 12: "unsupported parameter", 13: "lock busy",
	14: "not enough buffer", 15: "invalid version", 16: "map failed", 17: "need more input", 18: "encoder busy", 20: "generic error", 21: "incompatible client key",
	22: "unimplemented", 23: "resource register failed", 24: "resource not registered", 25: "resource not mapped"}

func (e *nvenc) fail(what string, st int32) error {
	s := nvStatus[st]
	if s == "" {
		s = "error"
	}
	msg := fmt.Sprintf("%s: %s (%d)", what, s, st)
	if e.h != 0 {
		if fp := gptr(e.fn, o_NV_ENCODE_API_FUNCTION_LIST_nvEncGetLastErrorString); fp != 0 {
			if r, _, _ := syscall.SyscallN(fp, e.h); r != 0 {
				b := foreign(r, 240)
				i := 0
				for i < len(b) && b[i] != 0 {
					i++
				}
				if i > 0 {
					msg += " — " + string(b[:i])
				}
			}
		}
	}
	if st == nvErrOutOfMemory && what == "opening the session" {
		msg += " (the card's limit of encodes at the same time may be reached)"
	}
	return errors.New(msg)
}

// one of the driver's functions from its list
func (e *nvenc) call(off int, a ...uintptr) int32 {
	fp := gptr(e.fn, off)
	if fp == 0 {
		return 22
	}
	r, _, _ := syscall.SyscallN(fp, a...)
	return int32(r)
}

func (e *nvenc) cu(name string, a ...uintptr) error {
	p, err := e.cuda.FindProc(name)
	if err != nil {
		return fmt.Errorf("the NVIDIA driver has no %s", name)
	}
	if r, _, _ := p.Call(a...); uint32(r) != 0 {
		return fmt.Errorf("%s: CUDA error %d", name, uint32(r))
	}
	return nil
}

func presetGUID(n int) [16]byte {
	switch n {
	case 1:
		return guid_P1
	case 2:
		return guid_P2
	case 3:
		return guid_P3
	case 5:
		return guid_P5
	case 6:
		return guid_P6
	case 7:
		return guid_P7
	}
	return guid_P4
}

func gcd(a, b int) int {
	for b != 0 {
		a, b = b, a%b
	}
	return a
}

func openEncoder(c encCfg) (picEncoder, error) {
	if c.Kind != "nvenc" {
		return nil, &noEncoderError{fmt.Sprintf("no “%s” encoder inside the engine", c.Kind)}
	}
	if c.W < 160 || c.H < 64 || c.W%2 != 0 || c.H%2 != 0 || c.W > 8192 || c.H > 8192 || c.FpsNum < 1 || c.FpsDen < 1 {
		return nil, fmt.Errorf("picture %d×%d at %d/%d is not something this encoder is set up for", c.W, c.H, c.FpsNum, c.FpsDen)
	}
	e := &nvenc{cfg: c}
	var err error
	if e.cuda, err = systemDLL("nvcuda.dll"); err != nil {
		return nil, &noEncoderError{"no NVIDIA driver (nvcuda.dll)"}
	}
	if e.lib, err = systemDLL("nvEncodeAPI64.dll"); err != nil {
		return nil, &noEncoderError{"no NVIDIA encoder in the driver (nvEncodeAPI64.dll)"}
	}
	ok := false
	defer func() {
		if !ok {
			e.close()
		}
	}()

	// the card, and a CUDA context on this thread (4: wait without spinning, as FFmpeg asks for)
	if err := e.cu("cuInit", 0); err != nil {
		return nil, &noEncoderError{"no usable NVIDIA card (" + err.Error() + ")"}
	}
	if err := e.cu("cuDeviceGet", uintptr(unsafe.Pointer(&e.dev)), 0); err != nil {
		return nil, &noEncoderError{"no usable NVIDIA card (" + err.Error() + ")"}
	}
	name := e.mem(128)
	if e.cu("cuDeviceGetName", addr(name), 127, uintptr(uint32(e.dev))) == nil {
		i := 0
		for i < len(name) && name[i] != 0 {
			i++
		}
		e.card = string(name[:i])
	}
	if e.card == "" {
		e.card = "NVIDIA card"
	}
	if err := e.cu("cuCtxCreate_v2", uintptr(unsafe.Pointer(&e.ctx)), 4, uintptr(uint32(e.dev))); err != nil {
		return nil, err
	}

	// the encoder's functions
	maxp, err := e.lib.FindProc("NvEncodeAPIGetMaxSupportedVersion")
	if err != nil {
		return nil, errors.New("the NVIDIA driver is too old (no NvEncodeAPIGetMaxSupportedVersion)")
	}
	if r, _, _ := maxp.Call(uintptr(unsafe.Pointer(&e.u32))); int32(r) != 0 {
		return nil, e.fail("asking the driver's version", int32(r))
	}
	e.apiMax = e.u32
	if e.apiMax < nvMaxVersionNeeded {
		return nil, fmt.Errorf("the NVIDIA driver is too old: its encoder interface is %d.%d, %d.%d is needed — update the driver", e.apiMax>>4, e.apiMax&15, nvMaxVersionNeeded>>4, nvMaxVersionNeeded&15)
	}
	inst, err := e.lib.FindProc("NvEncodeAPICreateInstance")
	if err != nil {
		return nil, errors.New("the NVIDIA driver has no NvEncodeAPICreateInstance")
	}
	e.fn = e.mem(sz_NV_ENCODE_API_FUNCTION_LIST)
	p32(e.fn, o_NV_ENCODE_API_FUNCTION_LIST_version, ver_FUNCTION_LIST)
	if r, _, _ := inst.Call(addr(e.fn)); int32(r) != 0 {
		return nil, e.fail("getting the encoder's functions", int32(r))
	}

	// a session on the CUDA context
	sp := e.mem(sz_NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS)
	p32(sp, o_NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS_version, ver_OPEN_SESSION_EX)
	p32(sp, o_NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS_deviceType, nvDeviceCUDA)
	pptr(sp, o_NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS_device, e.ctx)
	p32(sp, o_NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS_apiVersion, nvAPIVersion)
	if st := e.call(o_NV_ENCODE_API_FUNCTION_LIST_nvEncOpenEncodeSessionEx, addr(sp), uintptr(unsafe.Pointer(&e.h))); st != 0 {
		return nil, e.fail("opening the session", st) // (close() gives a half-open session back)
	}

	// the preset's settings as the starting point
	tune := uint32(nvTuneLowLatency)
	if c.Tune == "hq" {
		tune = nvTuneHQ
	}
	e.guidA, e.guidB = guid_H264, presetGUID(c.Preset)
	pc := e.mem(sz_NV_ENC_PRESET_CONFIG)
	p32(pc, o_NV_ENC_PRESET_CONFIG_version, ver_PRESET_CONFIG)
	p32(pc, o_NV_ENC_PRESET_CONFIG_presetCfg+o_NV_ENC_CONFIG_version, ver_CONFIG)
	// (the two GUIDs are "by value" in C: on 64-bit Windows that means a pointer to a copy)
	ga, gb := e.mem(16), e.mem(16)
	copy(ga, e.guidA[:])
	copy(gb, e.guidB[:])
	if st := e.call(o_NV_ENCODE_API_FUNCTION_LIST_nvEncGetEncodePresetConfigEx, e.h, addr(ga), addr(gb), uintptr(tune), addr(pc)); st != 0 {
		return nil, e.fail("reading the preset", st)
	}
	cfg := e.mem(sz_NV_ENC_CONFIG)
	copy(cfg, pc[o_NV_ENC_PRESET_CONFIG_presetCfg:o_NV_ENC_PRESET_CONFIG_presetCfg+sz_NV_ENC_CONFIG])
	p32(cfg, o_NV_ENC_CONFIG_version, ver_CONFIG)
	prof := guid_ProfileHigh
	if c.Profile == "main" {
		prof = guid_ProfileMain
	} else if c.Profile == "baseline" {
		prof = guid_ProfileBaseline
	}
	copy(cfg[o_NV_ENC_CONFIG_profileGUID:], prof[:])
	p32(cfg, o_NV_ENC_CONFIG_gopLength, uint32(c.Gop))
	p32(cfg, o_NV_ENC_CONFIG_frameIntervalP, 1) // no B-pictures: every picture comes straight back, in order
	p32(cfg, o_NV_ENC_CONFIG_frameFieldMode, nvFrameModeFrame)
	rc := cfg[o_NV_ENC_CONFIG_rcParams:]
	if g32(rc, o_NV_ENC_RC_PARAMS_version) == 0 {
		p32(rc, o_NV_ENC_RC_PARAMS_version, ver_RC_PARAMS)
	}
	mode := uint32(nvRC_VBR)
	if c.CBR {
		mode = nvRC_CBR
	}
	p32(rc, o_NV_ENC_RC_PARAMS_rateControlMode, mode)
	p32(rc, o_NV_ENC_RC_PARAMS_averageBitRate, uint32(c.Kbps*1000))
	p32(rc, o_NV_ENC_RC_PARAMS_maxBitRate, uint32(c.MaxKbps*1000))
	p32(rc, o_NV_ENC_RC_PARAMS_vbvBufferSize, uint32(c.BufKbps*1000))
	bit(rc, b_NV_ENC_RC_PARAMS_enableLookahead_off, b_NV_ENC_RC_PARAMS_enableLookahead_mask, false)
	h := cfg[o_NV_ENC_CONFIG_encodeCodecConfig:]
	bit(h, b_NV_ENC_CONFIG_H264_disableSPSPPS_off, b_NV_ENC_CONFIG_H264_disableSPSPPS_mask, false)
	bit(h, b_NV_ENC_CONFIG_H264_repeatSPSPPS_off, b_NV_ENC_CONFIG_H264_repeatSPSPPS_mask, true) // every key frame carries the picture format
	bit(h, b_NV_ENC_CONFIG_H264_outputAUD_off, b_NV_ENC_CONFIG_H264_outputAUD_mask, true)       // a marker in front of every picture (FFmpeg splits on it)
	bit(h, b_NV_ENC_CONFIG_H264_outputBufferingPeriodSEI_off, b_NV_ENC_CONFIG_H264_outputBufferingPeriodSEI_mask, c.CBR)
	bit(h, b_NV_ENC_CONFIG_H264_outputPictureTimingSEI_off, b_NV_ENC_CONFIG_H264_outputPictureTimingSEI_mask, true)
	p32(h, o_NV_ENC_CONFIG_H264_idrPeriod, uint32(c.Gop))
	p32(h, o_NV_ENC_CONFIG_H264_sliceMode, 3) // one slice a picture
	p32(h, o_NV_ENC_CONFIG_H264_sliceModeData, 1)
	p32(h, o_NV_ENC_CONFIG_H264_chromaFormatIDC, 1)
	vui := h[o_NV_ENC_CONFIG_H264_h264VUIParameters:]
	p32(vui, o_NV_ENC_CONFIG_H264_VUI_PARAMETERS_videoSignalTypePresentFlag, 1) // HD colours (BT.709), TV range — what the engine mixes in
	p32(vui, o_NV_ENC_CONFIG_H264_VUI_PARAMETERS_videoFormat, 5)
	p32(vui, o_NV_ENC_CONFIG_H264_VUI_PARAMETERS_videoFullRangeFlag, 0)
	p32(vui, o_NV_ENC_CONFIG_H264_VUI_PARAMETERS_colourDescriptionPresentFlag, 1)
	p32(vui, o_NV_ENC_CONFIG_H264_VUI_PARAMETERS_colourPrimaries, 1)
	p32(vui, o_NV_ENC_CONFIG_H264_VUI_PARAMETERS_transferCharacteristics, 1)
	p32(vui, o_NV_ENC_CONFIG_H264_VUI_PARAMETERS_colourMatrix, 1)

	ip := e.mem(sz_NV_ENC_INITIALIZE_PARAMS)
	p32(ip, o_NV_ENC_INITIALIZE_PARAMS_version, ver_INITIALIZE_PARAMS)
	copy(ip[o_NV_ENC_INITIALIZE_PARAMS_encodeGUID:], e.guidA[:])
	copy(ip[o_NV_ENC_INITIALIZE_PARAMS_presetGUID:], e.guidB[:])
	p32(ip, o_NV_ENC_INITIALIZE_PARAMS_encodeWidth, uint32(c.W))
	p32(ip, o_NV_ENC_INITIALIZE_PARAMS_encodeHeight, uint32(c.H))
	g := gcd(c.W, c.H)
	p32(ip, o_NV_ENC_INITIALIZE_PARAMS_darWidth, uint32(c.W/g))
	p32(ip, o_NV_ENC_INITIALIZE_PARAMS_darHeight, uint32(c.H/g))
	p32(ip, o_NV_ENC_INITIALIZE_PARAMS_frameRateNum, uint32(c.FpsNum))
	p32(ip, o_NV_ENC_INITIALIZE_PARAMS_frameRateDen, uint32(c.FpsDen))
	p32(ip, o_NV_ENC_INITIALIZE_PARAMS_enableEncodeAsync, 0) // each picture is waited for
	p32(ip, o_NV_ENC_INITIALIZE_PARAMS_enablePTD, 1)         // the encoder decides which pictures are key frames
	pptr(ip, o_NV_ENC_INITIALIZE_PARAMS_encodeConfig, addr(cfg))
	p32(ip, o_NV_ENC_INITIALIZE_PARAMS_tuningInfo, tune)
	if st := e.call(o_NV_ENCODE_API_FUNCTION_LIST_nvEncInitializeEncoder, e.h, addr(ip)); st != 0 {
		return nil, e.fail("setting the encoder up", st)
	}

	// buffers: pictures in, H.264 out
	for i := 0; i < 4; i++ {
		cb := e.mem(sz_NV_ENC_CREATE_INPUT_BUFFER)
		p32(cb, o_NV_ENC_CREATE_INPUT_BUFFER_version, ver_CREATE_INPUT_BUFFER)
		p32(cb, o_NV_ENC_CREATE_INPUT_BUFFER_width, uint32(c.W))
		p32(cb, o_NV_ENC_CREATE_INPUT_BUFFER_height, uint32(c.H))
		p32(cb, o_NV_ENC_CREATE_INPUT_BUFFER_bufferFmt, nvFmtYV12)
		if st := e.call(o_NV_ENCODE_API_FUNCTION_LIST_nvEncCreateInputBuffer, e.h, addr(cb)); st != 0 {
			return nil, e.fail("making a picture buffer", st)
		}
		e.inBuf = append(e.inBuf, gptr(cb, o_NV_ENC_CREATE_INPUT_BUFFER_inputBuffer))
		bb := e.mem(sz_NV_ENC_CREATE_BITSTREAM_BUFFER)
		p32(bb, o_NV_ENC_CREATE_BITSTREAM_BUFFER_version, ver_CREATE_BITSTREAM_BUFFER)
		if st := e.call(o_NV_ENCODE_API_FUNCTION_LIST_nvEncCreateBitstreamBuffer, e.h, addr(bb)); st != 0 {
			return nil, e.fail("making an output buffer", st)
		}
		e.outBuf = append(e.outBuf, gptr(bb, o_NV_ENC_CREATE_BITSTREAM_BUFFER_bitstreamBuffer))
	}
	e.pic, e.lockIn, e.lockBs = e.mem(sz_NV_ENC_PIC_PARAMS), e.mem(sz_NV_ENC_LOCK_INPUT_BUFFER), e.mem(sz_NV_ENC_LOCK_BITSTREAM)
	ok = true
	return e, nil
}

func (e *nvenc) encode(f *Frame) ([]byte, error) {
	c := e.cfg
	if f.W != c.W || f.H != c.H {
		return nil, fmt.Errorf("a %d×%d picture for a %d×%d encoder", f.W, f.H, c.W, c.H)
	}
	i := int(e.n) % len(e.inBuf)
	// the picture into the card's buffer: Y, then V, then U (YV12), each row at the buffer's own row length
	clear(e.lockIn)
	p32(e.lockIn, o_NV_ENC_LOCK_INPUT_BUFFER_version, ver_LOCK_INPUT_BUFFER)
	pptr(e.lockIn, o_NV_ENC_LOCK_INPUT_BUFFER_inputBuffer, e.inBuf[i])
	if st := e.call(o_NV_ENCODE_API_FUNCTION_LIST_nvEncLockInputBuffer, e.h, addr(e.lockIn)); st != 0 {
		return nil, e.fail("opening a picture buffer", st)
	}
	dp, pitch := gptr(e.lockIn, o_NV_ENC_LOCK_INPUT_BUFFER_bufferDataPtr), int(g32(e.lockIn, o_NV_ENC_LOCK_INPUT_BUFFER_pitch))
	if dp == 0 || pitch < c.W || pitch > 4*c.W+4096 {
		e.call(o_NV_ENCODE_API_FUNCTION_LIST_nvEncUnlockInputBuffer, e.h, e.inBuf[i])
		return nil, fmt.Errorf("the card's picture buffer makes no sense (row length %d for %d wide)", pitch, c.W)
	}
	cp, cw, ch := pitch/2, c.W/2, c.H/2
	dst := foreign(dp, pitch*c.H+2*cp*ch)
	copyPlane(dst, pitch, f.Y(), c.W, c.H)
	copyPlane(dst[pitch*c.H:], cp, f.V(), cw, ch)
	copyPlane(dst[pitch*c.H+cp*ch:], cp, f.U(), cw, ch)
	if st := e.call(o_NV_ENCODE_API_FUNCTION_LIST_nvEncUnlockInputBuffer, e.h, e.inBuf[i]); st != 0 {
		return nil, e.fail("closing a picture buffer", st)
	}

	clear(e.pic)
	p32(e.pic, o_NV_ENC_PIC_PARAMS_version, ver_PIC_PARAMS)
	p32(e.pic, o_NV_ENC_PIC_PARAMS_inputWidth, uint32(c.W))
	p32(e.pic, o_NV_ENC_PIC_PARAMS_inputHeight, uint32(c.H))
	p32(e.pic, o_NV_ENC_PIC_PARAMS_inputPitch, uint32(pitch))
	binary.LittleEndian.PutUint64(e.pic[o_NV_ENC_PIC_PARAMS_inputTimeStamp:], uint64(e.n))
	binary.LittleEndian.PutUint64(e.pic[o_NV_ENC_PIC_PARAMS_inputDuration:], 1)
	pptr(e.pic, o_NV_ENC_PIC_PARAMS_inputBuffer, e.inBuf[i])
	pptr(e.pic, o_NV_ENC_PIC_PARAMS_outputBitstream, e.outBuf[i])
	p32(e.pic, o_NV_ENC_PIC_PARAMS_bufferFmt, nvFmtYV12)
	p32(e.pic, o_NV_ENC_PIC_PARAMS_pictureStruct, nvPicFrame)
	st := e.call(o_NV_ENCODE_API_FUNCTION_LIST_nvEncEncodePicture, e.h, addr(e.pic))
	e.n++
	if st == nvErrNeedMoreInput {
		return nil, nil // (not expected without B-pictures; the next picture brings it)
	}
	if st != 0 {
		return nil, e.fail("encoding", st)
	}
	// the finished picture (this waits until the card is done with it)
	clear(e.lockBs)
	p32(e.lockBs, o_NV_ENC_LOCK_BITSTREAM_version, ver_LOCK_BITSTREAM)
	pptr(e.lockBs, o_NV_ENC_LOCK_BITSTREAM_outputBitstream, e.outBuf[i])
	if st := e.call(o_NV_ENCODE_API_FUNCTION_LIST_nvEncLockBitstream, e.h, addr(e.lockBs)); st != 0 {
		return nil, e.fail("fetching the encoded picture", st)
	}
	n, bp := int(g32(e.lockBs, o_NV_ENC_LOCK_BITSTREAM_bitstreamSizeInBytes)), gptr(e.lockBs, o_NV_ENC_LOCK_BITSTREAM_bitstreamBufferPtr)
	var au []byte
	if bp != 0 && n > 0 && n < 64<<20 {
		au = make([]byte, n)
		copy(au, foreign(bp, n))
	}
	if st := e.call(o_NV_ENCODE_API_FUNCTION_LIST_nvEncUnlockBitstream, e.h, e.outBuf[i]); st != 0 {
		return nil, e.fail("giving the output buffer back", st)
	}
	if au == nil {
		return nil, fmt.Errorf("the card returned an encoded picture of %d bytes", n)
	}
	return au, nil
}

func copyPlane(dst []byte, pitch int, src []byte, w, h int) {
	if pitch == w {
		copy(dst, src[:w*h])
		return
	}
	for r := 0; r < h; r++ {
		copy(dst[r*pitch:r*pitch+w], src[r*w:(r+1)*w])
	}
}

func (e *nvenc) close() []byte {
	if e.closed {
		return nil
	}
	e.closed = true
	if e.h != 0 {
		if e.pic != nil && e.n > 0 { // end of the pictures
			clear(e.pic)
			p32(e.pic, o_NV_ENC_PIC_PARAMS_version, ver_PIC_PARAMS)
			p32(e.pic, o_NV_ENC_PIC_PARAMS_encodePicFlags, nvPicFlagEOS)
			e.call(o_NV_ENCODE_API_FUNCTION_LIST_nvEncEncodePicture, e.h, addr(e.pic))
		}
		for _, b := range e.inBuf {
			e.call(o_NV_ENCODE_API_FUNCTION_LIST_nvEncDestroyInputBuffer, e.h, b)
		}
		for _, b := range e.outBuf {
			e.call(o_NV_ENCODE_API_FUNCTION_LIST_nvEncDestroyBitstreamBuffer, e.h, b)
		}
		e.call(o_NV_ENCODE_API_FUNCTION_LIST_nvEncDestroyEncoder, e.h)
		e.h = 0
	}
	if e.ctx != 0 {
		e.cu("cuCtxDestroy_v2", e.ctx)
		e.ctx = 0
	}
	runtime.KeepAlive(e.keep)
	return nil
}

func (e *nvenc) info() string { return e.card }
func (e *nvenc) api() string  { return fmt.Sprintf("%d.%d", e.apiMax>>4, e.apiMax&15) }
