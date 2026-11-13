# Değişiklik günlüğü / Changelog

Bu dosya Zeyvola'nın sürümlerindeki önemli değişiklikleri listeler.

*This file lists notable changes in each Zeyvola release.*

## 0.1.0 — yayımlanmadı / unreleased

İlk sürüm. macOS (Apple Silicon ve Intel) ve Windows 10/11 x64 (Beta). Windows sürümü GitHub'ın Windows makinesinde otomatik testlerden geçti; gerçek bir Windows 10/11 bilgisayarda henüz denenmedi.

*First release. macOS (Apple silicon and Intel) and Windows 10/11 x64 (beta). The Windows version: it passed the automated tests on GitHub's Windows machine; it has not been tried on a real Windows 10/11 computer yet.*

### Özellikler / Features
- Ekran, kamera, mikrofon ve sistem sesi kaydı (ayrı izler; macOS kayıt yardımcısı, ScreenCaptureKit). *Screen, camera, microphone and system audio recording on separate tracks (macOS recording helper, ScreenCaptureKit).*
- Tıklamalardan ve imleç hareketinden otomatik zoom önerileri; elle düzenlenebilir. *Automatic zoom suggestions from clicks and pointer movement, editable by hand.*
- Zaman çizelgesi: kesme, bölme, video ekleme (MP4, MOV, WebM). *Timeline: trim, split, insert video (MP4, MOV, WebM).*
- Gizleme: buzlu cam, bulanıklık ya da piksel efekti; dışa aktarılan her kare bu efektlerden geçer. *Privacy masks: frosted glass, blur or pixelate; every exported frame goes through them.*
- Büyüteç: seçilen aralıklarda imleci takip eden mercek. *Magnifier: a lens that follows the pointer in selected ranges.*
- Temalar, arka plan, kamera yerleşimi; 16:9, 9:16, 1:1, 4:5 formatları. *Themes, backgrounds, camera layout; 16:9, 9:16, 1:1 and 4:5 formats.*
- Dışa aktarma: MP4 (H.264 + AAC, işletim sisteminin kodlayıcısıyla; QuickTime ve Windows'un oynatıcısı açar) ve WebM (VP9 + Opus), 1080p veya 4K, 30 veya 60 fps. *Export: MP4 (H.264 + AAC through the operating system's encoders; opens in QuickTime and Windows' player) and WebM (VP9 + Opus), 1080p or 4K, 30 or 60 fps.*
- Dışa aktarılan dosyanın klasörü ve adı sistemin kaydetme penceresinden seçilir; son seçilen klasör hatırlanır. İptal ya da hata yarım dosya bırakmaz. *Choose the export's folder and name in the system save dialog; the last folder is remembered. Cancelling or a failure leaves no partial file.*
- Dışa aktarma sürerken bilgisayar uyumaz; pencere ya da uygulama kapanırsa dışa aktarma iptal edilir. *The computer stays awake during an export; closing the window or the app cancels it.*
- Türkçe ve İngilizce arayüz. *Turkish and English interface.*

### Düzeltmeler / Fixes
- Önceki geliştirme sürümlerinde "MP4" seçeneği VP9 + Opus yazıyordu; QuickTime ve Windows'un oynatıcısı bu dosyaları yalnızca ses olarak açıyordu. MP4 artık H.264 + AAC. *Earlier development builds wrote VP9 + Opus as "MP4", which QuickTime and Windows' player opened as sound only. MP4 is now H.264 + AAC.*

### Bilinen sınırlar / Known limits
- Kayıt ekranında "Yedek" (tarayıcı) yöntemi seçilirse sistem sesi kaydedilmez ve imleç videoya gömülür. *With the "Fallback" (browser) recording method, system audio is not recorded and the cursor is part of the video.*
- MP4 dışa aktarma için ekran kartının H.264 kodlayıcısı yoksa: Windows'ta Windows'un yazılım kodlayıcısı kullanılır (daha yavaş); o da yoksa video WebM olarak kaydedilir ve bu açıkça söylenir. *If the graphics card has no H.264 encoder: on Windows, Windows' software encoder is used (slower); otherwise the video is saved as WebM and the app says so.*
