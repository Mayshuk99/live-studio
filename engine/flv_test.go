package main

import (
	"bytes"
	"encoding/binary"
	"testing"
)

func TestFlvWriter(t *testing.T) {
	sc := []byte{0, 0, 0, 1}
	au := func(key bool, n byte) []byte {
		b := append([]byte{}, sc...)
		b = append(b, 9, 0xf0)
		if key {
			b = append(append(b, sc...), 0x67, 100, 0, 42, 1, 2)
			b = append(append(b, sc...), 0x68, 3, 4)
			b = append(append(b, 0, 0, 1), 0x65, n, 7, 7) // 3-byte start code too
		} else {
			b = append(append(b, sc...), 0x41, n, 8)
		}
		return b
	}
	var out bytes.Buffer
	fw := newFlvWriter(&out, 60000, 1001)
	fw.write(au(false, 1)) // before the first key frame: left out
	if out.Len() != 0 {
		t.Fatal("a picture went out before the first key frame")
	}
	var all []byte
	for i := 0; i < 61; i++ {
		all = append(all, au(i%60 == 0, byte(i))...)
	}
	parts := splitAUs(all)
	if len(parts) != 61 {
		t.Fatalf("pictures told apart: %d of 61", len(parts))
	}
	for _, p := range parts {
		if err := fw.write(p); err != nil {
			t.Fatal(err)
		}
	}
	b := out.Bytes()
	if string(b[:3]) != "FLV" || b[4] != 1 {
		t.Fatal("no FLV header")
	}
	b = b[13:]
	var times []uint32
	var kinds [][2]byte
	for len(b) > 0 {
		n := int(b[1])<<16 | int(b[2])<<8 | int(b[3])
		if b[0] != 9 || binary.BigEndian.Uint32(b[11+n:]) != uint32(11+n) {
			t.Fatal("broken tag")
		}
		times = append(times, uint32(b[4])<<16|uint32(b[5])<<8|uint32(b[6])|uint32(b[7])<<24)
		kinds = append(kinds, [2]byte{b[11], b[12]})
		if b[12] == 1 { // length-prefixed parts, none of them a marker / format part
			body := b[16 : 11+n]
			for len(body) > 0 {
				l := int(binary.BigEndian.Uint32(body))
				if k := body[4] & 31; k == 7 || k == 8 || k == 9 {
					t.Fatalf("part kind %d inside a picture", k)
				}
				body = body[4+l:]
			}
		}
		b = b[15+n:]
	}
	if len(times) != 62 || kinds[0] != [2]byte{0x17, 0} || kinds[1] != [2]byte{0x17, 1} || kinds[2] != [2]byte{0x27, 1} || kinds[61] != [2]byte{0x17, 1} {
		t.Fatalf("tags: %d %v", len(times), kinds[:3])
	}
	if times[1] != 0 || times[2] != 17 || times[61] != 1001 {
		t.Fatalf("times: %v … %v", times[:4], times[61])
	}
}
