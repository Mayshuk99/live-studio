// Live Studio — VST3 plug-in host for the Master inserts.
//
// Runs the plug-ins in their own process, so a plug-in that misbehaves can never take Live Studio or the
// stream down with it. Live Studio sends the master sound in small blocks and gets each block back processed.
//
// Messages both ways (stdin / stdout):  [u32 header length][u32 payload length][header][payload]
//   header = fields separated by tabs, the first one is the command / event
//
//   ls-vst --scan-one <module>   lists the effects in one .vst3 module (text lines) and exits
//
// VST is a trademark of Steinberg Media Technologies GmbH. VST 3 SDK: MIT license (see VST3_LICENSE.txt).

#include "public.sdk/source/vst/hosting/module.h"
#include "public.sdk/source/vst/hosting/plugprovider.h"
#include "public.sdk/source/vst/hosting/hostclasses.h"
#include "public.sdk/source/vst/hosting/processdata.h"
#include "public.sdk/source/vst/hosting/parameterchanges.h"
#include "public.sdk/source/vst/utility/uid.h"
#include "public.sdk/source/common/memorystream.h"
#include "pluginterfaces/vst/ivstaudioprocessor.h"
#include "pluginterfaces/vst/ivsteditcontroller.h"
#include "pluginterfaces/vst/ivstcomponent.h"
#include "pluginterfaces/vst/ivstprocesscontext.h"
#include "pluginterfaces/vst/vstspeaker.h"
#include "pluginterfaces/gui/iplugview.h"

#include <algorithm>
#include <atomic>
#include <cstdlib>
#include <condition_variable>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <deque>
#include <functional>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#ifdef _WIN32
#define NOMINMAX
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <ole2.h>
#include <fcntl.h>
#include <io.h>
#define sys_read _read
#define sys_write _write
#else
#include <unistd.h>
#define sys_read read
#define sys_write write
#endif

using namespace Steinberg;
using namespace Steinberg::Vst;

static const char* kVersion = "1";

/* ---------------- messages ---------------- */

static int outFd = 1;
static std::mutex outMu;

static bool writeAll(int fd, const void* p, size_t n)
{
	auto* c = static_cast<const char*>(p);
	while (n > 0)
	{
		int w = (int)sys_write(fd, c, (unsigned)std::min<size_t>(n, 1 << 20));
		if (w <= 0)
			return false;
		c += w;
		n -= (size_t)w;
	}
	return true;
}

static bool readAll(int fd, void* p, size_t n)
{
	auto* c = static_cast<char*>(p);
	while (n > 0)
	{
		int r = (int)sys_read(fd, c, (unsigned)std::min<size_t>(n, 1 << 20));
		if (r <= 0)
			return false;
		c += r;
		n -= (size_t)r;
	}
	return true;
}

static void emit (const std::vector<std::string>& fields, const void* payload = nullptr, uint32_t plen = 0)
{
	std::string h;
	for (size_t i = 0; i < fields.size(); i++)
	{
		if (i)
			h += '\t';
		for (char ch : fields[i])
			h += (ch == '\t' || ch == '\n' || ch == '\r') ? ' ' : ch;
	}
	uint32_t pre[2] = {(uint32_t)h.size(), plen};
	std::lock_guard<std::mutex> g (outMu);
	writeAll (outFd, pre, 8);
	writeAll (outFd, h.data (), h.size ());
	if (plen)
		writeAll (outFd, payload, plen);
}

static void hostLog (const std::string& s) { emit ({"log", s}); }

static std::vector<std::string> split (const std::string& s, char c)
{
	std::vector<std::string> out;
	std::string cur;
	for (char ch : s)
	{
		if (ch == c)
		{
			out.push_back (cur);
			cur.clear ();
		}
		else
			cur += ch;
	}
	out.push_back (cur);
	return out;
}

/* ---------------- the window thread (plug-in setup and editors run here) ---------------- */

static std::mutex qmu;
static std::condition_variable qcv;
static std::deque<std::function<void ()>> tasks;
static std::atomic<bool> quitting {false};
#ifdef _WIN32
static DWORD uiThread = 0;
static HINSTANCE hInst = nullptr;
#endif

static void postUI (std::function<void ()> f)
{
	{
		std::lock_guard<std::mutex> g (qmu);
		tasks.push_back (std::move (f));
	}
#ifdef _WIN32
	PostThreadMessageW (uiThread, WM_APP, 0, 0);
#else
	qcv.notify_one ();
#endif
}

static void runTasks ()
{
	for (;;)
	{
		std::function<void ()> f;
		{
			std::lock_guard<std::mutex> g (qmu);
			if (tasks.empty ())
				return;
			f = std::move (tasks.front ());
			tasks.pop_front ();
		}
		f ();
	}
}

/* ---------------- one insert ---------------- */

struct Slot;

class Handler : public IComponentHandler
{
public:
	Slot* s = nullptr;
	tresult PLUGIN_API beginEdit (ParamID) override { return kResultOk; }
	tresult PLUGIN_API performEdit (ParamID id, ParamValue v) override;
	tresult PLUGIN_API endEdit (ParamID) override;
	tresult PLUGIN_API restartComponent (int32 flags) override;
	tresult PLUGIN_API queryInterface (const TUID iid, void** obj) override
	{
		QUERY_INTERFACE (iid, obj, FUnknown::iid, IComponentHandler)
		QUERY_INTERFACE (iid, obj, IComponentHandler::iid, IComponentHandler)
		*obj = nullptr;
		return kNoInterface;
	}
	uint32 PLUGIN_API addRef () override { return 1000; }
	uint32 PLUGIN_API release () override { return 1000; }
};

class Frame : public IPlugFrame
{
public:
	Slot* s = nullptr;
	tresult PLUGIN_API resizeView (IPlugView* view, ViewRect* newSize) override;
	tresult PLUGIN_API queryInterface (const TUID iid, void** obj) override
	{
		QUERY_INTERFACE (iid, obj, FUnknown::iid, IPlugFrame)
		QUERY_INTERFACE (iid, obj, IPlugFrame::iid, IPlugFrame)
		*obj = nullptr;
		return kNoInterface;
	}
	uint32 PLUGIN_API addRef () override { return 1000; }
	uint32 PLUGIN_API release () override { return 1000; }
};

struct Slot
{
	std::string id, path, cid, name;
	VST3::Hosting::Module::Ptr mod;
	IPtr<PlugProvider> prov;
	IPtr<IComponent> comp;
	IPtr<IAudioProcessor> proc;
	IPtr<IEditController> ctrl;
	HostProcessData data;
	ParameterChanges inCh, outCh;
	ProcessContext ctx {};
	std::mutex pmu;
	std::vector<std::pair<ParamID, ParamValue>> pending; // from the editor, for the next block
	std::map<ParamID, ParamValue> fromPlug;               // from the plug-in (meters), for the editor
	bool fromPlugQueued = false;
	std::atomic<bool> bypass {false};
	std::atomic<bool> broken {false};
	bool processing = false;
	std::atomic<int> latency {0};
	int nIn = 2, nOut = 2;
	Handler handler;
	Frame frame;
	IPtr<IPlugView> view;
	void* wnd = nullptr;
	bool resizing = false;
	std::atomic<int64_t> editedAt {0};
};

static double sampleRate = 48000;
static int32 maxBlock = 512;
static std::map<std::string, VST3::Hosting::Module::Ptr> modules;  // window thread
static std::map<std::string, std::shared_ptr<Slot>> slots;         // window thread
static std::vector<std::shared_ptr<Slot>> chain;                    // the order the sound goes through
static std::mutex chainMu;

tresult PLUGIN_API Handler::performEdit (ParamID id, ParamValue v)
{
	{
		std::lock_guard<std::mutex> g (s->pmu);
		s->pending.emplace_back (id, v);
	}
	s->editedAt = 1;
	return kResultOk;
}

tresult PLUGIN_API Handler::endEdit (ParamID)
{
	emit ({"edited", s->id});
	return kResultOk;
}

tresult PLUGIN_API Handler::restartComponent (int32 flags)
{
	Slot* sl = s;
	if (flags & kLatencyChanged)
	{
		postUI ([sl] () {
			std::lock_guard<std::mutex> g (chainMu);
			if (sl->processing)
				sl->proc->setProcessing (false);
			sl->processing = false;
			sl->comp->setActive (false);
			sl->latency = (int)sl->proc->getLatencySamples ();
			sl->comp->setActive (true);
			emit ({"latency", sl->id, std::to_string (sl->latency.load ())});
		});
	}
	if (flags & (kParamValuesChanged | kReloadComponent))
		emit ({"edited", s->id});
	return kResultOk;
}

/* ---------------- state: [u32 length][processor state][u32 length][editor state] ---------------- */

static void putBlock (std::vector<uint8_t>& out, MemoryStream& m)
{
	uint32_t n = (uint32_t)m.getSize ();
	const uint8_t* p = reinterpret_cast<const uint8_t*> (m.getData ());
	out.insert (out.end (), reinterpret_cast<uint8_t*> (&n), reinterpret_cast<uint8_t*> (&n) + 4);
	if (n)
		out.insert (out.end (), p, p + n);
}

static std::vector<uint8_t> getState (Slot& s)
{
	std::vector<uint8_t> out;
	MemoryStream cs, ks;
	s.comp->getState (&cs);
	if (s.ctrl)
		s.ctrl->getState (&ks);
	putBlock (out, cs);
	putBlock (out, ks);
	return out;
}

static void applyState (Slot& s, const std::vector<uint8_t>& st)
{
	if (st.size () < 8)
		return;
	uint32_t a = 0;
	std::memcpy (&a, st.data (), 4);
	if (8 + (size_t)a > st.size ())
		return;
	uint32_t b = 0;
	std::memcpy (&b, st.data () + 4 + a, 4);
	if (8 + (size_t)a + b > st.size ())
		return;
	if (a)
	{
		MemoryStream m;
		int32 w = 0;
		m.write ((void*)(st.data () + 4), (int32)a, &w);
		m.seek (0, IBStream::kIBSeekSet, nullptr);
		s.comp->setState (&m);
		if (s.ctrl)
		{
			m.seek (0, IBStream::kIBSeekSet, nullptr);
			s.ctrl->setComponentState (&m);
		}
	}
	if (b && s.ctrl)
	{
		MemoryStream m;
		int32 w = 0;
		m.write ((void*)(st.data () + 8 + a), (int32)b, &w);
		m.seek (0, IBStream::kIBSeekSet, nullptr);
		s.ctrl->setState (&m);
	}
}

/* ---------------- loading ---------------- */

static VST3::Hosting::Module::Ptr getModule (const std::string& path, std::string& err)
{
	auto it = modules.find (path);
	if (it != modules.end ())
		return it->second;
	auto m = VST3::Hosting::Module::create (path, err);
	if (m)
		modules[path] = m;
	return m;
}

static bool setupSlot (Slot& s, const std::vector<uint8_t>& state, std::string& err)
{
	std::string merr;
	s.mod = getModule (s.path, merr);
	if (!s.mod)
	{
		err = "could not open the plug-in file: " + merr;
		return false;
	}
	auto uid = VST3::UID::fromString (s.cid);
	if (!uid)
	{
		err = "bad plug-in id";
		return false;
	}
	const auto& factory = s.mod->getFactory ();
	bool found = false;
	VST3::Hosting::ClassInfo info;
	for (auto& ci : factory.classInfos ())
		if (ci.ID () == *uid)
		{
			info = ci;
			found = true;
		}
	if (!found)
	{
		err = "this plug-in is no longer in its file (updated or removed?)";
		return false;
	}
	s.name = info.name ();
	s.prov = owned (new PlugProvider (factory, info, true));
	if (!s.prov->initialize ())
	{
		err = "the plug-in did not start";
		return false;
	}
	s.comp = s.prov->getComponentPtr ();
	s.ctrl = s.prov->getControllerPtr ();
	s.proc = U::cast<IAudioProcessor> (s.comp);
	if (!s.comp || !s.proc)
	{
		err = "not an audio effect";
		return false;
	}
	s.handler.s = &s;
	s.frame.s = &s;
	if (s.ctrl)
		s.ctrl->setComponentHandler (&s.handler);

	// stereo in, stereo out on the main busses (mono plug-ins are fed L+R and their output goes to both sides)
	int32 ni = s.comp->getBusCount (kAudio, kInput), no = s.comp->getBusCount (kAudio, kOutput);
	if (no < 1)
	{
		err = "the plug-in has no audio output";
		return false;
	}
	std::vector<SpeakerArrangement> ia (ni), oa (no);
	for (int32 i = 0; i < ni; i++)
		s.proc->getBusArrangement (kInput, i, ia[i]);
	for (int32 i = 0; i < no; i++)
		s.proc->getBusArrangement (kOutput, i, oa[i]);
	if (ni > 0)
		ia[0] = SpeakerArr::kStereo;
	oa[0] = SpeakerArr::kStereo;
	if (s.proc->setBusArrangements (ni ? ia.data () : nullptr, ni, oa.data (), no) != kResultTrue)
	{
		for (int32 i = 0; i < ni; i++)
			s.proc->getBusArrangement (kInput, i, ia[i]);
		for (int32 i = 0; i < no; i++)
			s.proc->getBusArrangement (kOutput, i, oa[i]);
	}
	s.nIn = ni ? SpeakerArr::getChannelCount (ia[0]) : 0;
	s.nOut = SpeakerArr::getChannelCount (oa[0]);
	for (int32 i = 0; i < ni; i++)
		s.comp->activateBus (kAudio, kInput, i, i == 0);
	for (int32 i = 0; i < no; i++)
		s.comp->activateBus (kAudio, kOutput, i, i == 0);
	for (int32 i = 0; i < s.comp->getBusCount (kEvent, kInput); i++)
		s.comp->activateBus (kEvent, kInput, i, false);
	for (int32 i = 0; i < s.comp->getBusCount (kEvent, kOutput); i++)
		s.comp->activateBus (kEvent, kOutput, i, false);

	ProcessSetup ps {kRealtime, kSample32, maxBlock, sampleRate};
	if (s.proc->setupProcessing (ps) != kResultOk)
	{
		err = "the plug-in does not accept " + std::to_string ((int)sampleRate) + " Hz";
		return false;
	}
	applyState (s, state);
	if (s.comp->setActive (true) != kResultOk)
	{
		err = "the plug-in could not be switched on";
		return false;
	}
	s.latency = (int)s.proc->getLatencySamples ();
	if (!s.data.prepare (*s.comp, maxBlock, kSample32))
	{
		err = "no sound buffers for this plug-in";
		return false;
	}
	s.data.inputParameterChanges = &s.inCh;
	s.data.outputParameterChanges = &s.outCh;
	s.data.processContext = &s.ctx;
	s.ctx.sampleRate = sampleRate;
	s.ctx.tempo = 120;
	s.ctx.timeSigNumerator = 4;
	s.ctx.timeSigDenominator = 4;
	s.ctx.state = ProcessContext::kPlaying | ProcessContext::kTempoValid | ProcessContext::kTimeSigValid |
	              ProcessContext::kContTimeValid;
	for (int32 b = 0; b < s.data.numInputs; b++)
		for (int32 c = 0; c < s.data.inputs[b].numChannels; c++)
			std::memset (s.data.inputs[b].channelBuffers32[c], 0, sizeof (float) * maxBlock);
	return true;
}

static void closeEditor (Slot* s);

static void teardown (std::shared_ptr<Slot> s)
{
	closeEditor (s.get ());
	if (s->processing)
		s->proc->setProcessing (false);
	if (s->comp)
		s->comp->setActive (false);
	if (s->ctrl)
		s->ctrl->setComponentHandler (nullptr);
	s->data.unprepare ();
	s->proc = nullptr;
	s->ctrl = nullptr;
	s->comp = nullptr;
	s->prov = nullptr; // terminates the plug-in
}

/* ---------------- the sound ---------------- */

#ifdef _WIN32
// a plug-in that crashes while processing is switched off instead of taking the host down
static int safeProcess (IAudioProcessor* p, ProcessData* d)
{
	__try
	{
		return (int)p->process (*d);
	}
	__except (EXCEPTION_EXECUTE_HANDLER)
	{
		return -1000;
	}
}
#else
static int safeProcess (IAudioProcessor* p, ProcessData* d) { return (int)p->process (*d); }
#endif

static void processSlot (const std::shared_ptr<Slot>& sp0, float* L, float* R, int n)
{
	Slot& s = *sp0;
	if (!s.processing)
	{
		s.proc->setProcessing (true);
		s.processing = true;
	}
	s.inCh.clearQueue ();
	{
		std::lock_guard<std::mutex> g (s.pmu);
		for (auto& pv : s.pending)
		{
			int32 qi = 0, pi = 0;
			if (auto* q = s.inCh.addParameterData (pv.first, qi))
				q->addPoint (0, pv.second, pi);
		}
		s.pending.clear ();
	}
	s.outCh.clearQueue ();
	s.data.numSamples = n;
	if (s.data.numInputs > 0)
	{
		auto& ib = s.data.inputs[0];
		ib.silenceFlags = 0;
		if (ib.numChannels >= 2)
		{
			std::memcpy (ib.channelBuffers32[0], L, sizeof (float) * n);
			std::memcpy (ib.channelBuffers32[1], R, sizeof (float) * n);
			for (int32 c = 2; c < ib.numChannels; c++)
				std::memset (ib.channelBuffers32[c], 0, sizeof (float) * n);
		}
		else if (ib.numChannels == 1)
			for (int i = 0; i < n; i++)
				ib.channelBuffers32[0][i] = 0.5f * (L[i] + R[i]);
	}
	for (int32 b = 0; b < s.data.numOutputs; b++)
		s.data.outputs[b].silenceFlags = 0;
	int r = safeProcess (s.proc.get (), &s.data);
	if (r == -1000)
	{
		s.broken = true;
		emit ({"broken", s.id, "the plug-in crashed while processing — it is switched off"});
		return;
	}
	if (r == kResultOk && s.data.numOutputs > 0)
	{
		auto& ob = s.data.outputs[0];
		if (ob.numChannels >= 2)
		{
			std::memcpy (L, ob.channelBuffers32[0], sizeof (float) * n);
			std::memcpy (R, ob.channelBuffers32[1], sizeof (float) * n);
		}
		else if (ob.numChannels == 1)
		{
			std::memcpy (L, ob.channelBuffers32[0], sizeof (float) * n);
			std::memcpy (R, ob.channelBuffers32[0], sizeof (float) * n);
		}
	}
	s.ctx.projectTimeSamples += n;
	s.ctx.continousTimeSamples += n;
	// what the plug-in reports (meters, gain reduction) goes to its editor
	int32 pc = s.outCh.getParameterCount ();
	if (pc > 0 && s.ctrl)
	{
		std::lock_guard<std::mutex> g (s.pmu);
		for (int32 i = 0; i < pc; i++)
		{
			auto* q = s.outCh.getParameterData (i);
			int32 np = q ? q->getPointCount () : 0;
			int32 off = 0;
			ParamValue v = 0;
			if (np > 0 && q->getPoint (np - 1, off, v) == kResultOk)
				s.fromPlug[q->getParameterId ()] = v;
		}
		if (!s.fromPlugQueued)
		{
			s.fromPlugQueued = true;
			std::weak_ptr<Slot> weak = sp0; // the insert may be removed before this runs
			postUI ([weak] () {
				auto sp = weak.lock ();
				if (!sp)
					return;
				std::map<ParamID, ParamValue> m;
				{
					std::lock_guard<std::mutex> g (sp->pmu);
					m.swap (sp->fromPlug);
					sp->fromPlugQueued = false;
				}
				if (sp->ctrl)
					for (auto& kv : m)
						sp->ctrl->setParamNormalized (kv.first, kv.second);
			});
		}
	}
}

static std::vector<float> wl, wr;

// returns the delay (in samples) of the plug-ins that processed this block
static int processAudio (float* io, int frames)
{
	int lat = 0;
	if ((int)wl.size () < frames)
	{
		wl.resize (frames);
		wr.resize (frames);
	}
	for (int i = 0; i < frames; i++)
	{
		wl[i] = io[i * 2];
		wr[i] = io[i * 2 + 1];
	}
	{
		std::lock_guard<std::mutex> g (chainMu);
		for (auto& s : chain)
		{
			if (s->bypass || s->broken || !s->proc)
				continue;
			for (int o = 0; o < frames; o += maxBlock)
				processSlot (s, wl.data () + o, wr.data () + o, std::min (maxBlock, frames - o));
			if (!s->broken)
				lat += s->latency;
		}
	}
	for (int i = 0; i < frames; i++)
	{
		io[i * 2] = wl[i];
		io[i * 2 + 1] = wr[i];
	}
	return lat;
}

static int chainLatency ()
{
	int l = 0;
	for (auto& s : chain)
		if (!s->bypass && !s->broken)
			l += s->latency;
	return l;
}

/* ---------------- editors (Windows) ---------------- */

#ifdef _WIN32
static std::wstring wide (const std::string& s)
{
	int n = MultiByteToWideChar (CP_UTF8, 0, s.c_str (), -1, nullptr, 0);
	std::wstring w (n > 0 ? n - 1 : 0, L'\0');
	if (n > 1)
		MultiByteToWideChar (CP_UTF8, 0, s.c_str (), -1, &w[0], n);
	return w;
}

static LRESULT CALLBACK editorProc (HWND h, UINT m, WPARAM w, LPARAM l)
{
	Slot* s = reinterpret_cast<Slot*> (GetWindowLongPtrW (h, GWLP_USERDATA));
	switch (m)
	{
		case WM_CLOSE:
			if (s)
				closeEditor (s);
			else
				DestroyWindow (h);
			return 0;
		case WM_SIZE:
			if (s && s->view && !s->resizing && s->view->canResize () == kResultTrue)
			{
				RECT rc;
				GetClientRect (h, &rc);
				ViewRect vr (0, 0, rc.right, rc.bottom);
				s->view->onSize (&vr);
			}
			break;
	}
	return DefWindowProcW (h, m, w, l);
}

tresult PLUGIN_API Frame::resizeView (IPlugView* view, ViewRect* r)
{
	if (!s || !s->wnd || !r)
		return kResultFalse;
	HWND h = (HWND)s->wnd;
	s->resizing = true;
	RECT wr {0, 0, r->getWidth (), r->getHeight ()};
	AdjustWindowRectEx (&wr, (DWORD)GetWindowLongW (h, GWL_STYLE), FALSE, (DWORD)GetWindowLongW (h, GWL_EXSTYLE));
	SetWindowPos (h, nullptr, 0, 0, wr.right - wr.left, wr.bottom - wr.top, SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE);
	view->onSize (r);
	s->resizing = false;
	return kResultTrue;
}

static void openEditor (Slot* s)
{
	if (s->wnd)
	{
		ShowWindow ((HWND)s->wnd, SW_RESTORE);
		SetForegroundWindow ((HWND)s->wnd);
		return;
	}
	if (!s->ctrl)
	{
		emit ({"editor", s->id, "none"});
		return;
	}
	IPtr<IPlugView> v = owned (s->ctrl->createView (ViewType::kEditor));
	if (!v || v->isPlatformTypeSupported (kPlatformTypeHWND) != kResultTrue)
	{
		emit ({"editor", s->id, "none"});
		return;
	}
	ViewRect r;
	if (v->getSize (&r) != kResultOk || r.getWidth () <= 0)
		r = ViewRect (0, 0, 600, 400);
	DWORD style = WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX;
	if (v->canResize () == kResultTrue)
		style |= WS_THICKFRAME | WS_MAXIMIZEBOX;
	DWORD ex = WS_EX_TOPMOST; // stays above Live Studio while you adjust it
	RECT wr {0, 0, r.getWidth (), r.getHeight ()};
	AdjustWindowRectEx (&wr, style, FALSE, ex);
	std::wstring title = wide (s->name + "  —  Live Studio Master insert");
	HWND h = CreateWindowExW (ex, L"LiveStudioVstEditor", title.c_str (), style, CW_USEDEFAULT, CW_USEDEFAULT,
	                          wr.right - wr.left, wr.bottom - wr.top, nullptr, nullptr, hInst, nullptr);
	if (!h)
	{
		emit ({"editor", s->id, "none"});
		return;
	}
	SetWindowLongPtrW (h, GWLP_USERDATA, (LONG_PTR)s);
	s->wnd = h;
	s->view = v;
	v->setFrame (&s->frame);
	if (v->attached ((void*)h, kPlatformTypeHWND) != kResultOk)
	{
		s->view->setFrame (nullptr);
		s->view = nullptr;
		SetWindowLongPtrW (h, GWLP_USERDATA, 0);
		DestroyWindow (h);
		s->wnd = nullptr;
		emit ({"editor", s->id, "none"});
		return;
	}
	ShowWindow (h, SW_SHOW);
	SetForegroundWindow (h);
	emit ({"editor", s->id, "open"});
}

static void closeEditor (Slot* s)
{
	bool was = s->wnd != nullptr;
	if (s->view)
	{
		s->view->removed ();
		s->view->setFrame (nullptr);
		s->view = nullptr;
	}
	if (s->wnd)
	{
		SetWindowLongPtrW ((HWND)s->wnd, GWLP_USERDATA, 0);
		DestroyWindow ((HWND)s->wnd);
		s->wnd = nullptr;
	}
	if (was)
	{
		emit ({"editor", s->id, "closed"});
		emit ({"edited", s->id});
	}
}
#else
tresult PLUGIN_API Frame::resizeView (IPlugView*, ViewRect*) { return kResultFalse; }
static void openEditor (Slot* s) { emit ({"editor", s->id, "none"}); }
static void closeEditor (Slot*) {}
#endif

/* ---------------- commands ---------------- */

static void setChain (const std::vector<std::string>& ids)
{
	std::vector<std::shared_ptr<Slot>> c;
	for (auto& id : ids)
	{
		auto it = slots.find (id);
		if (it != slots.end ())
			c.push_back (it->second);
	}
	std::lock_guard<std::mutex> g (chainMu);
	chain.swap (c);
}

static std::vector<std::string> order; // ids in order, as Live Studio last said

static void command (const std::vector<std::string>& f, std::vector<uint8_t> payload)
{
	const std::string& cmd = f[0];
	if (cmd == "init" && f.size () >= 3)
	{
		double sr = std::atof (f[1].c_str ());
		int mb = std::atoi (f[2].c_str ());
		if (sr > 8000)
			sampleRate = sr;
		if (mb >= 64 && mb <= 8192)
			maxBlock = mb;
	}
	else if (cmd == "load" && f.size () >= 4)
	{
		std::string id = f[1];
		auto old = slots.find (id);
		if (old != slots.end ())
		{
			auto o = old->second;
			slots.erase (old);
			setChain (order);
			teardown (o);
		}
		auto s = std::make_shared<Slot> ();
		s->id = id;
		s->path = f[2];
		s->cid = f[3];
		std::string err;
		if (!setupSlot (*s, payload, err))
		{
			emit ({"loaded", id, "0", err});
			teardown (s);
			return;
		}
		slots[id] = s;
		if (std::find (order.begin (), order.end (), id) == order.end ())
			order.push_back (id);
		setChain (order);
		emit ({"loaded", id, "1", std::to_string (s->latency.load ()), s->name, std::to_string (s->nIn), std::to_string (s->nOut)});
		{
			std::lock_guard<std::mutex> g (chainMu);
			emit ({"latency", "*", std::to_string (chainLatency ())});
		}
	}
	else if (cmd == "unload" && f.size () >= 2)
	{
		auto it = slots.find (f[1]);
		order.erase (std::remove (order.begin (), order.end (), f[1]), order.end ());
		if (it != slots.end ())
		{
			auto s = it->second;
			slots.erase (it);
			setChain (order);
			teardown (s);
		}
		emit ({"unloaded", f[1]});
		std::lock_guard<std::mutex> g (chainMu);
		emit ({"latency", "*", std::to_string (chainLatency ())});
	}
	else if (cmd == "order")
	{
		order.assign (f.begin () + 1, f.end ());
		setChain (order);
	}
	else if (cmd == "bypass" && f.size () >= 3)
	{
		auto it = slots.find (f[1]);
		if (it != slots.end ())
			it->second->bypass = f[2] == "1";
		std::lock_guard<std::mutex> g (chainMu);
		emit ({"latency", "*", std::to_string (chainLatency ())});
	}
	else if (cmd == "edit" && f.size () >= 2)
	{
		auto it = slots.find (f[1]);
		if (it != slots.end ())
			openEditor (it->second.get ());
	}
	else if (cmd == "close-edit" && f.size () >= 2)
	{
		auto it = slots.find (f[1]);
		if (it != slots.end ())
			closeEditor (it->second.get ());
	}
	else if (cmd == "get-state" && f.size () >= 2)
	{
		auto it = slots.find (f[1]);
		if (it != slots.end ())
		{
			auto st = getState (*it->second);
			emit ({"state", f[1]}, st.data (), (uint32_t)st.size ());
		}
	}
	else if (cmd == "quit")
	{
		for (auto& kv : slots)
			closeEditor (kv.second.get ());
		{
			std::lock_guard<std::mutex> g (chainMu);
			chain.clear ();
		}
		for (auto& kv : slots)
			teardown (kv.second);
		slots.clear ();
		quitting = true;
	}
}

/* ---------------- reading stdin (the sound is processed right here, everything else on the window thread) ---------------- */

static void reader ()
{
	std::vector<uint8_t> payload;
	for (;;)
	{
		uint32_t pre[2];
		if (!readAll (0, pre, 8) || pre[0] > (1u << 20) || pre[1] > (256u << 20))
			break;
		std::string h (pre[0], '\0');
		if (pre[0] && !readAll (0, &h[0], pre[0]))
			break;
		payload.resize (pre[1]);
		if (pre[1] && !readAll (0, payload.data (), pre[1]))
			break;
		auto f = split (h, '\t');
		if (f[0] == "audio" && f.size () >= 3)
		{
			int frames = std::atoi (f[2].c_str ());
			if (frames > 0 && payload.size () >= (size_t)frames * 8)
			{
				int lat = processAudio (reinterpret_cast<float*> (payload.data ()), frames);
				emit ({"audio", f[1], f[2], std::to_string (lat)}, payload.data (), (uint32_t)frames * 8);
			}
			continue;
		}
		postUI ([f, payload] () { command (f, payload); });
		if (f[0] == "quit")
			return;
	}
	postUI ([] () { command ({"quit"}, {}); });
}

/* ---------------- scanning one module ---------------- */

static int scanOne (const std::string& path)
{
	std::string err;
	auto m = VST3::Hosting::Module::create (path, err);
	if (!m)
	{
		std::string line = "error\t" + err + "\n";
		writeAll (outFd, line.data (), line.size ());
		return 1;
	}
	auto fi = m->getFactory ().info ();
	for (auto& ci : m->getFactory ().classInfos ())
	{
		if (ci.category () != kVstAudioEffectClass)
			continue;
		std::string vendor = ci.vendor ().empty () ? fi.vendor () : ci.vendor ();
		std::string line = "class\t" + ci.ID ().toString () + "\t" + ci.name () + "\t" + vendor + "\t" +
		                   ci.subCategoriesString () + "\t" + ci.version () + "\n";
		for (char& ch : line)
			if (ch == '\r')
				ch = ' ';
		writeAll (outFd, line.data (), line.size ());
	}
	writeAll (outFd, "done\n", 5);
	return 0;
}

int main (int argc, char** argv)
{
	// plug-ins sometimes print to the console: keep that away from Live Studio's message stream
#ifdef _WIN32
	_setmode (_fileno (stdin), _O_BINARY);
	outFd = _dup (_fileno (stdout));
	_setmode (outFd, _O_BINARY);
	_dup2 (_fileno (stderr), _fileno (stdout));
	SetStdHandle (STD_OUTPUT_HANDLE, GetStdHandle (STD_ERROR_HANDLE));
	SetProcessDPIAware ();
	hInst = GetModuleHandleW (nullptr);
	OleInitialize (nullptr); // some editors use drag & drop / COM
#else
	outFd = dup (1);
	dup2 (2, 1);
#endif
	auto host = owned (new HostApplication ());
	PluginContextFactory::instance ().setPluginContext (host);

	if (argc >= 3 && std::string (argv[1]) == "--scan-one")
		return scanOne (argv[2]);

#ifdef _WIN32
	uiThread = GetCurrentThreadId ();
	MSG msg;
	PeekMessageW (&msg, nullptr, WM_USER, WM_USER, PM_NOREMOVE); // the thread's message queue exists from now on
	WNDCLASSW wc {};
	wc.lpfnWndProc = editorProc;
	wc.hInstance = hInst;
	wc.lpszClassName = L"LiveStudioVstEditor";
	wc.hCursor = LoadCursor (nullptr, IDC_ARROW);
	wc.hIcon = LoadIcon (nullptr, IDI_APPLICATION);
	RegisterClassW (&wc);
#endif
	emit ({"ready", kVersion});
	std::thread rd (reader);
	rd.detach ();
#ifdef _WIN32
	while (!quitting && GetMessageW (&msg, nullptr, 0, 0) > 0)
	{
		if (msg.message == WM_APP && msg.hwnd == nullptr)
		{
			runTasks ();
			continue;
		}
		TranslateMessage (&msg);
		DispatchMessageW (&msg);
	}
#else
	while (!quitting)
	{
		std::unique_lock<std::mutex> lk (qmu);
		qcv.wait_for (lk, std::chrono::milliseconds (50), [] { return !tasks.empty (); });
		lk.unlock ();
		runTasks ();
	}
#endif
	runTasks ();
	PluginContextFactory::instance ().setPluginContext (nullptr);
	std::fflush (stderr);
	_exit (0);
}
