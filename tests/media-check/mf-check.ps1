# Windows counterpart of av-check.swift: opens an exported video with Windows' own media stack
# (Media Foundation Source Reader), the way the Films & TV / Media Player apps see it, not with
# Chromium's decoders.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File mf-check.ps1 -File <video>
#       one JSON line: container duration, and for the first video and audio stream the codec,
#       the number of decoded frames / seconds, the brightness spread of the picture and the
#       loudest sample. av-check.mjs turns these facts into problems (same rules as on macOS).
#   powershell -NoProfile -ExecutionPolicy Bypass -File mf-check.ps1 -Inventory -Out <folder>
#       one JSON line: Windows version, whether Media Foundation starts, the registered H.264 / AAC
#       encoders and decoders (MFTEnumEx, software and hardware separately), and one small H.264
#       encode through the Sink Writer with the default (software) encoder, decoded back.
#
# Nothing is installed or downloaded: the C# below is compiled by the .NET Framework that comes
# with Windows (Add-Type). Media Foundation is called the way native/helper-windows does it:
# through the COM method tables, in the order of native/helper-windows/win-api.h (Microsoft's
# documentation and win32metadata). This file stays ASCII so Windows PowerShell 5.1 reads it.
param(
  [string]$File,
  [switch]$Inventory,
  [string]$Out
)
$ErrorActionPreference = 'Stop'

$source = @'
using System;
using System.Collections;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class ZeyvolaMf {
  // --- Media Foundation flat functions --------------------------------------------------------
  [DllImport("mfplat.dll")] static extern int MFStartup(int version, int flags);
  [DllImport("mfplat.dll")] static extern int MFShutdown();
  [DllImport("mfplat.dll")] static extern int MFCreateMediaType(out IntPtr type);
  [DllImport("mfplat.dll")] static extern int MFCreateMemoryBuffer(int maxLength, out IntPtr buffer);
  [DllImport("mfplat.dll")] static extern int MFCreateSample(out IntPtr sample);
  [DllImport("mfplat.dll")] static extern int MFTEnumEx(Guid category, int flags, IntPtr inputType, IntPtr outputType, out IntPtr activates, out int count);
  [DllImport("mfreadwrite.dll", CharSet = CharSet.Unicode)] static extern int MFCreateSourceReaderFromURL(string url, IntPtr attributes, out IntPtr reader);
  [DllImport("mfreadwrite.dll", CharSet = CharSet.Unicode)] static extern int MFCreateSinkWriterFromURL(string url, IntPtr byteStream, IntPtr attributes, out IntPtr writer);
  [DllImport("ole32.dll")] static extern int CoInitializeEx(IntPtr reserved, int flags);
  [DllImport("ole32.dll")] static extern void CoTaskMemFree(IntPtr p);

  const int MF_VERSION = 0x00020070;
  const int FIRST_VIDEO = unchecked((int)0xFFFFFFFC);
  const int FIRST_AUDIO = unchecked((int)0xFFFFFFFD);
  const int ALL_STREAMS = unchecked((int)0xFFFFFFFE);
  const int MEDIASOURCE = unchecked((int)0xFFFFFFFF);
  const int READERF_ERROR = 0x1, READERF_ENDOFSTREAM = 0x2, READERF_TYPECHANGED = 0x20;

  // --- GUIDs (Microsoft documentation: mfapi.h, mfidl.h, mfreadwrite.h) ------------------------
  static Guid MF_MT_MAJOR_TYPE = new Guid("48eba18e-f8c9-4687-bf11-0a74c9f96a8f");
  static Guid MF_MT_SUBTYPE = new Guid("f7e34c9a-42e8-4714-b74b-cb29d72c35e5");
  static Guid MF_MT_FRAME_SIZE = new Guid("1652c33d-d6b2-4012-b834-72030849a37d");
  static Guid MF_MT_FRAME_RATE = new Guid("c459a2e8-3d2c-4e44-b132-fee5156c7bb0");
  static Guid MF_MT_PIXEL_ASPECT_RATIO = new Guid("c6376a1e-8d0a-4027-be45-6d9a0ad39bb6");
  static Guid MF_MT_INTERLACE_MODE = new Guid("e2724bb8-e676-4806-b4b2-a8d6efb44ccd");
  static Guid MF_MT_AVG_BITRATE = new Guid("20332624-fb0d-4d9e-bd0d-cbf6786c102e");
  static Guid MF_MT_DEFAULT_STRIDE = new Guid("644b4e48-1e02-4516-b0eb-c01ca9d49ac6");
  static Guid MF_MT_AUDIO_SAMPLES_PER_SECOND = new Guid("5faeeae7-0290-4c31-9e8a-c534f68d9dba");
  static Guid MF_MT_AUDIO_NUM_CHANNELS = new Guid("37e48bf5-645e-4c5b-89de-ada9e29b696a");
  static Guid MF_MT_MINIMUM_DISPLAY_APERTURE = new Guid("d7388766-18fe-48c6-a177-ee894867c8c4");
  static Guid MF_PD_DURATION = new Guid("6c990d33-bb8e-477a-8598-0d5d96fcd88a");
  static Guid MFT_FRIENDLY_NAME = new Guid("314ffbae-5b41-4c95-9c19-4e7d586face3");
  static Guid MFMediaType_Video = new Guid("73646976-0000-0010-8000-00aa00389b71");
  static Guid MFMediaType_Audio = new Guid("73647561-0000-0010-8000-00aa00389b71");
  static Guid MFVideoFormat_NV12 = new Guid("3231564e-0000-0010-8000-00aa00389b71");
  static Guid MFVideoFormat_H264 = new Guid("34363248-0000-0010-8000-00aa00389b71");
  static Guid MFAudioFormat_Float = new Guid("00000003-0000-0010-8000-00aa00389b71");
  static Guid MFAudioFormat_AAC = new Guid("00001610-0000-0010-8000-00aa00389b71");
  static Guid MFT_CATEGORY_VIDEO_ENCODER = new Guid("f79eac7d-e545-4387-bdee-d647d7bde42a");
  static Guid MFT_CATEGORY_VIDEO_DECODER = new Guid("d6c02d4b-6833-45b4-971a-05a4b04bab91");
  static Guid MFT_CATEGORY_AUDIO_ENCODER = new Guid("91c64bd0-f91e-4d8c-9276-db248279d975");
  static Guid MFT_CATEGORY_AUDIO_DECODER = new Guid("9ea73fb4-ef7a-4559-8d5d-719d8f0426c7");

  // --- COM method tables: slot numbers after IUnknown (0 QueryInterface, 1 AddRef, 2 Release) --
  // IMFAttributes 3..32 (IMFMediaType, IMFSample and IMFActivate start with it).
  const int A_GetUINT32 = 7, A_GetUINT64 = 8, A_GetGUID = 10, A_GetAllocatedString = 13, A_GetBlob = 15, A_SetUINT32 = 21, A_SetUINT64 = 22, A_SetGUID = 24;
  // IMFSample (after IMFAttributes)
  const int S_SetSampleTime = 36, S_SetSampleDuration = 38, S_ConvertToContiguousBuffer = 41, S_AddBuffer = 42;
  // IMFMediaBuffer
  const int B_Lock = 3, B_Unlock = 4, B_SetCurrentLength = 6;
  // IMFSourceReader
  const int R_SetStreamSelection = 4, R_GetNativeMediaType = 5, R_GetCurrentMediaType = 6, R_SetCurrentMediaType = 7, R_ReadSample = 9, R_GetPresentationAttribute = 12;
  // IMFSinkWriter
  const int W_AddStream = 3, W_SetInputMediaType = 4, W_BeginWriting = 5, W_WriteSample = 6, W_Finalize = 11;

  [UnmanagedFunctionPointer(CallingConvention.StdCall)] public delegate int FnSelf(IntPtr self);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)] public delegate int FnGetUINT32(IntPtr self, ref Guid key, out int value);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)] public delegate int FnGetUINT64(IntPtr self, ref Guid key, out long value);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)] public delegate int FnGetGUID(IntPtr self, ref Guid key, out Guid value);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)] public delegate int FnGetAllocatedString(IntPtr self, ref Guid key, out IntPtr value, out int length);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)] public delegate int FnGetBlob(IntPtr self, ref Guid key, byte[] buffer, int size, out int written);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)] public delegate int FnSetUINT32(IntPtr self, ref Guid key, int value);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)] public delegate int FnSetUINT64(IntPtr self, ref Guid key, long value);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)] public delegate int FnSetGUID(IntPtr self, ref Guid key, ref Guid value);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)] public delegate int FnLong(IntPtr self, long value);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)] public delegate int FnInt(IntPtr self, int value);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)] public delegate int FnPtr(IntPtr self, IntPtr value);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)] public delegate int FnOutPtr(IntPtr self, out IntPtr value);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)] public delegate int FnLock(IntPtr self, out IntPtr data, out int max, out int current);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)] public delegate int FnSelect(IntPtr self, int stream, int selected);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)] public delegate int FnNativeType(IntPtr self, int stream, int index, out IntPtr type);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)] public delegate int FnCurrentType(IntPtr self, int stream, out IntPtr type);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)] public delegate int FnSetType(IntPtr self, int stream, IntPtr reserved, IntPtr type);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)] public delegate int FnReadSample(IntPtr self, int stream, int control, out int actual, out int flags, out long timestamp, out IntPtr sample);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)] public delegate int FnPresentation(IntPtr self, int stream, ref Guid key, IntPtr propvariant);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)] public delegate int FnAddStream(IntPtr self, IntPtr type, out int index);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)] public delegate int FnSetInput(IntPtr self, int stream, IntPtr type, IntPtr encodingParameters);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)] public delegate int FnWriteSample(IntPtr self, int stream, IntPtr sample);

  static T M<T>(IntPtr obj, int slot) where T : class {
    IntPtr table = Marshal.ReadIntPtr(obj);
    IntPtr fn = Marshal.ReadIntPtr(table, slot * IntPtr.Size);
    return (T)(object)Marshal.GetDelegateForFunctionPointer(fn, typeof(T));
  }
  static void Release(IntPtr obj) { if (obj != IntPtr.Zero) M<FnSelf>(obj, 2)(obj); }
  static void Check(int hr, string what) { if (hr < 0) throw new Exception(string.Format("{0}: 0x{1:x8}", what, hr)); }

  static Guid GetGuid(IntPtr attrs, Guid key) { Guid v; return M<FnGetGUID>(attrs, A_GetGUID)(attrs, ref key, out v) < 0 ? Guid.Empty : v; }
  static int GetInt(IntPtr attrs, Guid key, int fallback) { int v; return M<FnGetUINT32>(attrs, A_GetUINT32)(attrs, ref key, out v) < 0 ? fallback : v; }
  static long GetLong(IntPtr attrs, Guid key) { long v; return M<FnGetUINT64>(attrs, A_GetUINT64)(attrs, ref key, out v) < 0 ? 0 : v; }
  static void SetGuid(IntPtr attrs, Guid key, Guid value) { Check(M<FnSetGUID>(attrs, A_SetGUID)(attrs, ref key, ref value), "SetGUID"); }
  static void SetInt(IntPtr attrs, Guid key, int value) { Check(M<FnSetUINT32>(attrs, A_SetUINT32)(attrs, ref key, value), "SetUINT32"); }
  static void SetLong(IntPtr attrs, Guid key, long value) { Check(M<FnSetUINT64>(attrs, A_SetUINT64)(attrs, ref key, value), "SetUINT64"); }

  /// FourCC-style name of a media subtype ("avc1", "aac ", ...), as av-check.swift reports codecs.
  static string CodecName(Guid sub) {
    if (sub == MFVideoFormat_H264) return "avc1";
    if (sub == MFAudioFormat_AAC) return "aac ";
    if (sub == new Guid("4f707573-767a-494d-b478-f29d25dc9037")) return "Opus"; // as the WebM/MP4 source reports Opus (seen on Windows Server 2025)
    byte[] b = sub.ToByteArray();
    string tail = sub.ToString().Substring(8);
    if (tail == "-0000-0010-8000-00aa00389b71") {
      int tag = BitConverter.ToInt32(b, 0);
      if (tag == 0x704f) return "Opus";
      if (tag == 0x0001) return "lpcm";
      if (tag == 0x0003) return "fl32";
      if (tag == 0x0055) return "mp3 ";
      if (tag == 0x6c61) return "alac";
      if (tag == 0xf1ac) return "flac";
      if (b[0] >= 0x20 && b[0] < 0x7f && b[1] >= 0x20 && b[1] < 0x7f && b[2] >= 0x20 && b[2] < 0x7f && b[3] >= 0x20 && b[3] < 0x7f)
        return new string(new char[] { (char)b[0], (char)b[1], (char)b[2], (char)b[3] });
      return string.Format("tag 0x{0:x4}", tag);
    }
    return sub.ToString();
  }

  static bool started;
  static void Start() {
    if (started) return;
    CoInitializeEx(IntPtr.Zero, 0); // RPC_E_CHANGED_MODE is fine: the thread already has COM
    Check(MFStartup(MF_VERSION, 0), "MFStartup");
    started = true;
  }

  static IntPtr OpenReader(string path, int stream) {
    IntPtr reader;
    Check(MFCreateSourceReaderFromURL(path, IntPtr.Zero, out reader), "MFCreateSourceReaderFromURL");
    M<FnSelect>(reader, R_SetStreamSelection)(reader, ALL_STREAMS, 0);
    M<FnSelect>(reader, R_SetStreamSelection)(reader, stream, 1);
    return reader;
  }

  /// Codec of the stream as stored in the file; null when there is no such stream.
  static string NativeCodec(IntPtr reader, int stream) {
    IntPtr type;
    if (M<FnNativeType>(reader, R_GetNativeMediaType)(reader, stream, 0, out type) < 0) return null;
    try { return CodecName(GetGuid(type, MF_MT_SUBTYPE)); } finally { Release(type); }
  }

  static void SetOutput(IntPtr reader, int stream, Guid major, Guid sub) {
    IntPtr type;
    Check(MFCreateMediaType(out type), "MFCreateMediaType");
    try {
      SetGuid(type, MF_MT_MAJOR_TYPE, major);
      SetGuid(type, MF_MT_SUBTYPE, sub);
      Check(M<FnSetType>(reader, R_SetCurrentMediaType)(reader, stream, IntPtr.Zero, type), "SetCurrentMediaType");
    } finally { Release(type); }
  }

  static double DurationSeconds(IntPtr reader) {
    IntPtr pv = Marshal.AllocCoTaskMem(24);
    try {
      for (int i = 0; i < 24; i++) Marshal.WriteByte(pv, i, 0);
      Guid key = MF_PD_DURATION;
      if (M<FnPresentation>(reader, R_GetPresentationAttribute)(reader, MEDIASOURCE, ref key, pv) < 0) return 0;
      return Marshal.ReadInt64(pv, 8) / 1e7; // PROPVARIANT VT_UI8, 100 ns units
    } finally { Marshal.FreeCoTaskMem(pv); }
  }

  /// Calls fn(bytes) for every decoded sample of the selected stream; returns an error or null.
  static string ReadAll(IntPtr reader, int stream, Action<byte[]> fn, Action typeChanged) {
    for (int guard = 0; guard < 200000; guard++) {
      int actual, flags; long ts; IntPtr sample;
      int hr = M<FnReadSample>(reader, R_ReadSample)(reader, stream, 0, out actual, out flags, out ts, out sample);
      if (hr < 0) return string.Format("ReadSample 0x{0:x8}", hr);
      if ((flags & READERF_ERROR) != 0) { Release(sample); return "ReadSample: stream error"; }
      if ((flags & READERF_TYPECHANGED) != 0 && typeChanged != null) typeChanged();
      if (sample != IntPtr.Zero) {
        IntPtr buffer;
        hr = M<FnOutPtr>(sample, S_ConvertToContiguousBuffer)(sample, out buffer);
        if (hr >= 0) {
          IntPtr data; int max, cur;
          if (M<FnLock>(buffer, B_Lock)(buffer, out data, out max, out cur) >= 0) {
            byte[] bytes = new byte[cur];
            Marshal.Copy(data, bytes, 0, cur);
            M<FnSelf>(buffer, B_Unlock)(buffer);
            fn(bytes);
          }
          Release(buffer);
        }
        Release(sample);
      }
      if ((flags & READERF_ENDOFSTREAM) != 0) return null;
    }
    return "too many samples";
  }

  static Dictionary<string, object> DecodeVideo(string path) {
    var r = new Dictionary<string, object>();
    IntPtr reader = IntPtr.Zero;
    try {
      reader = OpenReader(path, FIRST_VIDEO);
      string codec = NativeCodec(reader, FIRST_VIDEO);
      if (codec == null) return null;
      r["codec"] = codec;
      r["duration"] = DurationSeconds(reader);
      SetOutput(reader, FIRST_VIDEO, MFMediaType_Video, MFVideoFormat_NV12);
      int width = 0, height = 0, stride = 0, shownW = 0, shownH = 0;
      Action readType = delegate {
        IntPtr type;
        if (M<FnCurrentType>(reader, R_GetCurrentMediaType)(reader, FIRST_VIDEO, out type) < 0) return;
        long size = GetLong(type, MF_MT_FRAME_SIZE);
        width = (int)(size >> 32); height = (int)(size & 0xffffffff);
        stride = GetInt(type, MF_MT_DEFAULT_STRIDE, width);
        // The decoder's frames are padded to whole macroblocks (1080 -> 1088); the picture is the
        // minimum display aperture (MFVideoArea: two MFOffset, then SIZE cx, cy at byte 8).
        shownW = width; shownH = height;
        byte[] area = new byte[16]; int got; Guid key = MF_MT_MINIMUM_DISPLAY_APERTURE;
        if (M<FnGetBlob>(type, A_GetBlob)(type, ref key, area, 16, out got) >= 0 && got >= 16) {
          shownW = BitConverter.ToInt32(area, 8); shownH = BitConverter.ToInt32(area, 12);
        }
        Release(type);
      };
      readType();
      r["width"] = shownW; r["height"] = shownH; r["decodedWidth"] = width; r["decodedHeight"] = height;
      int frames = 0; double best = 0;
      string err = ReadAll(reader, FIRST_VIDEO, delegate (byte[] nv12) {
        if (frames % 10 == 0) best = Math.Max(best, Spread(nv12, shownW, shownH, Math.Abs(stride)));
        frames++;
      }, readType);
      r["decodedFrames"] = frames; r["spread"] = best;
      if (err != null) r["error"] = err;
    } catch (Exception e) {
      r["decodedFrames"] = 0; r["error"] = e.Message;
    } finally { Release(reader); }
    return r;
  }

  /// Brightness spread of an NV12 frame: 5th to 95th percentile of sampled luma (Y plane), 0..1.
  static double Spread(byte[] nv12, int w, int h, int stride) {
    if (w <= 0 || h <= 0 || stride < w || nv12.Length < stride * h) return 0;
    var l = new List<int>();
    int step = Math.Max(1, Math.Min(w, h) / 48);
    for (int y = 0; y < h; y += step) for (int x = 0; x < w; x += step) l.Add(nv12[y * stride + x]);
    if (l.Count == 0) return 0;
    l.Sort();
    return (l[(int)((l.Count - 1) * 0.95)] - l[(int)((l.Count - 1) * 0.05)]) / 219.0; // video range 16..235
  }

  static Dictionary<string, object> DecodeAudio(string path) {
    var r = new Dictionary<string, object>();
    IntPtr reader = IntPtr.Zero;
    try {
      reader = OpenReader(path, FIRST_AUDIO);
      string codec = NativeCodec(reader, FIRST_AUDIO);
      if (codec == null) return null;
      r["codec"] = codec;
      SetOutput(reader, FIRST_AUDIO, MFMediaType_Audio, MFAudioFormat_Float);
      IntPtr type;
      Check(M<FnCurrentType>(reader, R_GetCurrentMediaType)(reader, FIRST_AUDIO, out type), "GetCurrentMediaType");
      int rate = GetInt(type, MF_MT_AUDIO_SAMPLES_PER_SECOND, 0), channels = GetInt(type, MF_MT_AUDIO_NUM_CHANNELS, 0);
      Release(type);
      r["sampleRate"] = rate; r["channels"] = channels;
      long values = 0; float peak = 0;
      string err = ReadAll(reader, FIRST_AUDIO, delegate (byte[] pcm) {
        for (int i = 0; i + 3 < pcm.Length; i += 4) peak = Math.Max(peak, Math.Abs(BitConverter.ToSingle(pcm, i)));
        values += pcm.Length / 4;
      }, null);
      r["decodedSeconds"] = rate > 0 && channels > 0 ? (double)values / channels / rate : 0.0;
      r["peak"] = (double)peak;
      if (err != null) r["error"] = err;
    } catch (Exception e) {
      r["decodedSeconds"] = 0.0; r["error"] = e.Message;
    } finally { Release(reader); }
    return r;
  }

  /// What Media Foundation finds in a file: { duration, video: {...} | null, audio: {...} | null }.
  public static Hashtable Probe(string path) {
    var report = new Hashtable();
    try { Start(); } catch (Exception e) { report["error"] = "Media Foundation: " + e.Message; return report; }
    var v = DecodeVideo(path);
    var a = DecodeAudio(path);
    report["duration"] = v != null && v.ContainsKey("duration") ? v["duration"] : 0.0;
    report["video"] = v;
    report["audio"] = a;
    return report;
  }

  // --- Inventory --------------------------------------------------------------------------------
  [StructLayout(LayoutKind.Sequential)] struct TypeInfo { public Guid major; public Guid sub; }

  /// Friendly names of the registered transforms for one category and type (MFTEnumEx).
  static List<string> Transforms(Guid category, int flags, Guid major, Guid sub, bool input) {
    var names = new List<string>();
    IntPtr info = Marshal.AllocCoTaskMem(32);
    try {
      Marshal.StructureToPtr(new TypeInfo { major = major, sub = sub }, info, false);
      IntPtr list; int count;
      Check(MFTEnumEx(category, flags, input ? info : IntPtr.Zero, input ? IntPtr.Zero : info, out list, out count), "MFTEnumEx");
      for (int i = 0; i < count; i++) {
        IntPtr act = Marshal.ReadIntPtr(list, i * IntPtr.Size);
        IntPtr str; int len; Guid key = MFT_FRIENDLY_NAME;
        names.Add(M<FnGetAllocatedString>(act, A_GetAllocatedString)(act, ref key, out str, out len) >= 0 ? Marshal.PtrToStringUni(str, len) : "(adsiz)");
        if (str != IntPtr.Zero) CoTaskMemFree(str);
        Release(act);
      }
      if (list != IntPtr.Zero) CoTaskMemFree(list);
    } finally { Marshal.FreeCoTaskMem(info); }
    return names;
  }

  // MFT_ENUM_FLAG_*: SYNCMFT 1, ASYNCMFT 2, HARDWARE 4, LOCALMFT 0x10, TRANSCODE_ONLY 0x20, SORTANDFILTER 0x40
  const int SOFTWARE = 0x1 | 0x2 | 0x10 | 0x20 | 0x40, HARDWARE = 0x4 | 0x40;

  static Hashtable Both(Guid category, Guid major, Guid sub, bool input) {
    var h = new Hashtable();
    try { h["software"] = Transforms(category, SOFTWARE, major, sub, input); } catch (Exception e) { h["software"] = e.Message; }
    try { h["hardware"] = Transforms(category, HARDWARE, major, sub, input); } catch (Exception e) { h["hardware"] = e.Message; }
    return h;
  }

  /// `frames` frames of W x H NV12 at 30 fps (a moving bar) through the Sink Writer's default
  /// H.264 encoder: no attributes on the writer (so no hardware transforms are asked for), 2 Mbit/s
  /// per 640x360 (scaled by area), progressive, square pixels. Reports the time of the writes.
  static Hashtable EncodeH264(string path, int W, int H, int FPS, int frames) {
    var r = new Hashtable();
    IntPtr writer = IntPtr.Zero, outType = IntPtr.Zero, inType = IntPtr.Zero;
    int bitrate = (int)Math.Min(int.MaxValue, 2000000L * W * H / (640 * 360) * FPS / 30);
    r["input"] = "NV12"; r["output"] = "H.264 (MFVideoFormat_H264) in MP4"; r["width"] = W; r["height"] = H; r["fps"] = FPS; r["frames"] = frames; r["bitrate"] = bitrate;
    r["writerAttributes"] = "none (MFCreateSinkWriterFromURL attributes = NULL)";
    var fill = new System.Diagnostics.Stopwatch(); var total = System.Diagnostics.Stopwatch.StartNew();
    try {
      Check(MFCreateSinkWriterFromURL(path, IntPtr.Zero, IntPtr.Zero, out writer), "MFCreateSinkWriterFromURL");
      Check(MFCreateMediaType(out outType), "MFCreateMediaType");
      SetGuid(outType, MF_MT_MAJOR_TYPE, MFMediaType_Video);
      SetGuid(outType, MF_MT_SUBTYPE, MFVideoFormat_H264);
      SetInt(outType, MF_MT_AVG_BITRATE, bitrate);
      SetInt(outType, MF_MT_INTERLACE_MODE, 2); // progressive
      SetLong(outType, MF_MT_FRAME_SIZE, ((long)W << 32) | (long)(uint)H);
      SetLong(outType, MF_MT_FRAME_RATE, ((long)FPS << 32) | 1L);
      SetLong(outType, MF_MT_PIXEL_ASPECT_RATIO, (1L << 32) | 1);
      int stream;
      Check(M<FnAddStream>(writer, W_AddStream)(writer, outType, out stream), "AddStream (H.264)");
      Check(MFCreateMediaType(out inType), "MFCreateMediaType");
      SetGuid(inType, MF_MT_MAJOR_TYPE, MFMediaType_Video);
      SetGuid(inType, MF_MT_SUBTYPE, MFVideoFormat_NV12);
      SetInt(inType, MF_MT_INTERLACE_MODE, 2);
      SetLong(inType, MF_MT_FRAME_SIZE, ((long)W << 32) | (long)(uint)H);
      SetLong(inType, MF_MT_FRAME_RATE, ((long)FPS << 32) | 1L);
      SetLong(inType, MF_MT_PIXEL_ASPECT_RATIO, (1L << 32) | 1);
      Check(M<FnSetInput>(writer, W_SetInputMediaType)(writer, stream, inType, IntPtr.Zero), "SetInputMediaType (NV12 -> H.264)");
      Check(M<FnSelf>(writer, W_BeginWriting)(writer), "BeginWriting");
      int size = W * H * 3 / 2;
      byte[] frame = new byte[size];
      int barStep = Math.Max(1, (W - 80) / Math.Max(1, frames));
      for (int i = 0; i < frames; i++) {
        fill.Start();
        for (int y = 0; y < H; y++) for (int x = 0; x < W; x++) frame[y * W + x] = (byte)(x >= i * barStep && x < i * barStep + 80 ? 220 : 40 + y * 160 / H);
        fill.Stop();
        for (int j = W * H; j < size; j++) frame[j] = 128;
        IntPtr buf, sample, data; int max, cur;
        Check(MFCreateMemoryBuffer(size, out buf), "MFCreateMemoryBuffer");
        Check(M<FnLock>(buf, B_Lock)(buf, out data, out max, out cur), "Lock");
        Marshal.Copy(frame, 0, data, size);
        M<FnSelf>(buf, B_Unlock)(buf);
        M<FnInt>(buf, B_SetCurrentLength)(buf, size);
        Check(MFCreateSample(out sample), "MFCreateSample");
        M<FnPtr>(sample, S_AddBuffer)(sample, buf);
        M<FnLong>(sample, S_SetSampleTime)(sample, (long)i * 10000000 / FPS);
        M<FnLong>(sample, S_SetSampleDuration)(sample, 10000000L / FPS);
        int hr = M<FnWriteSample>(writer, W_WriteSample)(writer, stream, sample);
        Release(sample); Release(buf);
        Check(hr, "WriteSample");
      }
      Check(M<FnSelf>(writer, W_Finalize)(writer), "Finalize");
      total.Stop();
      double encodeMs = total.Elapsed.TotalMilliseconds - fill.Elapsed.TotalMilliseconds;
      r["encodeMs"] = Math.Round(encodeMs, 1);
      r["framesPerSecond"] = Math.Round(frames / (encodeMs / 1000.0), 1);
      r["ok"] = true;
    } catch (Exception e) {
      r["ok"] = false; r["error"] = e.Message;
    } finally { Release(inType); Release(outType); Release(writer); }
    return r;
  }

  public static Hashtable Inventory(string folder) {
    var r = new Hashtable();
    try { Start(); r["mediaFoundation"] = "ok"; } catch (Exception e) { r["mediaFoundation"] = e.Message; return r; }
    r["h264Encoders"] = Both(MFT_CATEGORY_VIDEO_ENCODER, MFMediaType_Video, MFVideoFormat_H264, false);
    r["h264Decoders"] = Both(MFT_CATEGORY_VIDEO_DECODER, MFMediaType_Video, MFVideoFormat_H264, true);
    r["aacEncoders"] = Both(MFT_CATEGORY_AUDIO_ENCODER, MFMediaType_Audio, MFAudioFormat_AAC, false);
    r["aacDecoders"] = Both(MFT_CATEGORY_AUDIO_DECODER, MFMediaType_Audio, MFAudioFormat_AAC, true);
    // A small one, and the app's export size (1080p30, 2 s).
    var tests = new List<Hashtable>();
    // width, height, fps, frames: a small one, the app's export size (1080p30, 2 s), and 4K60 (1 s).
    foreach (int[] size in new int[][] { new int[] { 640, 360, 30, 30 }, new int[] { 1920, 1080, 30, 60 }, new int[] { 3840, 2160, 60, 60 } }) {
      string file = System.IO.Path.Combine(folder, string.Format("mf-h264-encode-test-{0}x{1}p{2}.mp4", size[0], size[1], size[2]));
      var enc = EncodeH264(file, size[0], size[1], size[2], size[3]);
      if ((bool)enc["ok"]) {
        enc["bytes"] = new System.IO.FileInfo(file).Length;
        enc["decodedBack"] = Probe(file);
      }
      tests.Add(enc);
    }
    r["h264EncodeTest"] = tests[0];
    r["h264EncodeTest1080p30"] = tests[1];
    r["h264EncodeTest4K60"] = tests[2];
    return r;
  }
}
'@

try {
  Add-Type -TypeDefinition $source -Language CSharp
} catch {
  # A compile error is reported in the same one-line form, so callers never parse nothing.
  @{ error = "mf-check derlenemedi: $($_.Exception.Message)" } | ConvertTo-Json -Compress -Depth 3
  exit 3
}

if ($Inventory) {
  if (-not $Out) { $Out = [System.IO.Path]::GetTempPath() }
  New-Item -ItemType Directory -Force -Path $Out | Out-Null
  $r = [ZeyvolaMf]::Inventory((Resolve-Path $Out).Path)
  $os = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion'
  $r['windows'] = [ordered]@{
    productName = $os.ProductName; displayVersion = $os.DisplayVersion; installationType = $os.InstallationType
    build = "$($os.CurrentBuild).$($os.UBR)"; editionId = $os.EditionID
  }
  $r | ConvertTo-Json -Compress -Depth 8
  exit 0
}

if (-not $File) { Write-Error 'Kullanim: mf-check.ps1 -File <video> | -Inventory -Out <klasor>'; exit 2 }
$full = (Resolve-Path -LiteralPath $File).Path
[ZeyvolaMf]::Probe($full) | ConvertTo-Json -Compress -Depth 6
exit 0
