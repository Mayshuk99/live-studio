// Live Studio NDI helper.
//
// Finds NDI® sources on the network and receives one for the native engine, which reads it like a capture card:
//
//   ls-ndi --list [ms]                         sources on the network, as one line of JSON on stdout
//   ls-ndi --recv "<NAME>" --w W --h H         the source's picture as raw YUV 4:2:0 frames of W×H on stdout
//          [--url ADDRESS] [--low]               (fitted into W×H with black bars when the shape differs)
//   ls-ndi --send "<NAME>" [--w W --h H --fps N/D --seconds S]   a moving test picture (for tests)
//   ls-ndi --selftest                          checks the picture conversion (no NDI needed)
//   ls-ndi --version                           the NDI runtime found on this computer
//
// Messages for people go to stderr. The NDI runtime is not part of Live Studio: it comes with the free NDI Tools
// (ndi.video), and is loaded when needed. NDI® is a registered trademark of Vizrt NDI AB.

#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <chrono>
#include <string>
#include <thread>
#include <vector>

#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <fcntl.h>
#include <io.h>
#else
#include <dlfcn.h>
#endif

#include "ndi/Processing.NDI.Lib.h"

typedef std::chrono::steady_clock Clock;
static double secsSince(Clock::time_point t) { return std::chrono::duration<double>(Clock::now() - t).count(); }

/* ---------- loading the NDI runtime ---------- */

static const NDIlib_v5* lib = nullptr;
static std::string loadErr;

static bool loadNDI() {
	typedef const NDIlib_v5* (*LoadFn)(void);
	LoadFn load = nullptr;
#ifdef _WIN32
	HMODULE h = nullptr;
	for (const char* env : {"NDI_RUNTIME_DIR_V6", "NDI_RUNTIME_DIR_V5", "NDI_RUNTIME_DIR_V4"}) {
		const char* d = getenv(env);
		if (d && *d) {
			std::string p = std::string(d) + "\\" NDILIB_LIBRARY_NAME;
			if ((h = LoadLibraryA(p.c_str()))) break;
		}
	}
	if (!h) h = LoadLibraryA(NDILIB_LIBRARY_NAME);
	if (!h) {
		loadErr = "the NDI Runtime is not installed on this computer - install NDI Tools (free, ndi.video)";
		return false;
	}
	for (const char* n : {"NDIlib_v5_load", "NDIlib_v4_load", "NDIlib_v3_load"})
		if ((load = (LoadFn)(void*)GetProcAddress(h, n))) break;
#else
	void* h = nullptr;
	const char* env = getenv("NDI_LIB");
	for (const char* n : {env, "libndi.so.6", "libndi.so.5", "libndi.so.4", "libndi.so"})
		if (n && (h = dlopen(n, RTLD_NOW | RTLD_LOCAL))) break;
	if (!h) {
		loadErr = "the NDI Runtime is not installed (libndi not found)";
		return false;
	}
	for (const char* n : {"NDIlib_v5_load", "NDIlib_v4_load", "NDIlib_v3_load"})
		if ((load = (LoadFn)dlsym(h, n))) break;
#endif
	if (!load || !(lib = load())) {
		loadErr = "this NDI Runtime is too old - update NDI Tools";
		return false;
	}
	if (!lib->initialize()) {
		loadErr = "NDI cannot run on this processor";
		lib = nullptr;
		return false;
	}
	return true;
}

/* ---------- the picture: any NDI frame → YUV 4:2:0 at the size asked for ---------- */

// one plane scaled with bilinear filtering (centres lined up), into a box of dst
static void scalePlane(const uint8_t* src, int sw, int sh, int sstride, uint8_t* dst, int dw, int dh, int dstride) {
	if (dw <= 0 || dh <= 0 || sw <= 0 || sh <= 0) return;
	if (dw == sw && dh == sh) {
		for (int y = 0; y < dh; y++) memcpy(dst + (size_t)y * dstride, src + (size_t)y * sstride, dw);
		return;
	}
	static thread_local std::vector<int> x0, x1, fx;
	x0.resize(dw), x1.resize(dw), fx.resize(dw);
	for (int x = 0; x < dw; x++) {
		double s = (x + 0.5) * sw / dw - 0.5;
		if (s < 0) s = 0;
		int i = (int)s;
		if (i > sw - 1) i = sw - 1;
		x0[x] = i, x1[x] = i + 1 < sw ? i + 1 : sw - 1, fx[x] = (int)((s - i) * 256 + 0.5);
	}
	for (int y = 0; y < dh; y++) {
		double s = (y + 0.5) * sh / dh - 0.5;
		if (s < 0) s = 0;
		int j = (int)s;
		if (j > sh - 1) j = sh - 1;
		int j1 = j + 1 < sh ? j + 1 : sh - 1, fy = (int)((s - j) * 256 + 0.5);
		const uint8_t *r0 = src + (size_t)j * sstride, *r1 = src + (size_t)j1 * sstride;
		uint8_t* o = dst + (size_t)y * dstride;
		for (int x = 0; x < dw; x++) {
			int a = r0[x0[x]] * (256 - fx[x]) + r0[x1[x]] * fx[x];
			int b = r1[x0[x]] * (256 - fx[x]) + r1[x1[x]] * fx[x];
			o[x] = (uint8_t)((a * (256 - fy) + b * fy + 32768) >> 16);
		}
	}
}

// BT.709 (HD) limited range, as NDI's own UYVY
static inline void rgbToYUV(int r, int g, int b, int& Y, int& U, int& V) {
	Y = 16 + ((47 * r + 157 * g + 16 * b + 128) >> 8);
	U = 128 + ((-26 * r - 86 * g + 112 * b + 128) >> 8);
	V = 128 + ((112 * r - 102 * g - 10 * b + 128) >> 8);
}

/* fills out (W×H×3/2) from a frame: kind 0 = UYVY(A), 1 = BGRA/BGRX, 2 = RGBA/RGBX; aspect = width/height shown
   (0 = from the pixels). Returns false for a kind not handled. */
static bool toI420(const uint8_t* p, int sw, int sh, int stride, int kind, float aspect, uint8_t* out, int W, int H) {
	if (sw < 2 || sh < 2 || !p) return false;
	sw &= ~1;
	// 1. planar Y (sw×sh) and U, V (sw/2 × sh): 4:2:2 like the source
	static thread_local std::vector<uint8_t> Y, U, V;
	Y.resize((size_t)sw * sh), U.resize((size_t)sw / 2 * sh), V.resize((size_t)sw / 2 * sh);
	for (int y = 0; y < sh; y++) {
		const uint8_t* r = p + (size_t)y * stride;
		uint8_t *yo = &Y[(size_t)y * sw], *uo = &U[(size_t)y * sw / 2], *vo = &V[(size_t)y * sw / 2];
		if (kind == 0) {
			for (int x = 0; x < sw / 2; x++) {
				uo[x] = r[x * 4], yo[x * 2] = r[x * 4 + 1], vo[x] = r[x * 4 + 2], yo[x * 2 + 1] = r[x * 4 + 3];
			}
		} else {
			int ri = kind == 1 ? 2 : 0, bi = kind == 1 ? 0 : 2;
			for (int x = 0; x < sw / 2; x++) {
				const uint8_t *a = r + x * 8, *b = a + 4;
				int y0, u0, v0, y1, u1, v1;
				rgbToYUV(a[ri], a[1], a[bi], y0, u0, v0);
				rgbToYUV(b[ri], b[1], b[bi], y1, u1, v1);
				yo[x * 2] = (uint8_t)y0, yo[x * 2 + 1] = (uint8_t)y1, uo[x] = (uint8_t)((u0 + u1 + 1) >> 1), vo[x] = (uint8_t)((v0 + v1 + 1) >> 1);
			}
		}
	}
	// 2. where it goes: the whole picture, or centred with black bars when the shape differs
	double sa = aspect > 0.01f ? aspect : (double)sw / sh, da = (double)W / H;
	int rw = W, rh = H;
	if (sa > da * 1.01) rh = ((int)(W / sa + 0.5)) & ~1;
	else if (sa < da / 1.01) rw = ((int)(H * sa + 0.5)) & ~1;
	int ox = ((W - rw) / 2) & ~1, oy = ((H - rh) / 2) & ~1;
	uint8_t *oY = out, *oU = out + (size_t)W * H, *oV = oU + (size_t)W * H / 4;
	if (rw != W || rh != H) {
		memset(oY, 16, (size_t)W * H);
		memset(oU, 128, (size_t)W * H / 4);
		memset(oV, 128, (size_t)W * H / 4);
	}
	// 3. scale: luma to the box, colour to half the box both ways (4:2:2 → 4:2:0)
	scalePlane(Y.data(), sw, sh, sw, oY + (size_t)oy * W + ox, rw, rh, W);
	scalePlane(U.data(), sw / 2, sh, sw / 2, oU + (size_t)(oy / 2) * (W / 2) + ox / 2, rw / 2, rh / 2, W / 2);
	scalePlane(V.data(), sw / 2, sh, sw / 2, oV + (size_t)(oy / 2) * (W / 2) + ox / 2, rw / 2, rh / 2, W / 2);
	return true;
}

static int kindOf(NDIlib_FourCC_video_type_e f) {
	switch (f) {
	case NDIlib_FourCC_video_type_UYVY:
	case NDIlib_FourCC_video_type_UYVA: return 0;
	case NDIlib_FourCC_video_type_BGRA:
	case NDIlib_FourCC_video_type_BGRX: return 1;
	case NDIlib_FourCC_video_type_RGBA:
	case NDIlib_FourCC_video_type_RGBX: return 2;
	default: return -1;
	}
}

/* ---------- commands ---------- */

static std::string jsonStr(const char* s) {
	std::string o = "\"";
	for (const unsigned char* c = (const unsigned char*)(s ? s : ""); *c; c++) {
		if (*c == '"' || *c == '\\') o += '\\', o += (char)*c;
		else if (*c < 0x20) {
			char b[8];
			snprintf(b, sizeof b, "\\u%04x", *c);
			o += b;
		} else o += (char)*c;
	}
	return o + "\"";
}

static int cmdList(int ms) {
	if (!loadNDI()) {
		printf("{\"error\":%s}\n", jsonStr(loadErr.c_str()).c_str());
		return 0;
	}
	NDIlib_find_create_t fc;
	fc.show_local_sources = true;
	NDIlib_find_instance_t f = lib->find_create_v2(&fc);
	if (!f) {
		printf("{\"error\":\"NDI could not look for sources\"}\n");
		return 0;
	}
	auto t0 = Clock::now();
	while (secsSince(t0) * 1000 < ms) lib->find_wait_for_sources(f, 250);
	uint32_t n = 0;
	const NDIlib_source_t* s = lib->find_get_current_sources(f, &n);
	std::string o = "{\"sources\":[";
	for (uint32_t i = 0; i < n; i++) {
		if (i) o += ",";
		o += "{\"name\":" + jsonStr(s[i].p_ndi_name) + ",\"url\":" + jsonStr(s[i].p_url_address) + "}";
	}
	o += "],\"version\":" + jsonStr(lib->version()) + "}";
	printf("%s\n", o.c_str());
	fflush(stdout);
	lib->find_destroy(f);
	return 0;
}

static int cmdRecv(const char* name, const char* url, int W, int H, bool low) {
	if (W < 16 || H < 16 || (W & 1) || (H & 1)) {
		fprintf(stderr, "bad size %dx%d\n", W, H);
		return 2;
	}
	if (!loadNDI()) {
		fprintf(stderr, "%s\n", loadErr.c_str());
		std::this_thread::sleep_for(std::chrono::seconds(8)); // the engine starts it again: not too often
		return 3;
	}
	NDIlib_recv_create_v3_t rc;
	rc.source_to_connect_to.p_ndi_name = name;
	rc.source_to_connect_to.p_url_address = url && *url ? url : nullptr;
	rc.color_format = NDIlib_recv_color_format_UYVY_BGRA;
	rc.bandwidth = low ? NDIlib_recv_bandwidth_lowest : NDIlib_recv_bandwidth_highest;
	rc.allow_video_fields = false; // whole frames (interlaced sources are put together by NDI)
	rc.p_ndi_recv_name = "Live Studio";
	NDIlib_recv_instance_t r = lib->recv_create_v3(&rc);
	if (!r) {
		fprintf(stderr, "NDI could not open a receiver\n");
		return 2;
	}
	std::vector<uint8_t> out((size_t)W * H * 3 / 2);
	auto waitFrom = Clock::now(), saidAt = Clock::now() - std::chrono::seconds(60);
	int lastW = 0, lastH = 0, lastN = 0, lastD = 0, code = 0;
	bool warnedFmt = false;
	for (;;) {
		NDIlib_video_frame_v2_t vf;
		NDIlib_frame_type_e t = lib->recv_capture_v2(r, &vf, nullptr, nullptr, 1000);
		if (t == NDIlib_frame_type_video) {
			int kind = kindOf(vf.FourCC);
			bool ok = kind >= 0 && toI420(vf.p_data, vf.xres, vf.yres, vf.line_stride_in_bytes, kind, vf.picture_aspect_ratio, out.data(), W, H);
			if (vf.xres != lastW || vf.yres != lastH || vf.frame_rate_N != lastN || vf.frame_rate_D != lastD) {
				lastW = vf.xres, lastH = vf.yres, lastN = vf.frame_rate_N, lastD = vf.frame_rate_D;
				fprintf(stderr, "NDI %s: %dx%d at %.2f fps\n", name, vf.xres, vf.yres, vf.frame_rate_D ? (double)vf.frame_rate_N / vf.frame_rate_D : 0.0);
			}
			if (kind < 0 && !warnedFmt) {
				char cc[5] = {(char)(vf.FourCC & 255), (char)(vf.FourCC >> 8 & 255), (char)(vf.FourCC >> 16 & 255), (char)(vf.FourCC >> 24 & 255), 0};
				fprintf(stderr, "NDI %s: picture format %s is not supported\n", name, cc);
				warnedFmt = true;
			}
			lib->recv_free_video_v2(r, &vf);
			if (ok) {
				if (fwrite(out.data(), 1, out.size(), stdout) != out.size() || fflush(stdout) != 0) break; // the engine closed it
				waitFrom = Clock::now();
			}
		} else if (t == NDIlib_frame_type_error) {
			fprintf(stderr, "NDI %s: the connection was lost\n", name);
			code = 4;
			break;
		} else if (secsSince(waitFrom) > 4 && secsSince(saidAt) > 10) {
			fprintf(stderr, "waiting for the NDI source \"%s\" (%d connected)\n", name, lib->recv_get_no_connections(r));
			saidAt = Clock::now();
		}
	}
	lib->recv_destroy(r);
	return code;
}

// a moving test picture (colour bars with a white bar that runs across), for tests
static int cmdSend(const char* name, int W, int H, int N, int D, double seconds) {
	if (!loadNDI()) {
		fprintf(stderr, "%s\n", loadErr.c_str());
		return 3;
	}
	NDIlib_send_create_t sc;
	sc.p_ndi_name = name;
	sc.clock_video = true;
	sc.clock_audio = false;
	NDIlib_send_instance_t s = lib->send_create(&sc);
	if (!s) {
		fprintf(stderr, "NDI could not create a sender\n");
		return 2;
	}
	std::vector<uint8_t> buf((size_t)W * H * 2);
	static const int bars[8][3] = {{235, 128, 128}, {219, 16, 138}, {188, 154, 16}, {173, 42, 26}, {78, 214, 230}, {63, 102, 240}, {32, 240, 118}, {16, 128, 128}};
	NDIlib_video_frame_v2_t vf;
	vf.xres = W, vf.yres = H, vf.FourCC = NDIlib_FourCC_video_type_UYVY, vf.frame_rate_N = N, vf.frame_rate_D = D;
	vf.picture_aspect_ratio = 0, vf.frame_format_type = NDIlib_frame_format_type_progressive, vf.timecode = NDIlib_send_timecode_synthesize;
	vf.line_stride_in_bytes = W * 2, vf.p_metadata = nullptr, vf.timestamp = 0;
	auto t0 = Clock::now();
	for (int n = 0; secsSince(t0) < seconds; n++) {
		int run = (n * 8) % W;
		for (int y = 0; y < H; y++) {
			uint8_t* r = &buf[(size_t)y * W * 2];
			for (int x = 0; x < W; x += 2) {
				const int* c = bars[x * 8 / W];
				int Y = (x >= run && x < run + 16) ? 235 : c[0];
				r[x * 2] = (uint8_t)c[1], r[x * 2 + 1] = (uint8_t)Y, r[x * 2 + 2] = (uint8_t)c[2], r[x * 2 + 3] = (uint8_t)Y;
			}
		}
		vf.p_data = buf.data();
		lib->send_send_video_v2(s, &vf); // clocked: waits for the frame time
	}
	lib->send_destroy(s);
	return 0;
}

static int selftest() {
	int fails = 0;
	auto check = [&](bool ok, const char* what) {
		printf("%s %s\n", ok ? "ok  " : "FAIL", what);
		if (!ok) fails++;
	};
	// UYVY 1280x720 two halves: left grey (Y 100), right white (Y 235), colour 90/200
	int sw = 1280, sh = 720, W = 1920, H = 1080;
	std::vector<uint8_t> src((size_t)sw * sh * 2), out((size_t)W * H * 3 / 2);
	for (int y = 0; y < sh; y++)
		for (int x = 0; x < sw; x += 2) {
			uint8_t* p = &src[((size_t)y * sw + x) * 2];
			uint8_t Y = x < sw / 2 ? 100 : 235;
			p[0] = 90, p[1] = Y, p[2] = 200, p[3] = Y;
		}
	toI420(src.data(), sw, sh, sw * 2, 0, 0, out.data(), W, H);
	const uint8_t *oY = out.data(), *oU = oY + W * H, *oV = oU + W * H / 4;
	check(oY[540 * W + 100] == 100 && oY[540 * W + 1800] == 235, "UYVY 720p scaled to 1080p: brightness kept");
	check(oU[270 * (W / 2) + 300] == 90 && oV[270 * (W / 2) + 300] == 200, "UYVY colour kept");
	// same size: an exact copy
	toI420(src.data(), sw, sh, sw * 2, 0, 0, out.data(), sw, sh);
	check(out[10 * sw + 10] == 100 && out[10 * sw + sw - 10] == 235, "UYVY same size: exact");
	// 4:3 into 16:9: black bars left and right
	int qw = 640, qh = 480;
	std::vector<uint8_t> q((size_t)qw * qh * 2);
	for (size_t i = 0; i < q.size(); i += 4) q[i] = 128, q[i + 1] = 180, q[i + 2] = 128, q[i + 3] = 180;
	toI420(q.data(), qw, qh, qw * 2, 0, 0, out.data(), W, H);
	check(oY[540 * W + 50] == 16 && oY[540 * W + 960] == 180 && oY[540 * W + 1870] == 16, "4:3 picture: pillarboxed into 16:9");
	// BGRA white and black
	std::vector<uint8_t> bg((size_t)64 * 36 * 4);
	for (size_t i = 0; i < bg.size(); i += 4) {
		uint8_t v = (i / 4) % 64 < 32 ? 255 : 0;
		bg[i] = bg[i + 1] = bg[i + 2] = v, bg[i + 3] = 255;
	}
	std::vector<uint8_t> small((size_t)64 * 36 * 3 / 2);
	toI420(bg.data(), 64, 36, 64 * 4, 1, 0, small.data(), 64, 36);
	check(small[5 * 64 + 4] == 235 && small[5 * 64 + 60] == 16 && small[64 * 36 + 2] == 128, "BGRA: white 235, black 16, no colour");
	// stride wider than the picture
	std::vector<uint8_t> wide((size_t)(sw * 2 + 64) * sh, 0);
	for (int y = 0; y < sh; y++) memcpy(&wide[(size_t)y * (sw * 2 + 64)], &src[(size_t)y * sw * 2], sw * 2);
	toI420(wide.data(), sw, sh, sw * 2 + 64, 0, 0, out.data(), sw, sh);
	check(out[700 * sw + 10] == 100 && out[700 * sw + sw - 10] == 235, "padded lines (stride) read right");
	printf(fails ? "SELFTEST FAILED\n" : "SELFTEST OK\n");
	return fails ? 1 : 0;
}

int main(int argc, char** argv) {
#ifdef _WIN32
	_setmode(_fileno(stdout), _O_BINARY);
#endif
	setvbuf(stdout, nullptr, _IOFBF, 1 << 22);
	std::string mode = argc > 1 ? argv[1] : "";
	const char *name = argc > 2 ? argv[2] : "", *url = nullptr;
	int W = 1920, H = 1080, N = 60000, D = 1001, ms = 2500;
	double seconds = 10;
	bool low = false;
	for (int i = 2; i < argc; i++) {
		std::string a = argv[i];
		auto next = [&]() { return i + 1 < argc ? argv[++i] : (char*)""; };
		if (a == "--w") W = atoi(next());
		else if (a == "--h") H = atoi(next());
		else if (a == "--url") url = next();
		else if (a == "--low") low = true;
		else if (a == "--seconds") seconds = atof(next());
		else if (a == "--fps") {
			const char* f = next();
			if (sscanf(f, "%d/%d", &N, &D) != 2) N = atoi(f) * 1000, D = 1000;
		}
	}
	if (mode == "--list") return cmdList(argc > 2 && atoi(argv[2]) > 0 ? atoi(argv[2]) : ms);
	if (mode == "--recv" && *name) return cmdRecv(name, url, W, H, low);
	if (mode == "--send" && *name) return cmdSend(name, W, H, N, D, seconds);
	if (mode == "--selftest") return selftest();
	if (mode == "--version") {
		if (!loadNDI()) {
			printf("%s\n", loadErr.c_str());
			return 1;
		}
		printf("%s\n", lib->version());
		return 0;
	}
	fprintf(stderr, "usage: ls-ndi --list [ms] | --recv NAME --w W --h H [--url ADDR] [--low] | --send NAME | --selftest | --version\n");
	return 2;
}
