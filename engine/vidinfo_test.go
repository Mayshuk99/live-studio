package main

import "testing"

func TestVideoInfoLines(t *testing.T) {
	l := "  Stream #0:0[0x1](und): Video: hevc (Main) (hvc1 / 0x31637668), yuv420p(tv, bt709, progressive), 3840x2160 [SAR 1:1 DAR 16:9], 28169 kb/s, 29.97 fps, 30 tbr, 600k tbn (default)"
	m := reVidStream.FindStringSubmatch(l)
	z := reVidSize.FindStringSubmatch(l)
	f := reVidFps.FindStringSubmatch(l)
	if m == nil || m[1] != "hevc" || z == nil || z[1] != "3840" || z[2] != "2160" || f == nil || f[1] != "29.97" {
		t.Fatalf("got %v %v %v", m, z, f)
	}
	if h := reVidHW.FindStringSubmatch("[vist#0:0/hevc @ 0x1] Using auto hwaccel type d3d11va with new default device."); h == nil || h[1] != "d3d11va" {
		t.Fatalf("hw %v", h)
	}
}

func TestVideoInfoLine61(t *testing.T) {
	l := "  Stream #0:0[0x1](eng): Video: hevc (Main), 1 reference frame (hvc1 / 0x31637668), yuv420p(tv, bt709, left), 3840x2160 (3840x2176), 28169 kb/s, 30.08 fps, 30 tbr, 90k tbn (default)"
	if m, z := reVidStream.FindStringSubmatch(l), reVidSize.FindStringSubmatch(l); m == nil || z == nil || m[1] != "hevc" || z[1] != "3840" {
		t.Fatalf("got %v %v", m, z)
	}
}
