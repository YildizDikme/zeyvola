# Lisans kayıtları ve bildirimler

| Dosya | Ne | Nasıl güncellenir |
|---|---|---|
| `inventory.md` | Kurulu her npm paketi: sürüm, lisans, sınıf | `node tools/license-inventory.mjs` |
| `../THIRD_PARTY_NOTICES.md` | Uygulamayla **dağıtılan** bileşenlerin tam lisans metinleri; Electron/Chromium; codec tablosu | `node tools/third-party-notices.mjs --write` |
| `../../tools/codec-notes.json` | Codec bileşenlerinin açık kaynak lisansı ve patent durumu (ayrı ayrı, TR/EN) | Elle |

## Dağıtılan bileşenler nasıl bulunur
- Liste elle tutulmaz. `apps/desktop` paketinin üretim bağımlılık ağacından çıkarılır. Çalışma alanı paketleri (`@zeyvola/*`) bizim kodumuz olduğundan listelenmez, ama onların bağımlılıkları da taranır.
- Electron çalışma ortamı ayrıca eklenir.
- Derleme sırasında kaynak haritaları da taranır. Pakete giren her npm paketinin bildirimlerde bulunması gerekir; yoksa derleme durur.
- Lisans metinleri kurulu paketlerden okunur. pnpm her paketi `pnpm-lock.yaml` içindeki bütünlük özetiyle doğrular; bu yüzden metinler, yazarların o sürüm için yayımladığı dosyalardır.
- 2026-10-17'de react, zod ve Electron için resmi depolardaki aynı sürümün LICENSE dosyasıyla lisans türü ve telif satırları karşılaştırıldı ve eşleşti.

## Pakete nasıl girer
`pnpm --filter @zeyvola/desktop build` komutunun son adımı `scripts/build-licenses.mjs` şunları `apps/desktop/dist/licenses/` klasörüne yazar:
- `THIRD_PARTY_NOTICES.md`
- `third-party.json` (Ayarlar → Lisanslar ekranının verisi)
- `electron-LICENSE.txt`
- `LICENSES.chromium.html`

Paketleyici (`apps/desktop/scripts/package.mjs`) bu klasörü paketteki uygulamaya kopyalar ve paketin platformuna göre yeniden üretir (aşağıda "Dağıtım paketleri").

## Otomatik kontroller
`apps/desktop/src/shared/licenses.test.ts` dosyası `pnpm test` ile çalışır. Şu durumlarda başarısız olur:
- dağıtılan paket listesi değişirse;
- bir LICENSE metni eksikse ya da lisans politikada yoksa (yalnızca MIT, ISC, BSD-2/3, Apache-2.0, Zlib, 0BSD);
- `THIRD_PARTY_NOTICES.md` güncel değilse;
- kurulu bir paket envanterde yoksa (yeni bağımlılık);
- Chromium bildiriminde FFmpeg, OpenH264, libvpx ve Opus girişleri bulunamazsa;
- bir codec'in patent durumu "çözüldü" gibi gösterilirse.

Derleme adımı ayrıca kaynak haritalarını tarar. Smoke testi de uygulama içi verinin geldiğini ve ekranın görüntülendiğini doğrular.

## Yeni bağımlılık eklerken
1. Lisansı, kullanılacak sürümün LICENSE dosyasından ve resmi kaynaktan doğrulayın.
2. `node tools/license-inventory.mjs` ve `node tools/third-party-notices.mjs --write` komutlarını çalıştırın; farkı gözden geçirin.
3. `pnpm test` ve `pnpm smoke` çalıştırın.

## Dağıtım paketleri (2026-10-17)
`pnpm package -- --profile mp4|webm [--platform darwin|win32] [--arch arm64|x64]` geçici yerel paket üretir (`apps/desktop/out/`, git dışı). Paketleyici bağımlılık eklemez; Electron'un resmi zip'lerini SHA-256 doğrulamalı kullanır (`tools/electron-artifacts.mjs`).
- **Her pakette:** `Resources/licenses/` altında `THIRD_PARTY_NOTICES.md`, `third-party.json`, `electron-LICENSE.txt`, **o platformun** `LICENSES.chromium.html` dosyası (macOS ve Windows dosyaları farklıdır), `FFMPEG-LGPL.md`, `DISTRIBUTION.json`; paket kökünde Electron'un `LICENSE` ve `LICENSES.chromium.html` dosyaları; Lisanslar ekranı için `app/dist/licenses/`.
- **FFmpeg:** iki dağıtımda da Electron'un resmi tescilli codec'siz `ffmpeg-v<sürüm>` derlemesi (H.264/AAC çözücüsü yok). Dinamik bağlı ayrı dosya; LGPL-2.1 metni Chromium bildiriminin "ffmpeg" girişinde.
- **Codec tablosu** (`tools/codec-notes.json`) dağıtıma göre süzülür (`profiles` alanı); `docs/THIRD_PARTY_NOTICES.md` bütün satırları gösterir.
- **Denetim:** `pnpm codec-audit -- <paket> --profile mp4|webm [--probe] [--release]` (`tools/codec-audit.mjs`). Eksik lisans dosyası, yanlış platformun Chromium bildirimi, ikilide bulunup bildirimde olmayan codec kitaplığı, codec'li FFmpeg, VP8 dağıtımında H.264/AAC kodu, A dışında kayıt yardımcısı, A ve B'de MP4'ün AAC yolunun eksikliği, `third-party.json` ile dağıtılan paketlerin uyuşmaması → SORUNLU. `--release` ayrıca Zeyvola'nın lisansı yoksa durur.

## Electron'un Chromium bildiriminde olmayan bileşenler (2026-10-17)
Paketteki her ikili dosya (Mach-O / PE) bir bildirimle eşleştirilir (`tools/codec-audit.mjs`, `BINARY_NOTICES`); eşleşmeyen ya da bildirimi pakette olmayan ikili denetimi durdurur. Bu tarama Electron'un `LICENSES.chromium.html` dosyasında olmayan bileşenleri buldu:
- **macOS:** Mantle ve ReactiveObjC (Electron Framework bunlara bağlı, çıkarılamaz). MIT metinleri `tools/notices-supplement/` içinde, resmi depolardan değiştirilmeden alındı; `THIRD_PARTY_NOTICES.md` bölüm 2b ve Lisanslar ekranında görünür.
- **Windows:** `d3dcompiler_47.dll` (Microsoft, Windows SDK dağıtılabilir kodu; WebGL için gerekli, Microsoft'a göre sistem bileşeni değil) bildirimi eklendi; lisans metni Windows SDK'da, hukuki doğrulama gerekli. `dxil.dll` (Microsoft DXC lisansı: son kullanıcıya Microsoft'u koruyan koşullar ve tazmin yükümlülüğü) ile `dxcompiler.dll` yalnızca WebGPU için; Zeyvola WebGL2 kullandığından paketleyici bunları çıkarır (Windows'ta test edilmedi).
Yeni bir Electron sürümünde tarama yeniden çalıştırılır; yeni bir ikili çıkarsa önce bildirimi eklenir.

## FFmpeg kaynak paketi
`node tools/ffmpeg-source.mjs` → `apps/desktop/out/release-sources/zeyvola-ffmpeg-lgpl-source-electron-<sürüm>.tar.gz` ve kayıt `docs/licenses/ffmpeg-source.json`. İçerik: Chromium'un sabitlediği `chromium/third_party/ffmpeg` revizyonunun arşivi (sürüm başlıkları paketteki ikiliyle aynı kimliği taşır), Electron'un yaması ve derleme ayarları. Sunucu arşivi her indirmede yeniden üretir; içeriği git ağaç kimliği, yayımlanacak dosyayı SHA-256 tanımlar. Paketlerdeki `FFMPEG-LGPL.md` bu dosyayı SHA-256 ile anar; `codec-audit --release` dosya yoksa ya da farklıysa durur. **Her GitHub sürümüne bu dosya eklenmelidir.**

## Kaynak kodu ve bildirim yükümlülükleri
| Bileşen | Yükümlülük | Durum |
|---|---|---|
| MIT/ISC/BSD/Apache npm paketleri | Lisans metni ve telif satırı dağıtımla birlikte | Yerinde (THIRD_PARTY_NOTICES, Lisanslar ekranı) |
| Electron (MIT) ve Chromium bileşenleri | `LICENSE` ve `LICENSES.chromium.html` her pakette | Yerinde, denetleniyor |
| FFmpeg (LGPL-2.1+) | Belirgin bildirim + lisans metni (§6); kitaplığın karşılık gelen kaynağı dağıtımla aynı yerden (§4, §6 d); değiştirme ve hata ayıklama için tersine mühendislik yasaklanamaz (§6); FFmpeg'in önerisi: indirme sayfasında ve "hakkında" penceresinde atıf | Bildirim, lisans metni ve kaynak paketi hazır (revizyon 2b68d2babae7); sürüm sayfasına eklenmesi ve indirme sayfası atfı yayın adımı |
| Mantle, ReactiveObjC (MIT, macOS) | Lisans metni | Eklendi (bölüm 2b) |
| d3dcompiler_47.dll (Microsoft, Windows) | Windows SDK dağıtılabilir kod koşulları | Bildirim eklendi; koşulların metni ve Zeyvola'ya etkisi hukuki doğrulama bekliyor |
| OpenH264, libvpx, libaom, dav1d, Opus (BSD) | Bildirim | Chromium bildiriminde, denetleniyor |
| macOS sistem çerçeveleri | Dağıtılmaz | — |

## Henüz çözülmeyenler
- Zeyvola'nın kendi lisansı seçilmedi; LICENSE dosyası yok. Öneri: `../lisans/zeyvola-lisans-onerisi.md`.
- Codec patentleri (H.264, AAC, OpenH264) için hukuki görüş gerekiyor; bkz. `../denetim/2026-10-17-dagitim-hazirligi.md` bölüm 6–9. 2026-11-13: kullanıcı MP4'ün H.264 + AAC (işletim sisteminin kodlayıcısıyla) olmasını ve yayımlanan dağıtımın A (`ZEYVOLA_DIST=mp4`, macOS kayıt yardımcısıyla) olmasını, hukuki görüş olmadan, riski üstlenerek seçti; `../denetim/2026-11-13-mp4-h264-karari.md`.
- Windows SDK'nın dağıtılabilir kod koşulları (d3dcompiler_47.dll) resmi metinden doğrulanmadı.

## Yerel macOS kayıt yardımcısı (2026-10-17)
Ses AAC değil Opus olarak yazılır (macOS'un kodlayıcısı); içe aktarılan videoların AAC sesi `--extract-audio` ile macOS'ta çözülüp Opus'a çevrilir. `native/recorder-macos` yalnızca Swift standart kitaplığını ve macOS ile birlikte gelen Apple sistem çerçevelerini kullanır (ScreenCaptureKit, AVFoundation, Core Media, Core Video, Core Graphics, AppKit). Üçüncü taraf paket, kaynak kodu veya ikili dosya yoktur; envantere eklenecek bileşen yoktur. Sistem çerçeveleri uygulamayla birlikte dağıtılmaz, kullanıcının macOS'unda zaten bulunur. H.264 ve AAC kodlaması macOS'un kendi kodlayıcılarıyla yapılır. Bu kodlayıcıların patent ve lisans durumu Apple'ın macOS lisans koşullarına bağlıdır ve hukuken doğrulanmadı.
