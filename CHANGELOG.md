# Değişiklik günlüğü / Changelog

Bu dosya Zeyvola'nın sürümlerindeki önemli değişiklikleri listeler.

*This file lists notable changes in each Zeyvola release.*

## 0.1.0 — yayımlanmadı / unreleased

İlk sürüm. Yalnızca macOS (Apple Silicon).

*First release. macOS (Apple Silicon) only.*

### Özellikler / Features
- Ekran, kamera ve mikrofon kaydı (ayrı izler). *Screen, camera and microphone recording on separate tracks.*
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
- Sistem sesi kaydedilmez (mikrofon kaydedilir). *System audio is not recorded (the microphone is).*
- İmleç videoya gömülü kaydedilir. *The cursor is part of the video.*
- MP4 dışa aktarma cihazda H.264 donanım kodlayıcısı ve AAC kodlayıcısı ister; yoksa WebM kullanılır. *MP4 export needs a hardware H.264 encoder and an AAC encoder on the device; without them, use WebM.*
