// Zeyvola Windows helper. Two modes, both started by the Zeyvola app:
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
    if (lstrcmpW(argv[1], L"--version") == 0) { Line l = { {0}, 0 }; put(&l, "{\"type\":\"version\",\"version\":\"0.1.0\"}"); emit(&l); return 0; }
    return 64;
}

void mainCRTStartup(void) { ExitProcess((UINT)run()); }
