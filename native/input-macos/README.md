# Zeyvola tıklama yardımcısı (macOS)

Ekran kaydı sürerken fare tıklamalarını ve kaydırmayı Zeyvola'ya bildiren küçük bir program. Düzenleyici bu bilgiyle otomatik zoom önerir.

- **Ne yapar:** Fare tuşu ve kaydırma olaylarını standart çıktıya JSON satırları olarak yazar (biçim: `Sources/main.swift`).
- **Pencere kaydında (`--window <CGWindowID>`):** Kaydedilen pencerenin sınırlarını (`CGWindowListCopyWindowInfo`, `kCGWindowBounds`) saniyede yaklaşık 30 kez okur, değiştikçe bildirir; uygulama imleci ve tıklamaları pencereye göre yazar. Pencerenin başlığı ve içeriği okunmaz.
- **Ne yapmaz:** Video ya da ses kaydetmez, klavyeyi okumaz, diske yazmaz, ağa bağlanmaz.
- **Bağımlılıklar:** Yalnızca AppKit ve Foundation. Codec içermez; yakalama ve medya çerçevelerine bağlı değildir.
- **İzin:** Fare olaylarını izlemek ve pencere sınırlarını okumak ek bir macOS izni gerektirmez.

```bash
pnpm native:input   # → native/input-macos/bin/zeyvola-input
```

Uygulama paketinde `Contents/Resources/bin/zeyvola-input` olarak bulunur. `tools/codec-audit.mjs`, bu dosyanın yalnızca izin verilen çerçevelere bağlı olduğunu ve codec içermediğini denetler.
