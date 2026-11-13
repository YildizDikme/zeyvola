# Güvenlik / Security

## Desteklenen sürümler / Supported versions
Güvenlik düzeltmeleri yalnızca en son yayımlanan sürüm için yapılır.

*Security fixes are made for the latest published release only.*

## Güvenlik açığı bildirme / Reporting a vulnerability
Güvenlik açıklarını lütfen herkese açık bir Issue olarak **açmayın**. Bunun yerine GitHub'ın özel güvenlik bildirimi yolunu kullanın:

1. Deponun **Security** sekmesini açın.
2. **Report a vulnerability** düğmesine tıklayın.
3. Sorunu, etkilenen sürümü (macOS sürümü ve Zeyvola sürümü) ve yeniden üretme adımlarını yazın.

Bildirim yalnızca geliştiriciye görünür. Sorun doğrulandıktan sonra düzeltme yayımlanır ve bildirim, istenirse adınızla birlikte, sürüm notlarında anılır.

*Please do **not** open a public Issue for security problems. Use GitHub's private vulnerability reporting instead: open the repository's **Security** tab, click **Report a vulnerability**, and describe the problem, the affected versions (macOS and Zeyvola) and the steps to reproduce it. The report is visible only to the maintainer. Once confirmed, a fix is released and the report is credited in the release notes if you wish.*

## Kapsam / Scope
Zeyvola ağ isteği yapmaz ve telemetri göndermez; kayıtlar ve projeler yalnızca bilgisayarınızda kalır. Özellikle şunlarla ilgili bildirimler önemlidir:
- kayıtların, imleç verilerinin ya da projelerin beklenmedik biçimde dışarı çıkması;
- gizleme (blur, piksel, opak) alanlarının dışa aktarılan videoda açığa çıkması;
- tıklama yardımcısının (`native/input-macos`) fare tuşları ve kaydırma dışında veri okuması.

*Zeyvola makes no network requests and sends no telemetry. Reports about recordings, cursor data or projects leaving the computer, privacy masks being revealed in exported video, or the click helper reading anything beyond mouse buttons and scrolling are especially important.*
