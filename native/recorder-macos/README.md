# Zeyvola macOS kayıt yardımcısı (`zeyvola-recorder`)

Zeyvola uygulamasının macOS'ta ekranı, kamerayı, mikrofonu, sistem sesini ve imleç/tıklama olaylarını **ayrı dosyalara** kaydeden küçük, pencere açmayan yardımcı programı. Yalnızca Apple'ın sistem çerçevelerini kullanır (ScreenCaptureKit, AVFoundation, Core Media, Core Video, AppKit); üçüncü taraf kod veya paket yoktur.

## Derleme

```bash
pnpm native:mac
```

- Command Line Tools yeterlidir (Xcode gerekmez). `swiftc` doğrudan çağrılır; SwiftPM kullanılmaz. Bu makinedeki Command Line Tools'ta SwiftPM'nin manifest kitaplığı derleyiciyle uyuşmadığı için `Package.swift` bağlanamıyordu; `Package.swift` yalnızca Xcode ile açmak isteyenler için duruyor.
- Çıktı: `bin/zeyvola-recorder`, arm64 + x86_64 evrensel ikili, en düşük macOS 13.
- İmza: geçici (ad hoc), sertleştirilmiş çalışma zamanı ile. `entitlements.plist` yalnızca kamera ve mikrofon yetkilerini bildirir (sertleştirilmiş çalışma zamanı bunlar olmadan kamera ve mikrofonu engeller). Dağıtım için Developer ID imzası ve noterleme henüz yapılmadı.
- `Info.plist` ikiliye gömülür (`__TEXT,__info_plist`): kimlik `com.zeyvola.recorder` ve kullanım açıklamaları.

Öz test (yakalama yapmaz, izin istemez; oturum günlüğünü ve dosya ölçümünü kendi geçici klasöründe sınar):

```bash
native/recorder-macos/bin/zeyvola-recorder --self-test
```

Bir kayıt klasöründeki dosyaların oynatılabilir uzunluğu (çökme kurtarması için; yakalama yapmaz, izin istemez):

```bash
native/recorder-macos/bin/zeyvola-recorder --probe-files <kayıt klasörü>
```

## İzinler

macOS izinleri **sorumlu uygulamaya**, yani yardımcıyı başlatan Zeyvola uygulamasına bağlar. İzin pencereleri bu yüzden "Zeyvola" adıyla çıkar; yardımcı terminalden çalıştırılırsa izinler terminale atfedilir. Gerçek kayıt testleri bu nedenle geliştirme paketi "Zeyvola (geliştirme)" içinden çalışır (`tests/real-capture`).

- Ekran ve sistem sesi: ScreenCaptureKit. İlk kullanımda macOS kendi penceresini gösterir, kullanıcı Sistem Ayarları › Gizlilik ve Güvenlik › Ekran ve Sistem Sesi Kaydı bölümünden izin verir, ardından Zeyvola yeniden başlatılır.
- Kamera ve mikrofon: `AVCaptureDevice.requestAccess`, yani macOS'un normal izin penceresi.
- İmleç ve tıklamalar: `NSEvent.mouseLocation`, `NSEvent.pressedMouseButtons` ve yalnızca dinleyen genel olay izleyicisi (fare düğmeleri ve kaydırma). **Klavye hiç okunmaz.** Ek izin gerekmez.
- `request-access` komutu, hiçbir şey yakalamadan yalnızca bu sistem pencerelerini açar.

## Protokol

Yardımcı stdin'den satır başına bir JSON komut okur ve stdout'a satır başına bir JSON ileti yazar. TypeScript tarafı: `apps/desktop/src/main/capture/helper-client.ts`.

| Uygulama → yardımcı | Anlamı |
|---|---|
| `prepare {outDir, display \| window, region?, bounds?, fps, quality, camera?, mic?, systemAudio, excludeOwnAudio?, excludePid, meta?}` | Kaynakları açar ve ısıtır (geri sayım sırasında). Kayıt başlamaz. `meta`, uygulamanın kayıt tanımıdır (kayıt kimliği, arka uç, hedef); yardımcı onu değiştirmeden `session.jsonl`'e yazar. |
| `go` | Ortak saati başlatır; her kaynak kendi dosyasına yazmaya başlar. |
| `start` | `prepare` + `go`. |
| `pause` / `resume` / `mark` | Duraklatma (süre kesilir), devam, işaret. |
| `stop` | Dosyaları kapatır, `stopped` gönderir. |
| `cancel` | Hiçbir şey saklamadan kapatır. |
| `request-access {screen?, camera?, mic?}` | Yalnızca sistem izin pencereleri. |

Yardımcının gönderdikleri: `hello`, `ready`, `started`, `status` (0,5 sn'de bir; mikrofon seviyesi, düşen kare), `interrupted` (macOS akışı durdurdu), `stopped`, `cancelled`, `access`, `error {code, message, fatal}`.

Uygulama kapanırsa (stdin kapanır) süren kayıt bitirilip dosyalar kapatılır, sonra yardımcı çıkar.

## Dosyalar

| Dosya | İçerik |
|---|---|
| `screen.mp4` | Ekran, imleç **çizilmeden** (H.264, değişken kare hızı). Zeyvola'nın kendi pencereleri ekran kaydına girmez. |
| `camera.mp4` | Kamera, ekrandan ayrı (H.264; "standart" 720p, "yüksek/en yüksek" kamera destekliyorsa 1080p). |
| `mic.m4a` | Mikrofon, mono 48 kHz **Opus** (MP4 kapsayıcısında, macOS'un kendi kodlayıcısıyla). Opus yazamayan bir macOS'ta 16 bit PCM. |
| `system.m4a` | Sistem sesi, stereo 48 kHz **Opus** (aynı kural). Zeyvola'nın kendi sesi varsayılan olarak dışarıda kalır. |
| `cursor.jsonl` | İmleç konumu (120 Hz yoklama; değişmeyen konumlar 2 Hz'de bir), düğme basma/bırakma, kaydırma, işaretler. Koordinatlar kaydedilen alana göre 0..1. |
| `session.jsonl` | Çökme kurtarması için oturum günlüğü (aşağıda). |

Her dosyanın ilk örneği ortak oturum saatine göre damgalanır (`startOffsetMs`); projede kaynaklar bu sayede birbirine hizalanır ve **ayrı ayrı düzenlenebilir**. Ses AAC değil Opus: AAC çözücüsü içermeyen Electron derlemesi bu dosyaları da çözebilir. MP4/M4A dosyaları 2 saniyelik parçalar hâlinde yazılır; yardımcı aniden kapanırsa son parçaya kadar olan kısım okunabilir kalır.

## Çökme sonrası kurtarma

Yardımcı kayıt boyunca kayıt klasörüne `session.jsonl` yazar. Satır başına bir JSON nesnesi; **her satır yazıldıktan hemen sonra diske senkronlanır** (`FileHandle.synchronize()`), satırlar çağrı dönmeden diske ulaşır.

| Satır | Ne zaman |
|---|---|
| `{"e":"session","v":1,"startedAtMs","pid","helper","version","platform","fps","cursor","meta"}` | `go` anında, saat başlamadan önce |
| `{"e":"track","kind","name","mime","startOffsetMs", width/height/fps \| sampleRate/channels}` | Bir dosya ilk örneğini alıp açıldığında (ilk 2 sn'lik parça diske inmeden önce) |
| `{"e":"pause","t","atMs"}` / `{"e":"resume","t","atMs"}` | Duraklatma / devam (`t`: kayıt saatinde tick) |
| `{"e":"mark","t"}` | İşaret |
| `{"e":"end","durationMs"}` | Dosyalar düzgün kapandı (`stop` ya da uygulama kapandı) |
| `{"e":"cancelled"}` | İptal: hiçbir şey saklanmaz |

Uygulama (`apps/desktop/src/main/capture/recovery.ts`):

- Yardımcı kayıt sırasında (veya dosyaları kapatırken) beklenmedik kapanırsa o kaydı hemen kurtarır ve düzenleyicide açar.
- Açılışta, `session.jsonl`'i olup projede kaydı olmayan `media/rec_…` klasörlerini bulur (uygulamanın kendisi kayıt sırasında kapandıysa yardımcı dosyaları bitirip `end` yazmıştır). İptal edilmiş oturumlara, hâlâ yazan bir yardımcıya ve daha önce incelenip boş bulunan klasörlere (`recovery.json`) dokunmaz.
- Her dosyanın oynatılabilir uzunluğunu `--probe-files` ile okur: AVFoundation izi örnekleri saklandıkları biçimde (çözmeden) okur; çökmede yarım kalan son parça sayılmaz. Kaynaklar günlükteki `startOffsetMs` ile ortak saate yerleşir, kayıt ekran videosunun bittiği yerde biter. Kayıt `appendRecording` ile projeye eklenir; kullanıcıya "Kayıt yarıda kaldı; X sn kurtarıldı" bildirimi gösterilir.
- Dosyalar hiçbir durumda silinmez veya değiştirilmez.

Başka bir platformun kayıt yardımcısı da aynı günlük biçimini ve aynı `--probe-files` çıktısını kullanmalıdır.

## Bilinen sınırlar

- Ekran kapalıyken veya bir sistem onayı yanıt beklerken macOS yakalamayı başlatmayabilir; yardımcı 20 saniye sonra `screen-start-timeout` hatası verir.
- Yardımcı her yeniden derlendiğinde imzası (cdhash) değişir. macOS'un bunu yeni bir onay sebebi sayıp saymadığı doğrulanmadı.
- Windows'ta bu yardımcının karşılığı yok; Windows sürümü tarayıcı kayıt yolunu kullanır.
