// The few Windows declarations zeyvola-win.c uses, written for this project so that no third-party
// header set is needed to build it. Names, values, structure layouts and COM method orders follow
// Microsoft's documentation and Microsoft's own bindings (windows-rs 0.62.2, generated from
// win32metadata); they describe the Windows interfaces and contain no implementation.
// x64 only: Windows has a single calling convention there, so none is spelled out.
#ifndef ZEYVOLA_WIN_API_H
#define ZEYVOLA_WIN_API_H

typedef __SIZE_TYPE__ size_t;
typedef int BOOL;
typedef unsigned char BYTE;
typedef unsigned short WORD;
typedef unsigned int UINT, UINT32, DWORD;  // DWORD is 32-bit on Windows (LLP64)
typedef int LONG, HRESULT;
typedef long long LONGLONG, LONG_PTR, LPARAM, LRESULT;
typedef unsigned long long ULONGLONG, UINT_PTR, WPARAM;
typedef __WCHAR_TYPE__ WCHAR;  // 16-bit on Windows targets, the type of L"" literals
typedef void *HANDLE, *HMODULE, *HINSTANCE, *HHOOK, *HWND;

#define TRUE 1
#define FALSE 0
#define NULL ((void *)0)
#define WINAPI
#define CALLBACK
#define SUCCEEDED(hr) ((HRESULT)(hr) >= 0)
#define FAILED(hr) ((HRESULT)(hr) < 0)
#define HIWORD(v) ((WORD)(((ULONGLONG)(v) >> 16) & 0xffff))

typedef struct { DWORD Data1; WORD Data2; WORD Data3; BYTE Data4[8]; } GUID;
static inline int IsEqualGUID(const GUID *a, const GUID *b) {
    const BYTE *x = (const BYTE *)a, *y = (const BYTE *)b;
    for (int i = 0; i < 16; i++) if (x[i] != y[i]) return 0;
    return 1;
}

// ─── kernel32 ────────────────────────────────────────────────────────────────

#define STD_INPUT_HANDLE ((DWORD)-10)
#define STD_OUTPUT_HANDLE ((DWORD)-11)
#define GENERIC_WRITE 0x40000000u
#define CREATE_ALWAYS 2u
#define FILE_ATTRIBUTE_NORMAL 0x80u
#define FILE_BEGIN 0u
#define INVALID_HANDLE_VALUE ((HANDLE)(LONG_PTR)-1)

typedef DWORD (*LPTHREAD_START_ROUTINE)(void *);
typedef LONG_PTR (*FARPROC)(void);

BOOL CloseHandle(HANDLE h);
HANDLE CreateFileW(const WCHAR *name, DWORD access, DWORD share, void *security, DWORD disposition, DWORD flags, HANDLE templ);
HANDLE CreateThread(void *security, size_t stack, LPTHREAD_START_ROUTINE start, void *param, DWORD flags, DWORD *id);
BOOL DeleteFileW(const WCHAR *name);
__attribute__((noreturn)) void ExitProcess(UINT code);
WCHAR *GetCommandLineW(void);
DWORD GetCurrentThreadId(void);
DWORD GetLastError(void);
HMODULE GetModuleHandleW(const WCHAR *name);
FARPROC GetProcAddress(HMODULE module, const char *name);
HANDLE GetStdHandle(DWORD which);
ULONGLONG GetTickCount64(void);
BOOL ReadFile(HANDLE h, void *buf, DWORD n, DWORD *read, void *overlapped);
DWORD SetFilePointer(HANDLE h, LONG distance, LONG *high, DWORD method);
BOOL WriteFile(HANDLE h, const void *buf, DWORD n, DWORD *written, void *overlapped);
int lstrcmpA(const char *a, const char *b);
int lstrcmpW(const WCHAR *a, const WCHAR *b);

// ─── user32 ──────────────────────────────────────────────────────────────────

#define HC_ACTION 0
#define WH_MOUSE_LL 14
#define WM_QUIT 0x0012u
#define WM_USER 0x0400u
#define WM_LBUTTONDOWN 0x0201u
#define WM_LBUTTONUP 0x0202u
#define WM_RBUTTONDOWN 0x0204u
#define WM_RBUTTONUP 0x0205u
#define WM_MBUTTONDOWN 0x0207u
#define WM_MBUTTONUP 0x0208u
#define WM_MOUSEWHEEL 0x020Au
#define WM_XBUTTONDOWN 0x020Bu
#define WM_XBUTTONUP 0x020Cu
#define WM_TIMER 0x0113u
#define WHEEL_DELTA 120
#define PM_NOREMOVE 0u

typedef struct { LONG x; LONG y; } POINT;
typedef struct { LONG left; LONG top; LONG right; LONG bottom; } RECT;
typedef struct { HWND hwnd; UINT message; WPARAM wParam; LPARAM lParam; DWORD time; POINT pt; } MSG;
typedef struct { POINT pt; DWORD mouseData; DWORD flags; DWORD time; UINT_PTR dwExtraInfo; } MSLLHOOKSTRUCT;
typedef LRESULT (*HOOKPROC)(int code, WPARAM w, LPARAM l);
typedef void (*TIMERPROC)(HWND hwnd, UINT msg, UINT_PTR id, DWORD time);

LRESULT CallNextHookEx(HHOOK hook, int code, WPARAM w, LPARAM l);
LRESULT DispatchMessageW(const MSG *msg);
BOOL GetMessageW(MSG *msg, HWND hwnd, UINT min, UINT max);
BOOL GetWindowRect(HWND hwnd, RECT *rect);
BOOL IsIconic(HWND hwnd);
BOOL IsWindow(HWND hwnd);
BOOL KillTimer(HWND hwnd, UINT_PTR id);
BOOL PeekMessageW(MSG *msg, HWND hwnd, UINT min, UINT max, UINT remove);
BOOL PostThreadMessageW(DWORD thread, UINT msg, WPARAM w, LPARAM l);
UINT_PTR SetTimer(HWND hwnd, UINT_PTR id, UINT elapse, TIMERPROC proc);
HHOOK SetWindowsHookExW(int id, HOOKPROC proc, HINSTANCE module, DWORD thread);
BOOL TranslateMessage(const MSG *msg);
BOOL UnhookWindowsHookEx(HHOOK hook);

// ─── dwmapi ──────────────────────────────────────────────────────────────────

#define DWMWA_EXTENDED_FRAME_BOUNDS 9u
HRESULT DwmGetWindowAttribute(HWND hwnd, DWORD attribute, void *value, DWORD size);

// ─── shell32, ole32 ──────────────────────────────────────────────────────────

WCHAR **CommandLineToArgvW(const WCHAR *cmd, int *argc);
#define COINIT_MULTITHREADED 0u
HRESULT CoInitializeEx(void *reserved, DWORD flags);

// ─── Media Foundation (mfplat, mfreadwrite) ──────────────────────────────────

#define MF_VERSION 0x00020070u  // MF_SDK_VERSION 2 << 16 | MF_API_VERSION 0x70
#define MFSTARTUP_LITE 1u
#define MF_SOURCE_READER_FIRST_AUDIO_STREAM ((DWORD)-3)
#define MF_SOURCE_READER_ALL_STREAMS ((DWORD)-2)
#define MF_SOURCE_READERF_ENDOFSTREAM 0x2u

// Attribute keys and media types.
static const GUID MF_MT_MAJOR_TYPE = { 0x48eba18e, 0xf8c9, 0x4687, { 0xbf, 0x11, 0x0a, 0x74, 0xc9, 0xf9, 0x6a, 0x8f } };
static const GUID MF_MT_SUBTYPE = { 0xf7e34c9a, 0x42e8, 0x4714, { 0xb7, 0x4b, 0xcb, 0x29, 0xd7, 0x2c, 0x35, 0xe5 } };
static const GUID MF_MT_AUDIO_BITS_PER_SAMPLE = { 0xf2deb57f, 0x40fa, 0x4764, { 0xaa, 0x33, 0xed, 0x4f, 0x2d, 0x1f, 0xf6, 0x69 } };
static const GUID MF_MT_AUDIO_SAMPLES_PER_SECOND = { 0x5faeeae7, 0x0290, 0x4c31, { 0x9e, 0x8a, 0xc5, 0x34, 0xf6, 0x8d, 0x9d, 0xba } };
static const GUID MF_MT_AUDIO_NUM_CHANNELS = { 0x37e48bf5, 0x645e, 0x4c5b, { 0x89, 0xde, 0xad, 0xa9, 0xe2, 0x9b, 0x69, 0x6a } };
static const GUID MFMediaType_Audio = { 0x73647561, 0x0000, 0x0010, { 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71 } };
static const GUID MFAudioFormat_Dolby_AC3 = { 0xe06d802c, 0xdb46, 0x11cf, { 0xb4, 0xd1, 0x00, 0x80, 0x5f, 0x6c, 0xbb, 0xea } };
// Audio subtypes built from a WAVE format tag: {tag-0000-0010-8000-00AA00389B71}.
#define MF_AUDIO_TAG(tag) { (tag), 0x0000, 0x0010, { 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71 } }
static const GUID MFAudioFormat_PCM = MF_AUDIO_TAG(0x0001);
static const GUID MFAudioFormat_Float = MF_AUDIO_TAG(0x0003);
static const GUID MFAudioFormat_MP3 = MF_AUDIO_TAG(0x0055);
static const GUID MFAudioFormat_WMAudioV8 = MF_AUDIO_TAG(0x0161);
static const GUID MFAudioFormat_WMAudioV9 = MF_AUDIO_TAG(0x0162);
static const GUID MFAudioFormat_AAC = MF_AUDIO_TAG(0x1610);
static const GUID MFAudioFormat_ALAC = MF_AUDIO_TAG(0x6c61);
static const GUID MFAudioFormat_Opus = MF_AUDIO_TAG(0x704f);
static const GUID MFAudioFormat_FLAC = MF_AUDIO_TAG(0xf1ac);

// COM interfaces: only the methods used are typed; the others keep their slot in the table.
typedef void *Slot;
#define UNKNOWN_SLOTS Slot QueryInterface; Slot AddRef; UINT (*Release)(void *self);

typedef struct IMFMediaType IMFMediaType;
typedef struct IMFSample IMFSample;
typedef struct IMFMediaBuffer IMFMediaBuffer;
typedef struct IMFSourceReader IMFSourceReader;

// IMFAttributes (30 methods after IUnknown); IMFMediaType and IMFSample start with it.
#define ATTRIBUTE_SLOTS \
    UNKNOWN_SLOTS \
    Slot GetItem, GetItemType, CompareItem, Compare; \
    HRESULT (*GetUINT32)(void *self, const GUID *key, UINT32 *value); \
    Slot GetUINT64, GetDouble; \
    HRESULT (*GetGUID)(void *self, const GUID *key, GUID *value); \
    Slot GetStringLength, GetString, GetAllocatedString, GetBlobSize, GetBlob, GetAllocatedBlob, GetUnknown, SetItem, DeleteItem, DeleteAllItems; \
    HRESULT (*SetUINT32)(void *self, const GUID *key, UINT32 value); \
    Slot SetUINT64, SetDouble; \
    HRESULT (*SetGUID)(void *self, const GUID *key, const GUID *value); \
    Slot SetString, SetBlob, SetUnknown, LockStore, UnlockStore, GetCount, GetItemByIndex, CopyAllItems;

struct IMFMediaType { const struct { ATTRIBUTE_SLOTS Slot GetMajorType, IsCompressedFormat, IsEqual, GetRepresentation, FreeRepresentation; } *v; };

struct IMFSample {
    const struct {
        ATTRIBUTE_SLOTS
        Slot GetSampleFlags, SetSampleFlags, GetSampleTime, SetSampleTime, GetSampleDuration, SetSampleDuration, GetBufferCount, GetBufferByIndex;
        HRESULT (*ConvertToContiguousBuffer)(void *self, IMFMediaBuffer **out);
        Slot AddBuffer, RemoveBufferByIndex, RemoveAllBuffers, GetTotalLength, CopyToBuffer;
    } *v;
};

struct IMFMediaBuffer {
    const struct {
        UNKNOWN_SLOTS
        HRESULT (*Lock)(void *self, BYTE **data, DWORD *max, DWORD *current);
        HRESULT (*Unlock)(void *self);
        Slot GetCurrentLength, SetCurrentLength, GetMaxLength;
    } *v;
};

struct IMFSourceReader {
    const struct {
        UNKNOWN_SLOTS
        Slot GetStreamSelection;
        HRESULT (*SetStreamSelection)(void *self, DWORD stream, BOOL selected);
        HRESULT (*GetNativeMediaType)(void *self, DWORD stream, DWORD index, IMFMediaType **out);
        HRESULT (*GetCurrentMediaType)(void *self, DWORD stream, IMFMediaType **out);
        HRESULT (*SetCurrentMediaType)(void *self, DWORD stream, DWORD *reserved, IMFMediaType *type);
        Slot SetCurrentPosition;
        HRESULT (*ReadSample)(void *self, DWORD stream, DWORD control, DWORD *actual, DWORD *flags, LONGLONG *timestamp, IMFSample **sample);
        Slot Flush, GetServiceForStream, GetPresentationAttribute;
    } *v;
};

#define COM_CALL(obj, method, ...) ((obj)->v->method((obj), ##__VA_ARGS__))

HRESULT MFStartup(DWORD version, DWORD flags);
HRESULT MFShutdown(void);
HRESULT MFCreateMediaType(IMFMediaType **out);
HRESULT MFCreateSourceReaderFromURL(const WCHAR *url, void *attributes, IMFSourceReader **out);

#endif
