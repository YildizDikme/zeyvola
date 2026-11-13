# Zeyvola Windows yardımcısı

Zeyvola'nın Windows'ta kullandığı küçük bir program. Üç işi var:

- **`--input`:** Ekran kaydı sürerken fare tuşlarını ve tekerleği bildirir (otomatik zoom için). Windows'un düşük düzeyli fare kancasını (`WH_MOUSE_LL`) kullanır; olayları yutmaz, diğer uygulamalara aynen geçer. Klavyeyi okumaz, diske yazmaz, ağa bağlanmaz.
  - **`--input --window <HWND>`:** Pencere kaydında ayrıca kaydedilen pencerenin görünen çerçevesini (`DwmGetWindowAttribute`, `DWMWA_EXTENDED_FRAME_BOUNDS`; olmazsa `GetWindowRect`) saniyede yaklaşık 30 kez okur, değiştikçe bildirir. Uygulama imleci ve tıklamaları pencereye göre yazar. Pencereden başka bilgi okunmaz.
- **`--extract-audio <video> <ses.wav>`:** Eklenen bir videonun sesini (ör. AAC) Windows'un kendi Media Foundation çözücüsüyle çözer ve 16 bit PCM WAV yazar. Çözülemeyen ses için hata döner; uygulama kullanıcıyı uyarır.
- **`--encode-mp4 <çıktı.mp4> <genişlik> <yükseklik> <fps> <bit hızı> <ses 0|1>`:** Ekran kartında H.264 kodlayıcısı yoksa MP4 dışa aktarmayı Windows'un kendi Media Foundation kodlayıcılarıyla (yazılım H.264 ve AAC; Sink Writer) yazar. Uygulama stdin'den NV12 kareleri ve 16 bit stereo PCM gönderir. `--encode-probe <dosya.mp4>` aynı kurulumu küçük bir denemeyle sınar. Electron'un OpenH264 kodlayıcısı kullanılmaz.

Çıktı biçimi: `zeyvola-win.c` başındaki açıklama.

## Derleme

```bash
pnpm native:win   # → native/helper-windows/bin/zeyvola-win.exe (x64, imzasız)
```

macOS veya Linux'ta Zig'in C derleyicisiyle (MIT) çapraz derlenir. Programa üçüncü taraf hiçbir şey girmez:

- C çalışma zamanı bağlanmaz (`-nostdlib`; giriş noktası `mainCRTStartup` bizim).
- Üçüncü taraf başlık dosyası kullanılmaz (`-nostdinc`); gereken Windows bildirimleri `win-api.h` içinde, Microsoft'un belgelerine ve Microsoft'un windows-rs bağlamalarına göre bu proje için yazıldı.
- İçe aktarma kitaplıkları derleme sırasında `imports/*.def` dosyalarından üretilir; bu dosyalar yalnızca çağrılan sistem DLL işlevlerini listeler (KERNEL32, USER32, SHELL32, ole32, dwmapi, MFPlat, MFReadWrite). Sink Writer bildirimleri ve GUID'leri, `tests/media-check/mf-check.ps1` dosyasının gerçek bir Windows makinesinde kullandığı değerlerle aynıdır.

`tools/codec-audit.mjs`, paketteki `resources/bin/zeyvola-win.exe` dosyasının yalnızca bu DLL'lere bağlı olduğunu ve kodlayıcı olarak yalnızca `MFCreateSinkWriterFromURL` dışında kodlayıcı, klavye veya ağ işlevi içe aktarmadığını denetler.

**Durum:** Gerçek Windows'ta henüz test edilmedi.
