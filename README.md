# Zeyvola

macOS için ekran kaydı ve video düzenleme uygulaması. Ekran, kamera, mikrofon ve sistem sesi ayrı izlere kaydedilir. Kayıttan sonra zaman çizelgesinde zoom, kamera yerleşimi, gizleme ve tema düzenlenir.

*Screen recording and video editing for macOS. Screen, camera, microphone and system audio are recorded to separate tracks; zoom, camera layout, privacy masks and themes are edited afterwards on a timeline.*

> Sürüm 0.1, ilk genel sürüm. Şimdilik **macOS** (Apple Silicon ve Intel). Windows sürümü **test ediliyor, henüz yayımlanmadı**; gerçek Windows'ta doğrulanana kadar yayımlanmayacak.
> *Version 0.1, the first public release. For now **macOS** only (Apple silicon and Intel). The Windows version is **being tested and not released yet**; it will not be published until it is verified on real Windows.*
>
> Kayıt, macOS kayıt yardımcısıyla (ScreenCaptureKit) yapılır: sistem sesi ayrı bir ize, imleç videodan ayrı kaydedilir. Kayıt ekranında "Yedek" (tarayıcı) yöntemi seçilirse sistem sesi kaydedilmez ve imleç videoya gömülür.
> *Recording uses the macOS recording helper (ScreenCaptureKit): system audio goes to its own track and the cursor is kept out of the video. With the "Fallback" (browser) method on the recording screen, system audio is not recorded and the cursor is part of the video.*

## Özellikler / Features
- Ekran, kamera, mikrofon ve sistem sesi kaydı (ayrı izler)
- Tıklamalardan ve imleç hareketinden otomatik zoom önerileri; elle düzenlenebilir. Tıklamaları küçük bir yardımcı program (`native/input-macos`) bildirir; yalnızca fare tuşlarını ve kaydırmayı görür, klavyeyi okumaz, video ya da ses kaydetmez.
- Zaman çizelgesi: kesme, bölme, video ekleme (MP4, MOV, WebM)
- Gizleme: seçilen alanı buzlu cam, bulanıklık ya da piksel efektiyle kapatma. Dışa aktarılan her kare bu efektlerden geçer.
- Büyüteç: zaman çizelgesinde seçilen aralıklarda imleci takip eden mercek; her aralığın boyutu ve yakınlaştırması ayrı ayarlanır. Gizlenen alanları açığa çıkarmaz.
- Temalar, arka plan, kamera yerleşimi; 16:9, 9:16, 1:1, 4:5 formatları
- Dışa aktarma: **MP4** (H.264 + AAC, işletim sisteminin kodlayıcısıyla) ve **WebM** (VP9 + Opus), 1080p veya 4K, 30 veya 60 fps; kaydedilecek klasörü ve adı siz seçersiniz
- Türkçe ve İngilizce arayüz

## Ekran görüntüleri / Screenshots
Görüntüler uydurma bir örnek projeden (`pnpm docshots`) üretilir; gerçek bir ekran, kişi ya da kamera görüntüsü içermez.

*The pictures come from a made-up sample project (`pnpm docshots`); no real screen, person or camera picture is shown.*

![Düzenleyici: zaman çizelgesinde otomatik zoom önerileri](docs/screenshots/duzenleyici.png)
*Düzenleyici: otomatik zoom önerileri zaman çizelgesinde. · Editor: automatic zoom suggestions on the timeline.*

![Gizleme alanı: telefon numarası buzlu camla kapatılmış](docs/screenshots/gizleme-alani.png)
*Gizleme: seçilen alan buzlu camla kapatılır. · Privacy: the selected area is covered with frosted glass.*

![Dikey 9:16 format](docs/screenshots/dikey-9x16.png)
*Aynı kayıt dikey (9:16) formatta. · The same recording in vertical (9:16) format.*

![Dışa aktarma penceresi ve gizlilik kontrolü](docs/screenshots/disa-aktarma.png)
*Dışa aktarma: MP4 (H.264 + AAC) ya da WebM (VP9 + Opus) ve gizleme alanlarının sınır kareleri. · Export: MP4 (H.264 + AAC) or WebM (VP9 + Opus) with the edge frames of each privacy area.*

## Gizlilik / Privacy
Kayıtlar, imleç verileri ve projeler yalnızca bilgisayarınızda kalır. Uygulama ağ isteği yapmaz ve telemetri göndermez. Tuş vuruşları kaydedilmez.

*Recordings, cursor data and projects stay on your computer. The app makes no network requests and sends no telemetry.*

## İndirme / Download
Sürümler GitHub **Releases** sayfasında yayımlanır. Bilgisayarınıza uyan dosyayı indirin:

*Releases are published on the GitHub **Releases** page. Download the file for your computer:*

| Bilgisayar / Computer | Dosya / File | Durum / Status |
|---|---|---|
| Apple Silicon Mac (M1, M2, M3, M4 …) | `Zeyvola-<sürüm>-macos-arm64.dmg` (ya da `.zip`) | Yayımlanır / Released |
| Intel işlemcili Mac / Intel Mac | `Zeyvola-<sürüm>-macos-x64.dmg` (ya da `.zip`) | Yayımlanır / Released (aşağıdaki nota bakın / see the note below) |
| Windows 10 / 11 (64 bit, x64) | `Zeyvola-<sürüm>-windows-x64.zip` | **Test ediliyor, henüz yayımlanmadı** / **Being tested, not released yet** |

Her sürümde ayrıca FFmpeg kaynak kodu paketi (`zeyvola-ffmpeg-lgpl-source-electron-<sürüm>.tar.gz`, LGPL-2.1, bkz. *Üçüncü taraf yazılımlar*) ve `SHA256SUMS.txt` bulunur. Uygulamayı kullanmak için bunlara gerek yoktur.

*Each release also has the FFmpeg source package (LGPL-2.1, see* Third-party software*) and `SHA256SUMS.txt`; you do not need them to use the app.*

**Mac'im hangisi? / Which Mac do I have?** Apple menüsü › **Bu Mac Hakkında**. "Çip: Apple M…" yazıyorsa Apple Silicon, "İşlemci: … Intel …" yazıyorsa Intel dosyasını indirin.

*Apple menu › **About This Mac**: "Chip" followed by an Apple chip means Apple silicon; "Processor" followed by an Intel processor means an Intel Mac.*

**Intel Mac notu / Intel Mac note.** Intel paketi bir Apple Silicon Mac'te Rosetta 2 altında uygulamanın kendi testlerinin tamamından geçti; gerçek bir Intel Mac'te henüz denenmedi. Bir sorun görürseniz lütfen **Issues** üzerinden bildirin.

*The Intel package passed all of the app's own tests under Rosetta 2 on an Apple silicon Mac but has not been tried on real Intel hardware yet. If something goes wrong, please report it under **Issues**.*

**`.dmg` mi `.zip` mi? / `.dmg` or `.zip`?** İkisi de aynı uygulamayı içerir. `.dmg` bir disk görüntüsüdür; açınca uygulamayı **Uygulamalar** klasörüne sürüklersiniz. `.zip` aynı uygulamayı lisans dosyalarıyla birlikte bir klasör olarak verir. Emin değilseniz `.dmg`'yi seçin.

*Both contain the same app. The `.dmg` is a disk image you open and drag the app from into **Applications**; the `.zip` gives the same app in a folder together with the license files. If unsure, pick the `.dmg`.*

**İsteğe bağlı: dosyayı doğrulama / Optional: verify the download.** İndirilen dosyanın SHA-256 değerini `SHA256SUMS.txt` içindeki satırla karşılaştırın; aynı değilse dosyayı kullanmayın ve yeniden indirin.

*Compare the file's SHA-256 with its line in `SHA256SUMS.txt`; if they differ, do not use the file and download it again.*

```bash
shasum -a 256 ~/Downloads/Zeyvola-<sürüm>-macos-arm64.dmg      # macOS (Terminal)
```

```powershell
Get-FileHash .\Zeyvola-<sürüm>-windows-x64.zip                  # Windows (PowerShell; varsayılan SHA256)
```

### macOS'ta kurulum / Installing on macOS
1. `.dmg` dosyasını açın ve **Zeyvola**'yı yanındaki **Applications** (Uygulamalar) kısayoluna sürükleyin. (`.zip` indirdiyseniz: zip'i açın, içindeki `Zeyvola.app`'i **Uygulamalar** klasörüne taşıyın.)
2. Zeyvola'yı **Uygulamalar** klasöründen açın.
3. Zeyvola Apple Developer ID ile imzalanmadığı ve noterlenmediği için macOS ilk açılışı engeller:
   - **macOS 15 ve sonrası:** Uygulamayı bir kez açmayı deneyin ve uyarıyı kapatın. Ardından **Sistem Ayarları › Gizlilik ve Güvenlik** bölümüne gidin (aşağı kaydırmanız gerekebilir); **Güvenlik** kısmında Zeyvola için **Yine de Aç**'a tıklayın ve Mac'inizin giriş parolasını girin. Apple'a göre bu düğme, uygulamayı açmayı denedikten sonra yaklaşık bir saat görünür; görünmüyorsa uygulamayı yeniden açmayı deneyin.
   - **macOS 14 ve öncesi:** Uygulamaya sağ tıklayıp (ya da Control tuşuyla tıklayıp) **Aç**'ı seçin, sonra açılan pencerede yeniden **Aç**'a tıklayın.

   Bu adım ilk açılışta gerekir; yeni bir sürümü indirdiğinizde yeniden gerekebilir.
4. Zeyvola macOS 13 (Ventura) ya da sonrasını gerektirir.

*Open the `.dmg` and drag **Zeyvola** onto the **Applications** shortcut next to it (from the `.zip`: move `Zeyvola.app` into **Applications**), then open it from **Applications**. Zeyvola is not signed with an Apple Developer ID or notarized, so macOS blocks the first launch. On macOS 15 and later, try to open it once, close the warning, then go to **System Settings › Privacy & Security** (you may need to scroll), click **Open Anyway** for Zeyvola in the **Security** section and enter your login password; Apple says the button is shown for about an hour after the attempt. On macOS 14 and earlier, right-click (or Control-click) the app, choose **Open**, then **Open** again. This is needed on the first launch and may be needed again after downloading a new version. Zeyvola needs macOS 13 (Ventura) or later.*

### Windows'ta kurulum / Installing on Windows
> Windows sürümü **test ediliyor, henüz yayımlanmadı**. Aşağıdaki adımlar yayımlandığında geçerli olacaktır.
> *The Windows version is **being tested and not released yet**. These steps apply once it is released.*

1. `.zip` dosyasını kalıcı bir klasöre çıkarın (Dosya Gezgini'nde zip'e sağ tıklayıp *Extract All* / tümünü çıkar). Uygulamayı zip'in içinden çalıştırmayın: çalışmak için yanındaki dosyalara ihtiyaç duyar.
2. Çıkan klasörde `Zeyvola\Zeyvola.exe` dosyasını açın. İsterseniz masaüstüne ya da Başlat menüsüne kısayol oluşturabilirsiniz.
3. Zeyvola kod imzası olmadan dağıtıldığı için Microsoft Defender SmartScreen **"Windows kişisel bilgisayarınızı korudu"** uyarısını gösterebilir. **Ek bilgi**'ye, sonra **Yine de çalıştır**'a tıklayın. Kurumsal bilgisayarlarda yönetici politikası bu adımı kapatmış olabilir.
4. **Akıllı Uygulama Denetimi (Smart App Control):** Windows 11'de bu özellik açıksa (**Windows Güvenliği › Uygulama ve tarayıcı denetimi**), Microsoft'a göre imzasız uygulamaları engeller ve tek bir uygulama için istisna tanımlanamaz. Bu durumda Zeyvola hiç açılmayabilir. Özelliği kapatıp kapatmamak sizin kararınızdır; kapatmak bütün bilgisayarın korumasını etkiler.
5. **İlk açılışta Microsoft bileşeni koşulları:** Zeyvola'nın Windows sürümü, görüntü işleme için Microsoft'a ait `d3dcompiler_47.dll` dosyasını içerir. Microsoft bu dosyanın ancak kullanıcı koşullarını kabul ederse dağıtılmasına izin verir; bu yüzden ilk açılışta, herhangi bir pencere açılmadan önce koşullar sorulur. Koşullar yalnızca bu dosya için geçerlidir ve Zeyvola'nın kendi lisansını değiştirmez. **Koşulları oku** tam metni açar (zip'te de `MICROSOFT-D3DCOMPILER-TERMS.txt` olarak bulunur). **Kabul ediyorum** derseniz Zeyvola bunu hatırlar ve bir kez kendiliğinden yeniden başlar; dosya pakette `d3dcompiler_47.dll.terms-pending` adıyla gelir ve ancak kabulden sonra asıl adını alır (bunun için uygulama klasörüne yazma izni gerekir). **Kabul etmiyorum** derseniz Zeyvola kapanır; bir sonraki açılışta koşullar yeniden sorulur.

*Extract the `.zip` to a permanent folder (right-click › Extract All in File Explorer); do not run the app from inside the zip, it needs the files next to it. Open `Zeyvola\Zeyvola.exe`. Zeyvola is distributed without a code signature, so Microsoft Defender SmartScreen may show "Windows protected your PC": click **More info**, then **Run anyway** (company policy may block this). On Windows 11, if Smart App Control is on (Windows Security › App & browser control), Microsoft says it blocks unsigned apps and cannot make an exception for a single app, so Zeyvola may not start at all; turning it off is your decision and affects the whole computer. On first launch, before any window opens, Zeyvola asks you to accept Microsoft's terms for `d3dcompiler_47.dll` (a Microsoft file used for graphics, shipped with the Windows version). They cover only that file and do not change Zeyvola's own license. **Read terms** opens the full text (also `MICROSOFT-D3DCOMPILER-TERMS.txt` in the zip). After **Accept**, Zeyvola remembers it and restarts once; after **Decline**, it quits and asks again next time.*

### İzinler / Permissions
**macOS.** Zeyvola her izni ilk gerektiğinde ister; vermediğiniz izinleri sonradan **Sistem Ayarları › Gizlilik ve Güvenlik** altında açabilirsiniz:
- **Ekran ve Sistem Ses Kaydı** (eski macOS sürümlerinde adı **Ekran Kaydı**): ekranı ve sistem sesini kaydetmek için. macOS bu izni programla isteme yolu sunmaz; ilk kayıtta sorar. İzni açtıktan sonra Zeyvola'yı kapatıp yeniden açın.
- **Kamera** ve **Mikrofon**: kayıtta kamerayı ya da mikrofonu kullandığınızda macOS sorar. İzinlerin durumu Zeyvola'nın **Ayarlar** ekranında da görünür ve oradan istenebilir.
- Tıklama yardımcısı (`zeyvola-input`) yalnızca fare tuşlarını ve kaydırmayı izler; macOS'ta ek bir izin gerektirmez. Klavyeyi okumaz.

Zeyvola Developer ID ile imzalanmadığı için macOS, güncellemeden sonra uygulamayı yeni bir uygulama gibi görebilir ve ekran kaydı iznini yeniden isteyebilir. macOS eski izni tutup kaydı yine de engellerse: **Ekran ve Sistem Ses Kaydı** listesinde Zeyvola satırını seçip "−" ile kaldırın, Zeyvola'yı yeniden açıp izni yeniden verin; gerekirse bilgisayarı yeniden başlatın.

*Zeyvola asks for each permission when first needed; you can turn them on later in **System Settings › Privacy & Security**: **Screen & System Audio Recording** (**Screen Recording** on older macOS versions) for the screen and system audio — macOS asks on the first recording, and you need to quit and reopen Zeyvola after allowing it; **Camera** and **Microphone** when you use them in a recording (their status is also shown, and can be requested, in Zeyvola's **Settings**). The click helper watches only mouse buttons and scrolling, needs no extra permission and does not read the keyboard. Without a Developer ID signature macOS may treat an updated app as new and ask for screen recording again; if it keeps the old entry and still blocks recording, remove the Zeyvola row with "−", reopen Zeyvola, allow it again, and restart the Mac if needed.*

**Windows.** Ekran kaydı ve tıklamalar için ayrı bir izin gerekmez. Kamera ya da mikrofon çalışmıyorsa **Ayarlar › Gizlilik ve güvenlik › Kamera** (ya da **Mikrofon**) bölümünde masaüstü uygulamalarının erişimine izin verin. Bu ayar tek tek uygulamalar için değil, bütün masaüstü uygulamaları için geçerlidir.

*No separate permission is needed for screen recording and clicks. If the camera or microphone does not work, allow desktop apps to access them under **Settings › Privacy & security › Camera** (or **Microphone**); this setting applies to all desktop apps, not to one.*

### Kaldırma / Uninstalling
Uygulamayı silmek projelerinizi ve kayıtlarınızı **silmez**. Bunları isterseniz kendiniz silin.

*Removing the app does **not** delete your projects and recordings; delete them yourself if you want.*

| | macOS | Windows |
|---|---|---|
| Uygulama / App | **Uygulamalar** klasöründeki `Zeyvola`'yı Çöp Sepeti'ne taşıyın / move it to the Trash | Zip'ten çıkardığınız klasörü silin (kurulum programı yoktur) / delete the extracted folder (there is no installer) |
| Projeler ve kayıtlar / Projects and recordings | `~/Movies/Zeyvola Projeleri` (Finder'da **Filmler**) | **Videolar** klasörünüzdeki `Zeyvola Projeleri` (genellikle `%USERPROFILE%\Videos\Zeyvola Projeleri`) / in your **Videos** folder |
| Ayarlar / Settings | `~/Library/Application Support/Zeyvola` | `%APPDATA%\Zeyvola` |

Dışa aktardığınız videolar, kaydederken seçtiğiniz klasördedir ve kaldırmadan etkilenmez. macOS'ta izin satırlarını da kaldırmak isterseniz **Sistem Ayarları › Gizlilik ve Güvenlik** altındaki listelerde (ör. **Ekran ve Sistem Ses Kaydı**) Zeyvola'yı seçip "−" ile kaldırın.

*Exported videos stay in the folder you chose when saving. On macOS, to remove the permission entries too, select Zeyvola in the lists under **System Settings › Privacy & Security** (e.g. **Screen & System Audio Recording**) and click "−".*

### Sorun giderme / Troubleshooting
- **macOS "Yine de Aç" düğmesini göstermiyor:** Düğme, uygulamayı açmayı denedikten sonra yaklaşık bir saat görünür. Zeyvola'yı yeniden açmayı deneyin, sonra **Gizlilik ve Güvenlik**'e dönün. *The **Open Anyway** button appears for about an hour after you try to open the app; try again, then go back to **Privacy & Security**.*
- **Ekran kaydı başlamıyor (macOS):** Ekran kaydı izni verilmemiş ya da güncellemeden sonra eski izin geçersiz kalmış olabilir; yukarıdaki *İzinler* bölümüne bakın. *Screen recording does not start (macOS): the permission is missing or went stale after an update; see* Permissions *above.*
- **MP4 dışa aktarma:** MP4 (H.264 + AAC) işletim sisteminin kodlayıcısıyla yazılır. Windows'ta ekran kartının H.264 kodlayıcısı yoksa Windows'un kendi yazılım kodlayıcısı kullanılır; bu daha yavaştır. O da yoksa video WebM olarak kaydedilir ve Zeyvola bunu dışa aktarmadan önce ve sonra söyler ("MP4 yerine WebM olarak kaydedildi"). WebM her zaman seçilebilir. *MP4 is written with the operating system's encoder. On Windows without a hardware H.264 encoder, Windows' software encoder is used (slower); without that, the video is saved as WebM and Zeyvola tells you before and after the export ("Saved as WebM instead of MP4"). WebM is always available.*
- **Windows'ta uygulama hiç açılmıyor:** Akıllı Uygulama Denetimi açık olabilir (yukarıdaki 4. adım) ya da uygulama zip'in içinden çalıştırılmış olabilir (1. adım). *Smart App Control may be on (step 4), or the app was started from inside the zip (step 1).*

## Geliştirici / Developer
Zeyvola'yı **Yıldız Dikme** (Independent Software Developer) geliştirir. GitHub: [YildizDikme](https://github.com/YildizDikme).

Copyright © 2026 Yıldız Dikme. Zeyvola'nın kendi kodu aşağıdaki lisansla yayımlanır; üçüncü taraf bileşenler kendi lisanslarıyla dağıtılır.

*Zeyvola is developed by Yıldız Dikme (Independent Software Developer). Copyright © 2026 Yıldız Dikme. Zeyvola's own code is licensed as described below; third-party components keep their own licenses.*

## Lisans / License
Zeyvola'nın kaynak kodu **[PolyForm Shield License 1.0.0](LICENSE)** ile yayımlanır. Bu lisans "kaynağı açık" (source-available) bir lisanstır; OSI anlamında açık kaynak değildir. Lisansın gerekli bildirim satırları [`NOTICE`](NOTICE) dosyasındadır.

Kısaca (bağlayıcı olan lisans metnidir; bu özet ona bir şey eklemez):
- Zeyvola'yı kişiler, şirketler ve kurumlar ücretsiz kullanabilir; kopyalayabilir, değiştirebilir ve dağıtabilir.
- Lisans, Zeyvola ile yaptığınız videolar, kayıtlar ve projeler üzerinde hak iddia etmez ve ticari kullanımlarını sınırlamaz.
- İzin verilmeyen tek amaç, Zeyvola ile ya da lisans verenin Zeyvola'yı kullanarak sunduğu bir ürünle **rekabet eden bir ürün sağlamaktır**. Lisansa göre bir ürün ücretsiz olsa da rakip olabilir; Zeyvola'nın yerine geçecek şekilde sunulan bir ürün kesinlikle rakiptir.
- Bir kullanımın rekabet sayılıp sayılmadığı her durumda lisans metnine göre değerlendirilir.

*In short (the license text governs; this summary adds nothing to it): individuals, companies and institutions may use, copy, modify and distribute Zeyvola free of charge. The license claims no rights in the videos, recordings and projects you make with it and does not limit their commercial use. The one purpose it does not permit is providing a product that competes with Zeyvola or with a product the licensor provides using it; under the license a product can compete even when it is free, and one marketed as a practical substitute for Zeyvola definitely competes.*

"Zeyvola" adı ve logosu için: [TRADEMARKS.md](TRADEMARKS.md).

## Üçüncü taraf yazılımlar / Third-party software
Zeyvola, Electron (Chromium) ve birkaç JavaScript paketi üzerine kuruludur. Her bileşen kendi lisansıyla dağıtılır.
- Lisans metinleri: [docs/THIRD_PARTY_NOTICES.md](docs/THIRD_PARTY_NOTICES.md). Uygulama içinde: **Ayarlar › Lisanslar**.
- FFmpeg (LGPL-2.1 veya üstü): Electron'un tescilli codec'ler olmadan derlenmiş kitaplığı değiştirilmeden, ayrı ve dinamik bağlı bir dosya olarak dağıtılır. Karşılık gelen kaynak kodu her sürümle birlikte yayımlanır. Kitaplığı uyumlu bir sürümle değiştirebilirsiniz; ardından uygulamayı yeniden imzalayın.
- MP4 dışa aktarma H.264 görüntü ve AAC ses yazar. Bunları uygulamanın kendi kodu değil, işletim sisteminin kodlayıcısı üretir (macOS: VideoToolbox ve AudioToolbox; Windows: Media Foundation). Uygulamaya H.264 ya da AAC kodlayıcısı eklenmez; Electron'un içindeki yazılım H.264 kodlayıcısı (OpenH264) kullanılmaz. Ekran kartında H.264 kodlayıcısı yoksa Windows'ta Windows'un kendi yazılım kodlayıcısı kullanılır (daha yavaş; `native/helper-windows` aracılığıyla). O da yoksa video WebM olarak kaydedilir ve uygulama bunu dışa aktarmadan önce ve sonra açıkça söyler.
- H.264 ve AAC patentli codec'lerdir; telif ücretli patent havuzları vardır. İşletim sisteminin kodlayıcısını kullanmanın bu yükümlülükleri nasıl etkilediği hukuken netleşmemiştir; bu proje bu konuda bir güvence vermez. Ayrıntılar: [docs/THIRD_PARTY_NOTICES.md](docs/THIRD_PARTY_NOTICES.md) (codec tablosu).
- WebM dışa aktarma VP9 + Opus ile yapılır. Bu biçimlerin geliştiricileri (Google, Xiph.Org) kendi patentleri için telifsiz izin verir; üçüncü kişilerin patent iddiaları için bir güvence verilmez.
- *MP4 export writes H.264 video and AAC sound, produced by the operating system's own encoders (macOS VideoToolbox and AudioToolbox, Windows Media Foundation), not by the app's code; Electron's software H.264 encoder (OpenH264) is not used. Without a hardware H.264 encoder, Windows' own software encoder is used on Windows (slower, through `native/helper-windows`); otherwise the video is saved as WebM and the app says so before and after the export. H.264 and AAC are patented codecs with royalty-bearing patent pools; how using the operating system's encoders affects those obligations is not legally settled, and this project gives no assurance about it. WebM export uses VP9 + Opus.*

## Kaynaktan derleme / Building from source
Gereksinimler / Requirements:
- macOS (Apple Silicon)
- Node.js 22.12+ (sürüm `.nvmrc` dosyasında; nvm kullanıyorsanız depo kökünde `nvm use`)
- pnpm 10 (sürüm kök `package.json` içindeki `packageManager` alanında)
- Xcode komut satırı araçları (`xcode-select --install`): paketleme, yerel yardımcılar ve denetim araçları `swiftc`, `clang`, `codesign`, `lipo`, `otool`, `objdump`, `ditto`, `hdiutil`, `PlistBuddy` kullanır. `pnpm start` de geliştirme paketini `codesign` ile imzalar.

*Requirements: macOS (Apple Silicon); Node.js 22.12+ (see `.nvmrc`; run `nvm use` in the repository root if you use nvm); pnpm 10 (see `packageManager` in the root `package.json`); Xcode Command Line Tools, since packaging, the native helpers and the audit tools call `swiftc`, `clang`, `codesign`, `lipo`, `otool` and similar tools.*

```bash
nvm use                       # .nvmrc'deki Node sürümü
pnpm install
pnpm --filter @zeyvola/desktop exec node node_modules/electron/install.js   # Electron ikili dosyası
pnpm dev                      # geliştirme: derle ve uygulamayı aç (pnpm build && pnpm start)
pnpm test && pnpm typecheck   # birim testleri ve tip denetimi
pnpm package                  # macOS paketi → apps/desktop/out/mp4/darwin-<arch>/
pnpm codec-audit -- apps/desktop/out/mp4/darwin-arm64 --profile mp4 --probe --release
```

`pnpm package` varsayılan olarak yayımlanan yapılandırmayı (`ZEYVOLA_DIST=mp4`: macOS kayıt yardımcısı; dışa aktarma MP4 H.264 + AAC ve WebM VP9 + Opus) derler. Kayıt yardımcısı `native/recorder-macos/build.sh` ile evrensel ikili (arm64 + x86_64) olarak derlenir. `--profile webm` kayıt yardımcısı olmayan, yalnızca tarayıcı yoluyla kaydeden yapılandırmadır. Paketler yerel test için geçici imzalanır.

*`pnpm package` builds the published configuration by default (`ZEYVOLA_DIST=mp4`: the macOS recording helper; MP4 export as H.264 + AAC, WebM as VP9 + Opus). The helper is built as a universal binary (arm64 + x86_64) by `native/recorder-macos/build.sh`. `--profile webm` is the configuration without the helper, recording through the browser only. Packages are ad-hoc signed for local testing.*

Uygulama içi test takımları / In-app test suites (geçici bir proje klasörü, sentetik kamera ve mikrofonla çalışır; kendi projeleriniz okunmaz. Ekran ve GPU gerektirir):
- `pnpm smoke`: uygulamayı derler ve arayüz katmanını kendi kendine dener (WebGL2 kompozitör, gizleme efektleri, WebCodecs kodlayıcıları, MP4/WebM yazıcıları); bu Mac için bir yetenek tablosu raporlar.
- `pnpm perftest`: otomatik zoom, oynatma ve dışa aktarma sürelerini ölçer.
- `pnpm uitest`: ana akışı arayüz üzerinden sürer; dışa aktarılan her MP4'ü macOS'un kendi çözücüsüyle (AVFoundation) de açar.
- `node tests/media-check/av-check.mjs <dosya.mp4>`: bir MP4'ü AVFoundation ile denetler (H.264 görüntü, AAC ses, boş olmayan kare, süre); QuickTime'ın göreceğini gösterir.
- `pnpm docshots`: örnek projeden README için ekran görüntüleri üretir.

*The in-app suites use a temporary projects folder and a synthetic camera and microphone, and need a display and a GPU: `pnpm smoke` builds the app and self-tests the renderer stack (WebGL2 compositor, privacy effects, WebCodecs encoders, MP4/WebM writers), reporting a capability matrix for this Mac; `pnpm perftest` times automatic zoom, playback and export; `pnpm uitest` drives the main flow through the interface; `pnpm docshots` renders README screenshots from the sample project.*

Diğer notlar / Other notes:
- `tests/real-capture/` gerçek ekran kaydı yapar: Swift derleyicisi ve macOS ekran kaydı izni ister; `pnpm test`'e dahil değildir (bkz. [tests/real-capture/README.md](tests/real-capture/README.md)).
- `pnpm native:win` (Windows yardımcısı, deneysel) Zig derleyicisi ister: `tools/.cache/zig/zig` yolunda ya da `ZIG` ortam değişkeniyle. Zig depoda yoktur.
- Uygulama ağ isteği yapmaz; ancak bazı yayın araçları ağ ister: `pnpm install` ve Electron indirmesi, `tools/ffmpeg-source.mjs` (FFmpeg kaynak paketi) ve `tools/electron-artifacts.mjs`.

*`tests/real-capture/` records the real screen and needs the Swift compiler and the macOS screen recording permission; it is not part of `pnpm test`. `pnpm native:win` (Windows helper, experimental) needs the Zig compiler at `tools/.cache/zig/zig` or via `ZIG`; Zig is not in the repository. The app makes no network requests, but some release tools do: `pnpm install` and the Electron download, `tools/ffmpeg-source.mjs` and `tools/electron-artifacts.mjs`.*

## Yapı / Structure
- `apps/desktop`: Electron ana süreç, preload ve React arayüzü
- `packages/timing`: tick tabanlı zaman
- `packages/project-model`: belge şeması, komutlar, geri al/yinele, `evaluate()`
- `packages/zoom-engine`: otomatik zoom önerileri
- `packages/compositor`: WebGL2 render motoru (önizleme ve dışa aktarma)
- `packages/media-web`: MP4 ve WebM yazıcıları
- `packages/protocol`: IPC sözleşmesi ve doğrulama
- `native/input-macos`: tıklama yardımcısı (fare tuşları ve kaydırma; codec içermez)
- `native/recorder-macos`: macOS kayıt yardımcısı (ScreenCaptureKit; ekranı ve kamerayı macOS'un kodlayıcısıyla H.264 yazar, sesi Opus). Yayımlanan sürümde vardır.
- `tools/`: lisans bildirimleri, codec denetimi, FFmpeg kaynak paketi

## Katkı / Contributing
Hata bildirimleri ve öneriler için **Issues** kullanılabilir. Şimdilik dışarıdan kod katkısı (pull request) kabul edilmiyor.

*Bug reports and suggestions are welcome as Issues. Code contributions (pull requests) are not accepted for now.*
