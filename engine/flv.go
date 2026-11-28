package main

import (
	"bufio"
	"encoding/binary"
	"errors"
	"io"
	"os"
	"strconv"
)

/*
The H.264 that the engine encodes itself goes to FFmpeg inside a minimal FLV wrapper, not bare.

Bare H.264 carries no times. FFmpeg then guesses each picture's time from details inside the stream (the optional
"timing info"), and its scheduler uses those guesses to decide which input to read next. The NVIDIA card's stream gave
it nothing to go by: FFmpeg stopped reading the sound, and 14 s later the stream and the recording stood still
(27 Nov, 1.51.0 — the build's stand-in encoder happens to write that info, so the tests passed).

In FLV every picture has its time written next to it, and the picture format (SPS/PPS) is handed over once at the
start, so nothing is guessed and nothing has to be probed.
*/
type flvWriter struct {
	w              io.Writer
	fpsNum, fpsDen int
	n              int64
	started        bool
	sps, pps       []byte
	buf            []byte
}

func newFlvWriter(w io.Writer, fpsNum, fpsDen int) *flvWriter {
	return &flvWriter{w: w, fpsNum: fpsNum, fpsDen: fpsDen}
}

// the NAL units of a piece of Annex-B H.264 (without their start codes)
func splitNALs(b []byte) [][]byte {
	var out [][]byte
	start := -1
	i := 0
	for i+2 < len(b) {
		if b[i] == 0 && b[i+1] == 0 && b[i+2] == 1 {
			if start >= 0 {
				end := i
				for end > start && b[end-1] == 0 {
					end--
				}
				if end > start {
					out = append(out, b[start:end])
				}
			}
			start = i + 3
			i += 3
			continue
		}
		i++
	}
	if start >= 0 && start < len(b) {
		end := len(b)
		for end > start && b[end-1] == 0 {
			end--
		}
		if end > start {
			out = append(out, b[start:end])
		}
	}
	return out
}

func (f *flvWriter) tag(ms uint32, body []byte) {
	n := len(body)
	f.buf = append(f.buf, 9, byte(n>>16), byte(n>>8), byte(n), byte(ms>>16), byte(ms>>8), byte(ms), byte(ms>>24), 0, 0, 0)
	f.buf = append(f.buf, body...)
	f.buf = binary.BigEndian.AppendUint32(f.buf, uint32(11+n))
}

// one encoded picture (an access unit, Annex B) → one FLV tag. Pictures before the first key frame are left out.
func (f *flvWriter) write(au []byte) error {
	nals := splitNALs(au)
	key := false
	body := []byte{0, 1, 0, 0, 0}
	for _, n := range nals {
		switch n[0] & 31 {
		case 7:
			f.sps = append([]byte(nil), n...)
			continue
		case 8:
			f.pps = append([]byte(nil), n...)
			continue
		case 9: // the marker between pictures: FLV has its own
			continue
		case 5:
			key = true
		}
		body = binary.BigEndian.AppendUint32(body, uint32(len(n)))
		body = append(body, n...)
	}
	if len(body) == 5 {
		return nil
	}
	f.buf = f.buf[:0]
	if !f.started {
		if !key || len(f.sps) < 4 || len(f.pps) == 0 {
			return nil
		}
		f.started = true
		f.buf = append(f.buf, 'F', 'L', 'V', 1, 1, 0, 0, 0, 9, 0, 0, 0, 0)
		// the picture format, once (AVCDecoderConfigurationRecord)
		c := []byte{0x17, 0, 0, 0, 0, 1, f.sps[1], f.sps[2], f.sps[3], 0xff, 0xe1, byte(len(f.sps) >> 8), byte(len(f.sps))}
		c = append(c, f.sps...)
		c = append(c, 1, byte(len(f.pps)>>8), byte(len(f.pps)))
		c = append(c, f.pps...)
		f.tag(0, c)
	}
	if key {
		body[0] = 0x17
	} else {
		body[0] = 0x27
	}
	ms := uint32((f.n*1000*int64(f.fpsDen) + int64(f.fpsNum)/2) / int64(f.fpsNum))
	f.n++
	f.tag(ms, body)
	_, err := f.w.Write(f.buf)
	return err
}

// for trying it by hand: ls-engine --h264-to-flv 60000 1001 < bare.264 > wrapped.flv  (pictures are told apart by their markers, NAL 9)
func h264ToFlv(args []string) int {
	num, den := 60000, 1001
	if len(args) > 1 {
		num, _ = strconv.Atoi(args[0])
		den, _ = strconv.Atoi(args[1])
	}
	if num < 1 || den < 1 {
		return 2
	}
	out := bufio.NewWriter(os.Stdout)
	fw := newFlvWriter(out, num, den)
	in := bufio.NewReaderSize(os.Stdin, 1<<20)
	var cur []byte
	flush := func() error {
		if len(cur) == 0 {
			return nil
		}
		err := fw.write(cur)
		cur = cur[:0]
		if err == nil {
			err = out.Flush()
		}
		return err
	}
	buf := make([]byte, 0, 1<<20)
	chunk := make([]byte, 64<<10)
	for {
		n, err := in.Read(chunk)
		buf = append(buf, chunk[:n]...)
		// cut at every marker that has a whole start code in front of it
		for {
			cut := -1
			for i := 4; i+4 < len(buf); i++ {
				if buf[i] == 0 && buf[i+1] == 0 && buf[i+2] == 1 && buf[i+3]&31 == 9 {
					cut = i
					if i > 0 && buf[i-1] == 0 {
						cut = i - 1
					}
					break
				}
			}
			if cut < 0 {
				break
			}
			cur = append(cur, buf[:cut]...)
			if flush() != nil {
				return 1
			}
			buf = append(buf[:0], buf[cut:]...)
		}
		if err != nil {
			cur = append(cur, buf...)
			if e := flush(); e != nil && !errors.Is(e, io.EOF) {
				return 1
			}
			return 0
		}
	}
}
