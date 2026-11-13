# Gerçek kayıt testi (macOS)

Gerçek Swift kayıt yardımcısıyla bu Mac üzerinde kayıt yapar ve sonuçları ölçer. Birim testlerinden farklı olarak gerçek ekran, kamera, mikrofon ve sistem sesi kullanılır.

```bash
node tests/real-capture/run-real-capture.mjs --permissions        # yalnızca macOS izin pencereleri
node tests/real-capture/run-real-capture.mjs                      # bütün senaryolar
node tests/real-capture/run-real-capture.mjs --only pencere-30fps --results sonuc.json
```

## Nasıl çalışır

1. `harness/` geliştirme paketi **"Zeyvola (geliştirme)"** içinde başlatılır (`open -n -W`). macOS izinleri böylece onu başlatan uygulamaya (ör. terminal) değil, Zeyvola'ya atfedilir.
2. Harness, sentetik bir **test deseni** penceresi açar (`pattern/index.html`): sürekli hareket eden bir kare, 2 saniyede bir beyaz yanıp sönen eşitleme karesi ve aynı anda 1 kHz bip, numaralı tıklama hedefleri. Desende kişisel veri yoktur.
3. Yardımcı, uygulamanın kendi `HelperClient` sınıfıyla sürülür (`apps/desktop/src/main/capture/helper-client.ts`).
4. `media-probe.swift` (AVFoundation) dosyaları ölçer: kare sayısı ve aralıkları, flaşların göründüğü anlar, tonun başladığı anlar. Araç, `make-fixture.swift` ile üretilen bilinen dosyalarla doğrulandı: 1,000 s ve 3,000 s'deki flaşlar ve tonlar tam bu anlarda bulundu.
5. `analyze.ts`, ölçümleri imleç günlüğü ve desen günlüğüyle karşılaştırır, otomatik zoom motorunu gerçek tıklamalarla çalıştırır.
6. `chromium-probe.mjs`, aynı işaretleri uygulamanın gördüğü gibi ölçer: Chromium'da, dağıtım paketlerindeki codec'siz FFmpeg ile (`decodeAudioData` ve `<video>`). Kalibrasyon: `make-fixture` çıktısı (`fixture-opus.m4a` kayıt yardımcısıyla aynı biçimde yazılır).

```bash
node tests/real-capture/chromium-probe.mjs sonuc.json <klasör>/mic.m4a <klasör>/system.m4a "<klasör>/screen.mp4:0.89,0.05,0.08,0.12"
```

Bir videoda birden çok bölge `;` ile verilir (`screen.webm:x,y,w,h;x,y,w,h`); sonuçta ilk bölgenin anları `rises`, hepsininki `regions` altındadır. Tarayıcı yolu kayıtları için bölgeleri `tests/real-capture-web/analyze.mjs --probe-args` üretir: eşitleme karesi ve altı tıklama hedefi.

## Senaryolar

| Ad | Ne ölçer |
|---|---|
| `bolge-60fps-tum-kaynaklar` | Ekran bölgesi 60 fps, kamera, mikrofon, sistem sesi, duraklatma, işaretler, tıklamalar (6 hedef) |
| `sistem-sesi-zeyvola-haric` | Varsayılan ayarda Zeyvola'nın kendi sesinin sistem sesine girmediği |
| `pencere-30fps` | Tek pencere kaydı |
| `uzun-kayit` | 3 dakika: zaman kayması, CPU ve bellek |
| `esitlik-opus` | Pencere kaydı (60 fps) + sistem sesi + mikrofon, kamera yok, 90 sn (`--sync-seconds`): Opus ses dosyalarıyla görüntü-ses eşitliği. Mikrofon ölçümü için bip hoparlörden duyulmalı |
| `cokme-sigkill` | Yardımcı kayıt sırasında (işaret ve duraklatmadan sonra) öldürülünce diskte ne kaldığı ve uygulamanın kurtarma kodunun kaydı gerçek bir projeye eklemesi: kayıp, kaynak hizası, işaretler, ikinci açılışta tekrar eklenmemesi |
| `uygulama-kapandi` | Uygulama kayıt sırasında kapanınca yardımcının dosyaları kendisinin bitirmesi ve kaydın sonraki açılışta projeye eklenmesi |

Kurtarma senaryoları kaydı geçici klasördeki bir proje klasörüne (`kayitlar/projeler/…`) yapar ve uygulamanın açılışta çalıştırdığı kodu (`ProjectStore` + `recoverAbandoned`) aynen çalıştırır. Sonuç `recovery.checks` altında. Kurtarılan klasörde `recording.json` da yazılır; `ZEYVOLA_REAL_RECORDING_DIR=<o klasör> pnpm smoke` kurtarılan kaydı düzenleyicide açıp dışa aktarır.

Tıklama senaryosu, desende sarı çerçeveli hedefe sırayla tıklanmasını bekler (en çok 10 dakika).

## Gizlilik

- Kayıtlar sistemin geçici klasörüne yazılır ve **depoya kopyalanmaz**. Kamera ve mikrofon gerçek görüntü ve ses içerebilir. Depoya yalnızca ölçülen sayılar girer.
- **Bölge kaydı**, o alanda ekranda ne görünüyorsa onu kaydeder. Test sırasında bilgisayar kullanılırsa desenin dışındaki içerik kayda girebilir. Bu yüzden uzun ve çökme senaryoları **pencere kaydı** kullanır (yalnızca test penceresi kaydedilir). Bölge senaryosunu bilgisayar boştayken çalıştırın.
- Analiz kareleri görüntü olarak açmaz; yalnızca belirli bölgelerin parlaklığını ölçer.

## Smoke testine gerçek kayıt vermek

```bash
ZEYVOLA_REAL_RECORDING_DIR=<senaryo klasörü> pnpm smoke
```

Klasördeki `recording.json` ve dosyalar geçici bir projeye kopyalanır. Düzenleyici açılır, gerçek tıklamalardan zoom önerileri kontrol edilir, dinamik kamera hareketi ve gizleme eklenir, MP4 olarak dışa aktarılır. Bu adımda ekran görüntüsü alınmaz.
