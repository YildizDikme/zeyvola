# Zeyvola ses yardımcısı (macOS)

Bilgisayardan eklenen bir videonun sesini (ör. telefon ve kamera videolarındaki AAC) macOS'un kendi çözücüsüyle (AVFoundation) çözüp Opus olarak yeniden yazan küçük bir program. Uygulamanın medya kitaplığı (Electron'un codec'siz FFmpeg derlemesi) AAC çözemediği için gereklidir.

- **Ne yapar:** `zeyvola-audio --extract-audio <video> <ses.m4a>`; tek satırlık JSON yanıt verir. Opus, MP3, FLAC ve PCM sesi dokunmadan bırakır (uygulama bunları kendisi oynatır).
- **Ne yapmaz:** Video çözmez veya kodlamaz, ekran kaydetmez, ağa bağlanmaz.
- **Bağımlılıklar:** Yalnızca Foundation, AVFoundation, AVFAudio ve CoreMedia. Ses çıkarma kodu kayıt yardımcısıyla ortaktır (`../recorder-macos/Sources/ZeyvolaRecorder/AudioExtract.swift`).

```bash
pnpm native:audio   # → native/audio-macos/bin/zeyvola-audio
```

Uygulama paketinde `Contents/Resources/bin/zeyvola-audio` olarak bulunur; `tools/codec-audit.mjs` bağlı çerçeveleri ve video codec izlerini denetler.
