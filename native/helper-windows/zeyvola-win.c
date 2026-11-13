// Zeyvola Windows helper. Four modes, all started by the Zeyvola app:
//
//   zeyvola-win.exe --input [--window <HWND>]
//     Reports mouse buttons and the wheel while a screen recording runs (automatic zoom), through
//     Windows' low-level mouse hook (WH_MOUSE_LL). The keyboard is never hooked or read. Nothing
//     is written to disk and nothing is sent over the network. With --window (a window recording,
//     the handle in decimal) it also reports where that window is, so the app can make positions
//     relative to it: its visible frame (DwmGetWindowAttribute, DWMWA_EXTENDED_FRAME_BOUNDS;
//     GetWindowRect if that fails), read about 30 times a second and written when it changes.
//     Nothing else about the window is read. stdout, one JSON object per line:
//       {"type":"window","at":<s>,"now":<s>,"gx":<px>,"gy":<px>,"w":<px>,"h":<px>}   (--window)
//       {"type":"ready","now":<s>}
//       {"e":"d"|"u","b":"l"|"r"|"o","at":<s>,"now":<s>,"gx":<px>,"gy":<px>}   button down / up
//       {"e":"s","dy":<notches>,"at":<s>,"now":<s>,"gx":<px>,"gy":<px>}       wheel
//     at = event time, now = time of writing; both in seconds since Windows started
//     (GetTickCount64 clock, ~16 ms steps). gx/gy are physical pixels in virtual-screen
//     coordinates (the process is per-monitor DPI aware); the app converts them to its own
//     coordinates. Exits when stdin closes or a "stop" line arrives.
//
//   zeyvola-win.exe --extract-audio <video> <out.wav>
//     Decodes the first audio track with Windows' own Media Foundation decoders (for example AAC,
//     which the app's media library does not include) and writes 16-bit PCM WAV. Answers one line:
//       {"type":"audio","audio":true|false,"converted":true|false,"codec":"aac",...,"error":"..."}
//
//   zeyvola-win.exe --encode-mp4 <out.mp4> <width> <height> <fps> <bitrate> <audio 0|1>
//     Writes an MP4 with Windows' own Media Foundation encoders through the Sink Writer: H.264 video
//     and, with audio 1, AAC sound (48 kHz stereo). The Sink Writer is created without
//     MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS, so it uses Windows' software encoders ("H264 Encoder
//     MFT", "Microsoft AAC Audio Encoder MFT"); the app only comes here when no hardware H.264
//     encoder is available to it. The file name must end in .mp4 (the Sink Writer picks the
//     container from it). H.264 High profile, or Baseline if the encoder refuses High; AAC at
//     192 kbit/s. Answers {"type":"ready","profile":"high"|"baseline"} once the encoders are set up, then reads packets
//     from stdin, each a 24-byte little-endian header and its data:
//       u32 kind (1 video, 2 audio, 3 end) · u32 length · i64 time · i64 duration (100 ns units)
//       video: one NV12 frame (width × height × 3 / 2 bytes) · audio: 16-bit stereo PCM, interleaved
//     After "end" it finishes the file and answers {"type":"done","frames":<n>,"profile":…}. Any failure:
//       {"type":"error","stage":"<step>","hr":"0x…"} and exit code 1; the app deletes the file.
//     stdin closing without "end" (export cancelled) leaves the file unfinished and exits with 2.
//
//   zeyvola-win.exe --encode-probe <out.mp4>
//     The same set-up at 320×180, two frames and 0.1 s of sound, finished and deleted: tells the
//     app before an export whether this Windows can write MP4 this way ({"type":"done"} or error).
//
// Built without any C runtime or third-party headers: win-api.h declares the Windows functions
// used, and only Windows system DLLs are linked (import definitions in imports/*.def).
#include "win-api.h"

// ─── tiny runtime (no CRT) ───────────────────────────────────────────────────

static HANDLE out_handle;

// The compiler may emit calls to these for struct initialisation and copies.
void *memset(void *d, int c, size_t n) { unsigned char *p = d; while (n--) *p++ = (unsigned char)c; return d; }
void *memcpy(void *d, const void *s, size_t n) { unsigned char *a = d; const unsigned char *b = s; while (n--) *a++ = *b++; return d; }

static void write_all(HANDLE h, const char *s, DWORD n) {
    DWORD done;
    while (n > 0 && WriteFile(h, s, n, &done, NULL) && done > 0) { s += done; n -= done; }
}

typedef struct { char buf[512]; int len; } Line;

static void put(Line *l, const char *s) { while (*s && l->len < (int)sizeof l->buf - 2) l->buf[l->len++] = *s++; }

static void put_int(Line *l, long long v) {
    char tmp[24]; int n = 0;
    unsigned long long u = v < 0 ? (unsigned long long)(-v) : (unsigned long long)v;
    do { tmp[n++] = (char)('0' + u % 10); u /= 10; } while (u && n < 22);
    if (v < 0) put(l, "-");
    while (n) { char c[2] = { tmp[--n], 0 }; put(l, c); }
}

/// Fixed-point with three decimals (enough for millisecond times and wheel notches).
static void put_fixed3(Line *l, double v) {
    long long m = (long long)(v * 1000.0 + (v >= 0 ? 0.5 : -0.5));
    if (m < 0) { put(l, "-"); m = -m; }
    put_int(l, m / 1000);
    put(l, ".");
    long long f = m % 1000;
    char d[4] = { (char)('0' + f / 100), (char)('0' + f / 10 % 10), (char)('0' + f % 10), 0 };
    put(l, d);
}

static void emit(Line *l) {
    l->buf[l->len++] = '\n';
    write_all(out_handle, l->buf, (DWORD)l->len);
}

static double now_s(void) { return (double)GetTickCount64() / 1000.0; }

// ─── --input ─────────────────────────────────────────────────────────────────

static DWORD main_thread;
static int buttons;
static HWND window;  // --window, or NULL
static RECT last_window;

/// Hook message time is GetTickCount() (32-bit ms); widen it with the 64-bit clock.
static double event_s(DWORD t32) {
    ULONGLONG now = GetTickCount64();
    DWORD back = (DWORD)now - t32;  // wraps correctly
    return (double)(now - back) / 1000.0;
}

static void report_button(int bit, int down, const MSLLHOOKSTRUCT *m) {
    if (((buttons & bit) != 0) == (down != 0)) return;  // each change once
    buttons = down ? (buttons | bit) : (buttons & ~bit);
    Line l = { {0}, 0 };
    put(&l, "{\"e\":\""); put(&l, down ? "d" : "u");
    put(&l, "\",\"b\":\""); put(&l, bit == 1 ? "l" : bit == 2 ? "r" : "o");
    put(&l, "\",\"at\":"); put_fixed3(&l, event_s(m->time));
    put(&l, ",\"now\":"); put_fixed3(&l, now_s());
    put(&l, ",\"gx\":"); put_int(&l, m->pt.x);
    put(&l, ",\"gy\":"); put_int(&l, m->pt.y);
    put(&l, "}");
    emit(&l);
}

static LRESULT mouse_proc(int code, WPARAM w, LPARAM lp) {
    if (code == HC_ACTION) {
        const MSLLHOOKSTRUCT *m = (const MSLLHOOKSTRUCT *)lp;
        switch (w) {
        case WM_LBUTTONDOWN: report_button(1, 1, m); break;
        case WM_LBUTTONUP: report_button(1, 0, m); break;
        case WM_RBUTTONDOWN: report_button(2, 1, m); break;
        case WM_RBUTTONUP: report_button(2, 0, m); break;
        case WM_MBUTTONDOWN: case WM_XBUTTONDOWN: report_button(4, 1, m); break;
        case WM_MBUTTONUP: case WM_XBUTTONUP: report_button(4, 0, m); break;
        case WM_MOUSEWHEEL: {
            Line l = { {0}, 0 };
            put(&l, "{\"e\":\"s\",\"dy\":"); put_fixed3(&l, (double)(short)HIWORD(m->mouseData) / WHEEL_DELTA);
            put(&l, ",\"at\":"); put_fixed3(&l, event_s(m->time));
            put(&l, ",\"now\":"); put_fixed3(&l, now_s());
            put(&l, ",\"gx\":"); put_int(&l, m->pt.x);
            put(&l, ",\"gy\":"); put_int(&l, m->pt.y);
            put(&l, "}");
            emit(&l);
            break;
        }
        default: break;
        }
    }
    // Never swallow input: the event always goes on to the other applications.
    return CallNextHookEx(NULL, code, w, lp);
}

/// Writes the window's bounds when they changed. Minimized or closed windows keep their last bounds.
static void report_window(void) {
    if (!window || !IsWindow(window) || IsIconic(window)) return;
    double at = now_s();
    RECT r;
    if (FAILED(DwmGetWindowAttribute(window, DWMWA_EXTENDED_FRAME_BOUNDS, &r, sizeof r)) && !GetWindowRect(window, &r)) return;
    if (r.right <= r.left || r.bottom <= r.top) return;
    if (r.left == last_window.left && r.top == last_window.top && r.right == last_window.right && r.bottom == last_window.bottom) return;
    last_window = r;
    Line l = { {0}, 0 };
    put(&l, "{\"type\":\"window\",\"at\":"); put_fixed3(&l, at);
    put(&l, ",\"now\":"); put_fixed3(&l, now_s());
    put(&l, ",\"gx\":"); put_int(&l, r.left);
    put(&l, ",\"gy\":"); put_int(&l, r.top);
    put(&l, ",\"w\":"); put_int(&l, (long long)r.right - r.left);
    put(&l, ",\"h\":"); put_int(&l, (long long)r.bottom - r.top);
    put(&l, "}");
    emit(&l);
}

/// A window handle written in decimal, as in the app's capture source id ("window:<HWND>:0").
static HWND parse_hwnd(const WCHAR *s) {
    ULONGLONG v = 0;
    if (!s || !*s) return NULL;
    for (; *s; s++) {
        if (*s < L'0' || *s > L'9' || v > 0xFFFFFFFFFFFFFFFULL) return NULL;
        v = v * 10 + (ULONGLONG)(*s - L'0');
    }
    return (HWND)(UINT_PTR)v;
}

/// Waits for "stop" or the end of stdin, then ends the message loop.
static DWORD stdin_watch(void *arg) {
    (void)arg;
    HANDLE in = GetStdHandle(STD_INPUT_HANDLE);
    char buf[64];
    DWORD n;
    char last[8] = {0};
    int ln = 0;
    while (ReadFile(in, buf, sizeof buf, &n, NULL) && n > 0) {
        for (DWORD i = 0; i < n; i++) {
            if (buf[i] == '\n' || buf[i] == '\r') {
                if (ln == 4 && last[0] == 's' && last[1] == 't' && last[2] == 'o' && last[3] == 'p') goto done;
                ln = 0;
            } else if (ln < 7) last[ln++] = buf[i];
        }
    }
done:
    PostThreadMessageW(main_thread, WM_QUIT, 0, 0);
    return 0;
}

static int run_input(HWND target) {
    // Physical pixels everywhere (Windows 10 1703+); older systems keep their default.
    HMODULE user32 = GetModuleHandleW(L"user32.dll");
    typedef BOOL (*SetCtx)(HANDLE);
    SetCtx set_ctx = user32 ? (SetCtx)(void *)GetProcAddress(user32, "SetProcessDpiAwarenessContext") : NULL;
    if (set_ctx) set_ctx((HANDLE)-4 /* DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 */);

    main_thread = GetCurrentThreadId();
    MSG msg;
    PeekMessageW(&msg, NULL, WM_USER, WM_USER, PM_NOREMOVE);  // create the message queue
    HHOOK hook = SetWindowsHookExW(WH_MOUSE_LL, mouse_proc, GetModuleHandleW(NULL), 0);
    if (!hook) {
        Line l = { {0}, 0 };
        put(&l, "{\"type\":\"error\",\"code\":\"hook\",\"win32\":"); put_int(&l, (long long)GetLastError()); put(&l, "}");
        emit(&l);
        return 2;
    }
    // The window's bounds go out before "ready", so the app knows them when recording starts.
    window = target;
    report_window();
    UINT_PTR timer = window ? SetTimer(NULL, 0, 33, NULL) : 0;
    Line r = { {0}, 0 };
    put(&r, "{\"type\":\"ready\",\"now\":"); put_fixed3(&r, now_s()); put(&r, "}");
    emit(&r);
    HANDLE t = CreateThread(NULL, 0, stdin_watch, NULL, 0, NULL);
    if (t) CloseHandle(t);
    while (GetMessageW(&msg, NULL, 0, 0) > 0) {
        if (msg.message == WM_TIMER && msg.hwnd == NULL) { report_window(); continue; }
        TranslateMessage(&msg);
        DispatchMessageW(&msg);
    }
    if (timer) KillTimer(NULL, timer);
    UnhookWindowsHookEx(hook);
    return 0;
}

// ─── --extract-audio ─────────────────────────────────────────────────────────

static void answer_audio(int audio, int converted, const char *codec, const char *error, UINT32 rate, UINT32 channels, LONGLONG ms) {
    Line l = { {0}, 0 };
    put(&l, "{\"type\":\"audio\",\"audio\":"); put(&l, audio ? "true" : "false");
    put(&l, ",\"converted\":"); put(&l, converted ? "true" : "false");
    if (codec) { put(&l, ",\"codec\":\""); put(&l, codec); put(&l, "\",\"from\":\""); put(&l, codec); put(&l, "\""); }
    if (rate) { put(&l, ",\"sampleRate\":"); put_int(&l, rate); put(&l, ",\"channels\":"); put_int(&l, channels); }
    if (ms >= 0) { put(&l, ",\"durationMs\":"); put_int(&l, ms); }
    if (error) { put(&l, ",\"error\":\""); put(&l, error); put(&l, "\""); }
    put(&l, "}");
    emit(&l);
}

static const char *codec_name(const GUID *g) {
    if (IsEqualGUID(g, &MFAudioFormat_AAC)) return "aac";
    if (IsEqualGUID(g, &MFAudioFormat_MP3)) return "mp3";
    if (IsEqualGUID(g, &MFAudioFormat_PCM)) return "pcm";
    if (IsEqualGUID(g, &MFAudioFormat_Float)) return "pcm-float";
    if (IsEqualGUID(g, &MFAudioFormat_Dolby_AC3)) return "ac3";
    if (IsEqualGUID(g, &MFAudioFormat_WMAudioV8) || IsEqualGUID(g, &MFAudioFormat_WMAudioV9)) return "wma";
    if (IsEqualGUID(g, &MFAudioFormat_ALAC)) return "alac";
    if (IsEqualGUID(g, &MFAudioFormat_FLAC)) return "flac";
    if (IsEqualGUID(g, &MFAudioFormat_Opus)) return "opus";
    return "other";
}

static void le32(unsigned char *p, DWORD v) { p[0] = (unsigned char)v; p[1] = (unsigned char)(v >> 8); p[2] = (unsigned char)(v >> 16); p[3] = (unsigned char)(v >> 24); }
static void le16(unsigned char *p, WORD v) { p[0] = (unsigned char)v; p[1] = (unsigned char)(v >> 8); }

static void wav_header(unsigned char h[44], UINT32 rate, UINT32 channels, DWORD data_bytes) {
    memcpy(h, "RIFF", 4); le32(h + 4, 36 + data_bytes); memcpy(h + 8, "WAVEfmt ", 8);
    le32(h + 16, 16); le16(h + 20, 1); le16(h + 22, (WORD)channels); le32(h + 24, rate);
    le32(h + 28, rate * channels * 2); le16(h + 32, (WORD)(channels * 2)); le16(h + 34, 16);
    memcpy(h + 36, "data", 4); le32(h + 40, data_bytes);
}

static int run_extract(const WCHAR *in, const WCHAR *outPath) {
    HRESULT hr = CoInitializeEx(NULL, COINIT_MULTITHREADED);
    if (FAILED(hr)) { answer_audio(0, 0, NULL, "com", 0, 0, -1); return 1; }
    hr = MFStartup(MF_VERSION, MFSTARTUP_LITE);
    if (FAILED(hr)) { answer_audio(0, 0, NULL, "mfstartup", 0, 0, -1); return 1; }
    IMFSourceReader *reader = NULL;
    hr = MFCreateSourceReaderFromURL(in, NULL, &reader);
    if (FAILED(hr)) { answer_audio(0, 0, NULL, "open", 0, 0, -1); return 1; }
    DWORD audio_stream = (DWORD)MF_SOURCE_READER_FIRST_AUDIO_STREAM;
    COM_CALL(reader, SetStreamSelection, (DWORD)MF_SOURCE_READER_ALL_STREAMS, FALSE);
    hr = COM_CALL(reader, SetStreamSelection, audio_stream, TRUE);
    if (FAILED(hr)) { answer_audio(0, 0, NULL, NULL, 0, 0, -1); return 0; }  // no audio track

    const char *codec = "other";
    IMFMediaType *native = NULL;
    if (SUCCEEDED(COM_CALL(reader, GetNativeMediaType, audio_stream, 0, &native))) {
        GUID sub;
        if (SUCCEEDED(COM_CALL(native, GetGUID, &MF_MT_SUBTYPE, &sub))) codec = codec_name(&sub);
        COM_CALL(native, Release);
    }

    // Formats the app's media library plays itself: nothing to convert.
    if (lstrcmpA(codec, "opus") == 0 || lstrcmpA(codec, "flac") == 0 || lstrcmpA(codec, "mp3") == 0 || lstrcmpA(codec, "pcm") == 0) {
        answer_audio(1, 0, codec, NULL, 0, 0, -1);
        COM_CALL(reader, Release);
        MFShutdown();
        return 0;
    }

    IMFMediaType *want = NULL;
    MFCreateMediaType(&want);
    COM_CALL(want, SetGUID, &MF_MT_MAJOR_TYPE, &MFMediaType_Audio);
    COM_CALL(want, SetGUID, &MF_MT_SUBTYPE, &MFAudioFormat_PCM);
    COM_CALL(want, SetUINT32, &MF_MT_AUDIO_BITS_PER_SAMPLE, 16);
    hr = COM_CALL(reader, SetCurrentMediaType, audio_stream, NULL, want);
    COM_CALL(want, Release);
    if (FAILED(hr)) { answer_audio(1, 0, codec, "no-decoder", 0, 0, -1); return 0; }
    IMFMediaType *got = NULL;
    UINT32 rate = 0, channels = 0;
    if (SUCCEEDED(COM_CALL(reader, GetCurrentMediaType, audio_stream, &got))) {
        COM_CALL(got, GetUINT32, &MF_MT_AUDIO_SAMPLES_PER_SECOND, &rate);
        COM_CALL(got, GetUINT32, &MF_MT_AUDIO_NUM_CHANNELS, &channels);
        COM_CALL(got, Release);
    }
    if (!rate || !channels) { answer_audio(1, 0, codec, "format", 0, 0, -1); return 0; }

    HANDLE f = CreateFileW(outPath, GENERIC_WRITE, 0, NULL, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    if (f == INVALID_HANDLE_VALUE) { answer_audio(1, 0, codec, "write", rate, channels, -1); return 1; }
    unsigned char header[44];
    wav_header(header, rate, channels, 0);
    write_all(f, (const char *)header, 44);

    unsigned long long bytes = 0;
    const unsigned long long frame = (unsigned long long)channels * 2;
    int first = 1;
    int failed = 0;
    static char zeros[4096];
    for (;;) {
        DWORD flags = 0;
        LONGLONG ts = 0;
        IMFSample *sample = NULL;
        hr = COM_CALL(reader, ReadSample, audio_stream, 0, NULL, &flags, &ts, &sample);
        if (FAILED(hr)) { failed = 1; break; }
        if (flags & MF_SOURCE_READERF_ENDOFSTREAM) { if (sample) COM_CALL(sample, Release); break; }
        if (!sample) continue;
        if (first) {
            // Sound that starts after the video: keep the delay as silence so it stays in sync.
            first = 0;
            if (ts > 0) {
                unsigned long long pad = ((unsigned long long)ts * rate / 10000000ULL) * frame;
                bytes += pad;
                while (pad > 0) { DWORD n = pad > sizeof zeros ? (DWORD)sizeof zeros : (DWORD)pad; write_all(f, zeros, n); pad -= n; }
            }
        }
        IMFMediaBuffer *buf = NULL;
        if (SUCCEEDED(COM_CALL(sample, ConvertToContiguousBuffer, &buf))) {
            BYTE *data = NULL;
            DWORD len = 0;
            if (SUCCEEDED(COM_CALL(buf, Lock, &data, NULL, &len))) {
                write_all(f, (const char *)data, len);
                bytes += len;
                COM_CALL(buf, Unlock);
            }
            COM_CALL(buf, Release);
        }
        COM_CALL(sample, Release);
        if (bytes > 0xFFFFFFF0ULL - 44) { failed = 2; break; }  // WAV size limit (about 6 h of 48 kHz stereo)
    }
    // Patch the sizes into the header.
    wav_header(header, rate, channels, (DWORD)(bytes > 0xFFFFFFF0ULL - 44 ? 0xFFFFFFF0ULL - 44 : bytes));
    SetFilePointer(f, 0, NULL, FILE_BEGIN);
    write_all(f, (const char *)header, 44);
    CloseHandle(f);
    COM_CALL(reader, Release);
    MFShutdown();
    if (failed) { DeleteFileW(outPath); answer_audio(1, 0, codec, failed == 2 ? "too-long" : "decode", rate, channels, -1); return 1; }
    answer_audio(1, 1, codec, NULL, rate, channels, (LONGLONG)(bytes / frame * 1000 / rate));
    return 0;
}

// ─── --encode-mp4 / --encode-probe ───────────────────────────────────────────

static void put_hex(Line *l, DWORD v) {
    static const char digits[] = "0123456789abcdef";
    char t[11] = "0x00000000";
    for (int i = 0; i < 8; i++) t[9 - i] = digits[(v >> (i * 4)) & 0xf];
    put(l, t);
}

static int encode_fail(const char *stage, HRESULT hr) {
    Line l = { {0}, 0 };
    put(&l, "{\"type\":\"error\",\"stage\":\""); put(&l, stage); put(&l, "\",\"hr\":\""); put_hex(&l, (DWORD)hr); put(&l, "\"}");
    emit(&l);
    return 1;
}

static long long parse_int(const WCHAR *s) {
    long long v = 0;
    if (!s || !*s) return -1;
    for (; *s; s++) { if (*s < '0' || *s > '9') return -1; v = v * 10 + (*s - '0'); if (v > 1000000000LL) return -1; }
    return v;
}

#define SAMPLE_RATE 48000u
#define CHANNELS 2u

typedef struct { IMFSinkWriter *writer; DWORD video, audio; int has_audio; UINT32 width, height; const char *profile; } Encoder;

static IMFMediaType *video_type(const GUID *subtype, UINT32 w, UINT32 h, UINT32 fps, UINT32 bitrate, UINT32 profile) {
    IMFMediaType *t = NULL;
    if (FAILED(MFCreateMediaType(&t))) return NULL;
    COM_CALL(t, SetGUID, &MF_MT_MAJOR_TYPE, &MFMediaType_Video);
    COM_CALL(t, SetGUID, &MF_MT_SUBTYPE, subtype);
    if (bitrate) COM_CALL(t, SetUINT32, &MF_MT_AVG_BITRATE, bitrate);
    if (profile) COM_CALL(t, SetUINT32, &MF_MT_MPEG2_PROFILE, profile);
    COM_CALL(t, SetUINT32, &MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive);
    COM_CALL(t, SetUINT64, &MF_MT_FRAME_SIZE, ((ULONGLONG)w << 32) | h);
    COM_CALL(t, SetUINT64, &MF_MT_FRAME_RATE, ((ULONGLONG)fps << 32) | 1u);
    COM_CALL(t, SetUINT64, &MF_MT_PIXEL_ASPECT_RATIO, (1ull << 32) | 1u);
    return t;
}

// AAC encoder (Microsoft Learn, "AAC Encoder"): input 16-bit PCM at 44.1 or 48 kHz, 1, 2 or 6
// channels; output AAC with the same rate and channels, at 12000, 16000, 20000 or 24000 bytes/s.
// 24000 bytes/s (192 kbit/s) matches the app's other AAC and Opus exports.
static IMFMediaType *audio_type(const GUID *subtype) {
    IMFMediaType *t = NULL;
    if (FAILED(MFCreateMediaType(&t))) return NULL;
    COM_CALL(t, SetGUID, &MF_MT_MAJOR_TYPE, &MFMediaType_Audio);
    COM_CALL(t, SetGUID, &MF_MT_SUBTYPE, subtype);
    COM_CALL(t, SetUINT32, &MF_MT_AUDIO_BITS_PER_SAMPLE, 16);
    COM_CALL(t, SetUINT32, &MF_MT_AUDIO_SAMPLES_PER_SECOND, SAMPLE_RATE);
    COM_CALL(t, SetUINT32, &MF_MT_AUDIO_NUM_CHANNELS, CHANNELS);
    if (IsEqualGUID(subtype, &MFAudioFormat_AAC)) COM_CALL(t, SetUINT32, &MF_MT_AUDIO_AVG_BYTES_PER_SECOND, 24000);
    return t;
}

/// Creates the Sink Writer with its H.264 stream; 0 or the failing step's HRESULT in *hr.
static const char *open_video(Encoder *e, const WCHAR *path, UINT32 w, UINT32 h, UINT32 fps, UINT32 bitrate, UINT32 profile, HRESULT *hr) {
    *hr = MFCreateSinkWriterFromURL(path, NULL, NULL, &e->writer);
    if (FAILED(*hr)) return "create";
    IMFMediaType *out = video_type(&MFVideoFormat_H264, w, h, fps, bitrate, profile);
    if (!out) { *hr = (HRESULT)0x80004005; return "video-type"; }
    *hr = COM_CALL(e->writer, AddStream, out, &e->video);
    COM_CALL(out, Release);
    if (FAILED(*hr)) return "video-stream";
    IMFMediaType *in = video_type(&MFVideoFormat_NV12, w, h, fps, 0, 0);
    if (!in) { *hr = (HRESULT)0x80004005; return "video-type"; }
    *hr = COM_CALL(e->writer, SetInputMediaType, e->video, in, NULL);
    COM_CALL(in, Release);
    if (FAILED(*hr)) return "video-encoder";
    return NULL;
}

/// Sets up the Sink Writer; returns 0 or reports the failing step. H.264 High profile first (better
/// picture at the same bit rate); if the encoder refuses it, the documented default (Baseline).
static int encoder_open(Encoder *e, const WCHAR *path, UINT32 w, UINT32 h, UINT32 fps, UINT32 bitrate, int audio) {
    HRESULT hr = CoInitializeEx(NULL, COINIT_MULTITHREADED);
    if (FAILED(hr)) return encode_fail("com", hr);
    hr = MFStartup(MF_VERSION, 0);
    if (FAILED(hr)) return encode_fail("mfstartup", hr);
    e->width = w; e->height = h; e->has_audio = audio;
    const char *stage = open_video(e, path, w, h, fps, bitrate, eAVEncH264VProfile_High, &hr);
    e->profile = "high";
    if (stage && lstrcmpA(stage, "create") != 0) {
        if (e->writer) { COM_CALL(e->writer, Release); e->writer = NULL; }
        DeleteFileW(path);
        stage = open_video(e, path, w, h, fps, bitrate, 0, &hr);
        e->profile = "baseline";
    }
    if (stage) return encode_fail(stage, hr);
    if (audio) {
        IMFMediaType *aout = audio_type(&MFAudioFormat_AAC);
        if (!aout) return encode_fail("audio-type", (HRESULT)0x80004005);
        hr = COM_CALL(e->writer, AddStream, aout, &e->audio);
        COM_CALL(aout, Release);
        if (FAILED(hr)) return encode_fail("audio-stream", hr);
        IMFMediaType *ain = audio_type(&MFAudioFormat_PCM);
        if (!ain) return encode_fail("audio-type", (HRESULT)0x80004005);
        hr = COM_CALL(e->writer, SetInputMediaType, e->audio, ain, NULL);
        COM_CALL(ain, Release);
        if (FAILED(hr)) return encode_fail("audio-encoder", hr);
    }
    hr = COM_CALL(e->writer, BeginWriting);
    if (FAILED(hr)) return encode_fail("begin", hr);
    return 0;
}

/// One sample from `len` bytes; `fill` copies them into the buffer (from stdin, or test data).
typedef int (*FillFn)(BYTE *dst, DWORD len, void *ctx);

static int encoder_write(Encoder *e, int audio, DWORD len, LONGLONG time, LONGLONG duration, FillFn fill, void *ctx) {
    IMFMediaBuffer *buf = NULL;
    IMFSample *sample = NULL;
    HRESULT hr = MFCreateMemoryBuffer(len, &buf);
    if (FAILED(hr)) return encode_fail("buffer", hr);
    BYTE *data = NULL;
    hr = COM_CALL(buf, Lock, &data, NULL, NULL);
    if (FAILED(hr)) { COM_CALL(buf, Release); return encode_fail("buffer", hr); }
    int ok = fill(data, len, ctx);
    COM_CALL(buf, Unlock);
    if (!ok) { COM_CALL(buf, Release); return 2; }  // stdin closed in the middle of a packet
    COM_CALL(buf, SetCurrentLength, len);
    hr = MFCreateSample(&sample);
    if (FAILED(hr)) { COM_CALL(buf, Release); return encode_fail("sample", hr); }
    COM_CALL(sample, AddBuffer, buf);
    COM_CALL(sample, SetSampleTime, time);
    COM_CALL(sample, SetSampleDuration, duration > 0 ? duration : 1);  // never zero (AAC encoder note)
    hr = COM_CALL(e->writer, WriteSample, audio ? e->audio : e->video, sample);
    COM_CALL(sample, Release);
    COM_CALL(buf, Release);
    if (FAILED(hr)) return encode_fail(audio ? "audio-write" : "video-write", hr);
    return 0;
}

static HANDLE in_handle;

static int read_exact(BYTE *dst, DWORD len, void *ctx) {
    (void)ctx;
    while (len > 0) {
        DWORD got = 0;
        if (!ReadFile(in_handle, dst, len, &got, NULL) || got == 0) return 0;
        dst += got; len -= got;
    }
    return 1;
}

static DWORD rd32(const BYTE *p) { return (DWORD)p[0] | ((DWORD)p[1] << 8) | ((DWORD)p[2] << 16) | ((DWORD)p[3] << 24); }
static LONGLONG rd64(const BYTE *p) { return (LONGLONG)((ULONGLONG)rd32(p) | ((ULONGLONG)rd32(p + 4) << 32)); }

static int run_encode(const WCHAR *path, UINT32 w, UINT32 h, UINT32 fps, UINT32 bitrate, int audio) {
    in_handle = GetStdHandle(STD_INPUT_HANDLE);
    Encoder e = { 0 };
    if (encoder_open(&e, path, w, h, fps, bitrate, audio)) return 1;
    { Line l = { {0}, 0 }; put(&l, "{\"type\":\"ready\",\"profile\":\""); put(&l, e.profile); put(&l, "\"}"); emit(&l); }
    const DWORD frame_bytes = w * h * 3 / 2;
    long long frames = 0;
    for (;;) {
        BYTE head[24];
        if (!read_exact(head, sizeof head, NULL)) { COM_CALL(e.writer, Release); return 2; }  // cancelled
        DWORD kind = rd32(head), len = rd32(head + 4);
        LONGLONG time = rd64(head + 8), duration = rd64(head + 16);
        if (kind == 3) break;
        if ((kind == 1 && len != frame_bytes) || (kind == 2 && (!audio || len == 0 || len % 4 != 0 || len > 4u * SAMPLE_RATE)) || (kind != 1 && kind != 2)) {
            return encode_fail("packet", (HRESULT)0x80070057);
        }
        int r = encoder_write(&e, kind == 2, len, time, duration, read_exact, NULL);
        if (r == 2) { COM_CALL(e.writer, Release); return 2; }
        if (r) return 1;
        if (kind == 1) frames++;
    }
    HRESULT hr = COM_CALL(e.writer, Finalize);
    COM_CALL(e.writer, Release);
    MFShutdown();
    if (FAILED(hr)) return encode_fail("finalize", hr);
    Line l = { {0}, 0 };
    put(&l, "{\"type\":\"done\",\"frames\":"); put_int(&l, frames); put(&l, ",\"profile\":\""); put(&l, e.profile); put(&l, "\"}");
    emit(&l);
    return 0;
}

typedef struct { int frame; UINT32 w, h; } ProbeFill;

static int probe_video(BYTE *dst, DWORD len, void *ctx) {
    ProbeFill *p = ctx;
    DWORD luma = p->w * p->h;
    for (DWORD i = 0; i < len; i++) dst[i] = i < luma ? (BYTE)(((i % p->w) + (DWORD)p->frame * 16) & 0xff) : 128;
    return 1;
}

static int probe_audio(BYTE *dst, DWORD len, void *ctx) {
    (void)ctx;
    for (DWORD i = 0; i < len; i++) dst[i] = (BYTE)((i & 64) ? 0x10 : 0xf0);
    return 1;
}

static int run_encode_probe(const WCHAR *path) {
    Encoder e = { 0 };
    const UINT32 w = 320, h = 180, fps = 30;
    if (encoder_open(&e, path, w, h, fps, 1000000, 1)) { DeleteFileW(path); return 1; }
    ProbeFill pf = { 0, w, h };
    for (int i = 0; i < 2; i++) {
        pf.frame = i;
        if (encoder_write(&e, 0, w * h * 3 / 2, (LONGLONG)i * 10000000 / fps, 10000000 / fps, probe_video, &pf)) { DeleteFileW(path); return 1; }
    }
    const DWORD pcm = SAMPLE_RATE / 10 * CHANNELS * 2;  // 0.1 s
    if (encoder_write(&e, 1, pcm, 0, 1000000, probe_audio, NULL)) { DeleteFileW(path); return 1; }
    HRESULT hr = COM_CALL(e.writer, Finalize);
    COM_CALL(e.writer, Release);
    MFShutdown();
    DeleteFileW(path);
    if (FAILED(hr)) return encode_fail("finalize", hr);
    Line l = { {0}, 0 };
    put(&l, "{\"type\":\"done\",\"frames\":2,\"profile\":\""); put(&l, e.profile); put(&l, "\"}");
    emit(&l);
    return 0;
}

// ─── entry ───────────────────────────────────────────────────────────────────

static int run(void) {
    out_handle = GetStdHandle(STD_OUTPUT_HANDLE);
    int argc = 0;
    WCHAR **argv = CommandLineToArgvW(GetCommandLineW(), &argc);
    if (!argv || argc < 2) return 64;
    if (lstrcmpW(argv[1], L"--input") == 0) {
        HWND target = NULL;
        if (argc >= 4 && lstrcmpW(argv[2], L"--window") == 0 && !(target = parse_hwnd(argv[3]))) return 64;
        return run_input(target);
    }
    if (lstrcmpW(argv[1], L"--extract-audio") == 0 && argc >= 4) return run_extract(argv[2], argv[3]);
    if (lstrcmpW(argv[1], L"--encode-mp4") == 0 && argc >= 8) {
        long long w = parse_int(argv[3]), h = parse_int(argv[4]), fps = parse_int(argv[5]), bitrate = parse_int(argv[6]), audio = parse_int(argv[7]);
        if (w < 16 || h < 16 || w > 8192 || h > 8192 || (w & 1) || (h & 1) || fps < 1 || fps > 240 || bitrate < 1 || (audio != 0 && audio != 1)) return 64;
        return run_encode(argv[2], (UINT32)w, (UINT32)h, (UINT32)fps, (UINT32)bitrate, (int)audio);
    }
    if (lstrcmpW(argv[1], L"--encode-probe") == 0 && argc >= 3) return run_encode_probe(argv[2]);
    if (lstrcmpW(argv[1], L"--version") == 0) { Line l = { {0}, 0 }; put(&l, "{\"type\":\"version\",\"version\":\"0.1.0\"}"); emit(&l); return 0; }
    return 64;
}

void mainCRTStartup(void) { ExitProcess((UINT)run()); }
