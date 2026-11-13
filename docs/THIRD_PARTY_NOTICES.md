# Üçüncü Taraf Yazılımlar / Third-Party Software

<!-- Bu dosya `node tools/third-party-notices.mjs --write` ile üretilir; elle düzenlemeyin. -->

Zeyvola, aşağıdaki üçüncü taraf yazılımları içerir. Her bileşen kendi lisansıyla dağıtılır; lisans metinleri aşağıdadır.
Zeyvola contains the third-party software listed below. Each component is distributed under its own license; the texts follow.

**Zeyvola'nın kendi lisansı: PolyForm Shield License 1.0.0** (`LICENSE`). Bu dosya yalnızca üçüncü taraf bileşenleri kapsar.
*Zeyvola's own license: PolyForm Shield License 1.0.0* (`LICENSE`). This file covers third-party components only.

> Required Notice: Copyright © 2026 Yıldız Dikme (https://github.com/YildizDikme/zeyvola)
> Licensor Line of Business: Zeyvola, screen recording and video editing software (https://github.com/YildizDikme/zeyvola)

## 1. Uygulamayla dağıtılan JavaScript paketleri / Bundled JavaScript packages

| Paket / Package | Sürüm / Version | Lisans / License | Telif / Copyright |
|---|---|---|---|
| react | 19.3.1 | MIT | Copyright (c) Meta Platforms, Inc. and affiliates. |
| react-dom | 19.3.1 | MIT | Copyright (c) Meta Platforms, Inc. and affiliates. |
| scheduler | 0.28.0 | MIT | Copyright (c) Meta Platforms, Inc. and affiliates. |
| zod | 4.6.7 | MIT | Copyright (c) 2025 Colin McDonnell |

### react 19.3.1

Lisans / License: MIT · https://github.com/react/react

```text
MIT License

Copyright (c) Meta Platforms, Inc. and affiliates.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### react-dom 19.3.1

Lisans / License: MIT · https://github.com/react/react

```text
MIT License

Copyright (c) Meta Platforms, Inc. and affiliates.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### scheduler 0.28.0

Lisans / License: MIT · https://github.com/react/react

```text
MIT License

Copyright (c) Meta Platforms, Inc. and affiliates.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### zod 4.6.7

Lisans / License: MIT · https://github.com/colinhacks/zod

```text
MIT License

Copyright (c) 2025 Colin McDonnell

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## 2. Electron 44.8.0 ve Chromium / Electron and Chromium

Zeyvola, Electron 44.8.0 çalışma ortamıyla dağıtılır. Electron MIT lisanslıdır:

```text
Copyright (c) Electron contributors
Copyright (c) 2013-2020 GitHub Inc.

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
"Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

Electron; Chromium, Node.js, FFmpeg ve diğer bileşenleri içerir. Bunların lisans bildirimleri her uygulama paketinde, o platformun
Electron sürümüyle gelen `licenses/LICENSES.chromium.html` dosyasında yer alır ve uygulamanın Ayarlar → Lisanslar bölümünden açılabilir.
Dosyanın giriş sayısı ve SHA-256 özeti platforma göre değişir; paketin içindeki THIRD_PARTY_NOTICES.md bunları yazar.
Electron bundles Chromium, Node.js, FFmpeg and other components; their notices ship in every package as `licenses/LICENSES.chromium.html`,
the file of that platform's Electron build. Its entry count and SHA-256 differ per platform; the package's own THIRD_PARTY_NOTICES.md states them.

## 2b. Electron ile gelen, Chromium bildiriminde bulunmayan bileşenler / Components shipped with Electron but missing from its Chromium notices

Electron'un `LICENSES.chromium.html` dosyası aşağıdaki bileşenleri kapsamıyor; lisansları burada verilir.
Electron's `LICENSES.chromium.html` does not cover the components below; their licenses follow.

### Mantle (macOS)

Sürüm / Version: Electron'un kendi derlemesi (com.electron.mantle), Squirrel.Mac bağımlılığı · Lisans / License: MIT; Proton bölümleri BSD · Kaynak / Source: https://github.com/Mantle/Mantle/blob/ed1a76b493/LICENSE.md (lisans dosyası 2015-03-21'den beri değişmedi)

```text
**Copyright (c) GitHub, Inc.**
**All rights reserved.**

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

---

**This project uses portions of code from the Proton framework.**
**Proton is copyright (c) 2012, Bitswift, Inc.**
**All rights reserved.**

Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:

 * Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.
 * Neither the name of the Bitswift, Inc. nor the names of its contributors may be used to endorse or promote products derived from this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

### ReactiveObjC (macOS)

Sürüm / Version: 3.1.0 (Electron'un derlemesi, com.electron.reactive), Squirrel.Mac bağımlılığı · Lisans / License: MIT · Kaynak / Source: https://github.com/ReactiveCocoa/ReactiveObjC/blob/3.1.0/LICENSE.md

```text
**Copyright (c) 2012 - 2016, GitHub, Inc.**
**All rights reserved.**

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### Microsoft Direct3D HLSL Compiler (d3dcompiler_47.dll) (Windows)

Sürüm / Version: 10.0.26100.7705 (Windows SDK 10.0.26100, "Direct3D HLSL Compiler for Redistribution") · Lisans / License: Microsoft yazılımı; Windows SDK lisans koşullarındaki dağıtılabilir kod (Distributable Code) olarak Electron ile gelir. Zeyvola bu dosyanın sahibi değildir ve Zeyvola'nın lisansı bu dosyaya uygulanmaz. Windows SDK lisansı dağıtanın son kullanıcıları koruyucu koşullara bağlamasını şart koşar; bu koşullar aşağıdadır ve Windows'ta ilk açılışta kabul edilir. © Microsoft Corporation. · Kaynak / Source: Windows SDK lisansı: https://aka.ms/WinSDKLicenseURL ; yan yana dağıtım: https://learn.microsoft.com/en-us/windows/win32/directx-sdk--august-2009- (sistem bileşeni değildir)

```text
MICROSOFT BİLEŞENİ İÇİN KULLANICI KOŞULLARI (d3dcompiler_47.dll)
Sürüm 2026-10-17

Zeyvola'nın Windows sürümü, Microsoft Corporation'a ait "Direct3D HLSL Compiler" dosyasını
(d3dcompiler_47.dll) içerir. Bu dosya Zeyvola'nın değildir; Microsoft'un Windows SDK lisansındaki
dağıtılabilir kod koşulları kapsamında Zeyvola ile birlikte dağıtılır. Microsoft bu dağıtımı,
kullanıcıların aşağıdaki koşulları kabul etmesine bağlar. Zeyvola'yı Windows'ta kullanmak için bu
koşulları kabul etmeniz gerekir.

Bu koşullar YALNIZCA d3dcompiler_47.dll dosyası için geçerlidir. Zeyvola'nın kendi lisansını
(PolyForm Shield 1.0.0) ve uygulamadaki açık kaynak bileşenlerin lisanslarını değiştirmez. Özellikle
FFmpeg kitaplıkları (LGPL-2.1) üzerinde LGPL'nin size tanıdığı hakları kısıtlamaz: bu kitaplıkları
değiştirebilir, değiştirilmiş sürümleriyle değiştirebilir ve bunun için gereken tersine mühendisliği
yapabilirsiniz.

1. Dosya size satılmaz, yalnızca kullanım hakkı verilir. Microsoft, bu koşullarda açıkça verilmeyen
   bütün hakları saklı tutar.
2. Dosyayı yalnızca Zeyvola'nın bir parçası olarak ve Microsoft Windows üzerinde kullanabilirsiniz.
3. Yürürlükteki hukuk bu sınırlamaya rağmen size daha fazla hak tanımadıkça:
   a. dosyadaki teknik sınırlamaları aşamazsınız;
   b. dosyada tersine mühendislik yapamaz, kaynak koda dönüştüremez veya parçalarına ayıramazsınız;
      yürürlükteki hukukun bu sınırlamaya rağmen açıkça izin verdiği ölçü saklıdır;
   c. dosyayı başkalarının kopyalaması için yayımlayamaz; kiralayamaz, ödünç veremez; Zeyvola'dan
      ayrı olarak başkasına devredemez;
   d. dosyayı ticari yazılım barındırma hizmetlerinde kullanamazsınız;
   e. dosya üzerinde yapılan bir performans ölçümünün sonuçlarını Microsoft'un önceden yazılı onayı
      olmadan üçüncü kişilere açıklayamazsınız.
4. Dosyadaki telif hakkı, marka ve patent bildirimlerini değiştiremez veya kaldıramazsınız.
5. Zeyvola'yı başkalarına dağıtırsanız, alıcıların da bu koşulları kabul etmesini sağlamalısınız.
6. Dosya ABD ihracat mevzuatına tabidir. Dosyaya uygulanan bütün ulusal ve uluslararası ihracat
   kurallarına uymalısınız (www.microsoft.com/exporting).
7. Microsoft bu dosya için destek hizmeti vermez.
8. GARANTİ YOKTUR. Dosya "olduğu gibi" sağlanır; kullanım riski size aittir. Microsoft hiçbir açık
   garanti veya taahhüt vermez. Yerel hukukunuzun tanıdığı ve bu koşulların değiştiremeyeceği tüketici
   hakları saklıdır. Yerel hukukun izin verdiği ölçüde Microsoft; satılabilirlik, belirli bir amaca
   uygunluk ve hak ihlali olmamasına ilişkin zımni garantileri hariç tutar.
9. SORUMLULUK SINIRI. Microsoft'tan ve tedarikçilerinden yalnızca 5,00 ABD dolarına kadar doğrudan
   zararınızı talep edebilirsiniz. Dolaylı zararlar, kâr kaybı, özel, arızi veya sonuç olarak doğan
   zararlar dahil başka hiçbir zararı talep edemezsiniz. Bu sınır; dosyayla, üçüncü taraf internet
   sitelerindeki içerikle veya üçüncü taraf programlarla ilgili her şeye ve yürürlükteki hukukun izin
   verdiği ölçüde sözleşmeye, garantiye, teminata veya şarta aykırılığa, kusursuz sorumluluğa, ihmale
   veya başka bir haksız fiile dayanan taleplere uygulanır. Microsoft zarar olasılığını biliyor veya
   bilmesi gerekiyor olsa da uygulanır. Bazı ülkeler bu sınırlamaya izin vermeyebilir; o durumda yerel
   hukuk geçerlidir.

Bu koşullar Microsoft'un Windows SDK lisansındaki korumaları son kullanıcıya aktarmak için
hazırlanmıştır. Microsoft'un dosyaya ilişkin hakları bu metinle sınırlı değildir.

----------------------------------------------------------------------------------------------------

USER TERMS FOR A MICROSOFT COMPONENT (d3dcompiler_47.dll)
Version 2026-10-17

The Windows version of Zeyvola includes Microsoft Corporation's "Direct3D HLSL Compiler" file
(d3dcompiler_47.dll). This file is not Zeyvola's; it is distributed with Zeyvola as distributable code
under the terms of Microsoft's Windows SDK license. Microsoft makes this distribution conditional on
users accepting the terms below. You must accept them to use Zeyvola on Windows.

These terms apply ONLY to the file d3dcompiler_47.dll. They do not change Zeyvola's own license
(PolyForm Shield 1.0.0) or the licenses of the open-source components in the app. In particular, they
do not restrict the rights the LGPL gives you for the FFmpeg libraries (LGPL-2.1): you may modify those
libraries, replace them with modified versions and do the reverse engineering needed for that.

1. The file is licensed, not sold. Microsoft reserves all rights not expressly granted in these terms.
2. You may use the file only as part of Zeyvola and only on Microsoft Windows.
3. Unless applicable law gives you more rights despite this limitation, you may not:
   a. work around any technical limitations in the file;
   b. reverse engineer, decompile or disassemble the file, except and only to the extent that
      applicable law expressly permits, despite this limitation;
   c. publish the file for others to copy; rent, lease or lend it; or transfer it to anyone apart from
      Zeyvola;
   d. use the file for commercial software hosting services;
   e. disclose the results of any benchmark test of the file to a third party without Microsoft's
      prior written approval.
4. You may not alter or remove any copyright, trademark or patent notice in the file.
5. If you distribute Zeyvola to others, you must have them accept these terms too.
6. The file is subject to United States export laws and regulations. You must comply with all domestic
   and international export laws and regulations that apply to it (www.microsoft.com/exporting).
7. Microsoft does not provide support services for the file.
8. NO WARRANTY. The file is provided "as is"; you bear the risk of using it. Microsoft gives no express
   warranties, guarantees or conditions. You may have consumer rights under your local laws which these
   terms cannot change. To the extent permitted under your local laws, Microsoft excludes the implied
   warranties of merchantability, fitness for a particular purpose and non-infringement.
9. LIMITATION OF LIABILITY. You can recover from Microsoft and its suppliers only direct damages up to
   U.S. $5.00. You cannot recover any other damages, including consequential, lost profits, special,
   indirect or incidental damages. This limitation applies to anything related to the file, content
   on third-party internet sites or third-party programs, and, to the extent permitted by applicable
   law, to claims for breach of contract, breach of warranty, guarantee or condition, strict liability,
   negligence or other tort. It applies even if Microsoft knew or should have known about the
   possibility of the damages. Some countries may not allow this limitation; in that case your local
   law applies.

These terms are written to pass the protections of Microsoft's Windows SDK license on to end users.
Microsoft's rights in the file are not limited to this text.
```

## 3. Codec'ler: açık kaynak lisansı ve patent durumu ayrıdır / Codecs: open-source license and patents are separate

Bir bileşenin açık kaynak (telif) lisansı, onu kullananlara patent lisansı vermez. Aşağıdaki patent notları **çözülmüş değildir**;
Bu tablo hukuki görüş değildir.
An open-source (copyright) license does not grant patent rights. The patent notes below are **not resolved** and are not legal advice.

| Bileşen | Dağıtım | Nerede | Açık kaynak lisansı | Patent durumu | Değerlendirme |
|---|---|---|---|---|---|
| FFmpeg (libffmpeg, Electron'un codec'siz derlemesi) | A, B, VP8 | Ayrı, dinamik bağlanan kitaplık (macOS: libffmpeg.dylib, Windows: ffmpeg.dll). Electron'un resmi tescilli codec'siz derlemesi (Electron'un derleme ayarları: ffmpeg_branding "Chromium", proprietary_codecs false); ölçülen çözücüler: FLAC, MP3, Vorbis, Opus, PCM. H.264 ve AAC çözücüsü yok, kodlayıcı yok. · Chromium bildiriminde var | Bu yazılım FFmpeg projesinin kitaplıklarını LGPLv2.1 altında kullanır (LGPL-2.1 veya sonrası; tam metin LICENSES.chromium.html, "ffmpeg" girişi). Karşılık gelen kaynak: chromium/third_party/ffmpeg 2b68d2babae7 (Chromium 152.0.7977.167'nin sabitlediği revizyon), Electron'un yaması ve derleme ayarları; her GitHub sürümüne ayrı dosya olarak eklenir (FFMPEG-LGPL.md). | Patent havuzlu çözücüler (H.264, AAC) pakette yok. Kalan biçimler için bilinen aktif bir havuz bulunamadı; hukuken doğrulanmadı. | Düşük risk — hukuken doğrulanmadı |
| OpenH264 (Electron içinde) | A, B, VP8 | Electron'un ana ikilisinde statik olarak derlenmiş (ölçüldü). Zeyvola onu hiçbir dağıtımda istemez: H.264 yalnızca donanım (işletim sistemi) kodlayıcısından istenir; tam smoke testinde OpenH264 bir kez bile başlatılmadı. Resmi Electron ikililerinden çıkarılamaz. · Chromium bildiriminde var | BSD-2-Clause | Cisco'nun H.264 patent güvencesi yalnızca kurulumda Cisco'dan indirilen ikili için geçerli; kaynaktan derlenmiş bu kopyayı kapsamaz. Kullanılmayan bir kodlayıcıyı dağıtmanın lisans gerektirip gerektirmediği belirsiz. | Hukuki inceleme gerekli |
| H.264 kodlama (MP4 dışa aktarma) | A, B | İşletim sisteminin kodlayıcısı: önce ekran kartının (donanım) kodlayıcısı WebCodecs üzerinden: macOS VideoToolbox (ölçüldü), Windows Media Foundation (Windows'ta test edilmedi). Windows'ta donanım kodlayıcısı yoksa Windows'un kendi yazılım kodlayıcısı ("H264 Encoder MFT", mfh264enc.dll) Windows yardımcısının Sink Writer'ı üzerinden kullanılır (GitHub Windows koşucusunda envanterde görüldü; uygulama içinden henüz ölçülmedi). Electron'un yazılım H.264 kodlayıcısı (OpenH264) hiç istenmez. Hiçbiri yoksa video WebM olarak kaydedilir ve bu açıkça söylenir; MP4'e başka codec yazılmaz. A dağıtımında macOS kayıt yardımcısı da ekranı ve kamerayı VideoToolbox ile H.264 yazar. | Kodlayıcı Zeyvola'nın değil; işletim sistemine ait | Apple (macOS Tahoe 26 SLA §14 D) ve Microsoft (Windows 11 lisans koşulları) AVC işlevini yalnızca tüketicinin kişisel ve ticari olmayan kullanımı için lisanslıyor; ticari kullanım ek lisans gerektiriyor. Via LA AVC havuzu aktif. Lisans sahibinin kim olacağı belirsiz. | Hukuki inceleme gerekli |
| H.264 çözme (kayıtlar ve içe aktarılan videolar) | A, B, VP8 | Pakette H.264 çözücü yok; H.264 yalnızca işletim sisteminin çözücüsüyle çözülür (macOS VideoToolbox, ölçüldü; Windows'ta Media Foundation/donanım çözücüsü, test edilmedi). B dağıtımında yalnızca kullanıcının içe aktardığı H.264 videolar için. | Çözücü Zeyvola'nın değil; işletim sistemine ait | İşletim sistemi lisanslarındaki AVC bildirimi kod çözmeyi de kişisel ve ticari olmayan kullanımla sınırlıyor. Hukuken doğrulanmadı. | Hukuki inceleme gerekli |
| AAC kodlama (MP4 dışa aktarma) | A, B | İşletim sisteminin kodlayıcısı (MP4 dışa aktarmanın sesi): libffmpeg'de kodlayıcı yok (ölçüldü); macOS'ta AudioToolbox, Windows'ta Media Foundation (WebCodecs ya da, H.264 yazılım yolunda, Windows yardımcısının Sink Writer'ı içinde "Microsoft AAC Audio Encoder MFT", mfaacenc.dll; Windows'ta uygulama içinden test edilmedi). Kodlayıcı yoksa video WebM olarak kaydedilir; MP4'e Opus yazılmaz. Kayıtlar AAC değil Opus ile yazılır. | Kodlayıcı Zeyvola'nın değil | Via LA AAC: son kullanıcı kodlayıcı/çözücü ürünleri lisans gerektirir (başlangıç ücreti 15.000 $, küçük işletmeye 1.000 $; birim başı 0,98 $'dan). İşletim sistemi kodlayıcısını çağıran bir uygulamanın 'ürün' sayılıp sayılmadığı belirsiz. AAC içeriğin dağıtımı ücretsiz. | Hukuki inceleme gerekli |
| AAC çözme (içe aktarılan videoların sesi) | A, B, VP8 | Pakette AAC çözücü yok. AAC sesli bir video eklenince ses işletim sisteminin kendi çözücüsüyle çözülür: macOS'ta AVFoundation (bin/zeyvola-audio, Opus olarak yeniden yazar), Windows'ta Media Foundation (resources/bin/zeyvola-win.exe, 16 bit PCM WAV yazar; Windows'ta test edilmedi). Çözülemezse video sessiz eklenir ve kullanıcı uyarılır. | Çözücü Zeyvola'nın değil; işletim sistemine ait | AAC kodlama satırındaki belirsizlik çözme için de geçerli. | Hukuki inceleme gerekli |
| VP9 / VP8 (libvpx) | A, B, VP8 | Electron (WebM dışa aktarma, Chromium kayıt yolu, çözme) · Chromium bildiriminde var | BSD-3-Clause ve Google'ın ayrı patent izni | Google, WebM projesinin dağıttığı uygulamalar (libvpx) için telifsiz, süresiz patent izni veriyor; izin Google'ın kendi patentleriyle sınırlı. Sisvel'in VP9 havuzu 'VP9 kullanan her tüketici ürününü' kapsadığını söylüyor, yalnız yazılım ürünlerinden söz etmiyor. Hukuken doğrulanmadı. | Düşük risk — hukuken doğrulanmadı |
| Opus (libopus; macOS'ta işletim sisteminin Opus kodlayıcısı) | A, B, VP8 | Electron (WebM/MP4 ses kodlama ve çözme). macOS kayıt yardımcısı mikrofon ve sistem sesini macOS'un Opus kodlayıcısıyla MP4'e yazar. · Chromium bildiriminde var | BSD-3-Clause ve Xiph/Broadcom/Microsoft patent izinleri | Xiph.Org, Broadcom ve Microsoft telifsiz ve otomatik patent izni veriyor (dava açana karşı sona erme koşuluyla). Bazı şirketlerin IETF'ye ücretli olabilecek bildirimleri var; Opus sitesi dış hukuk görüşüne göre bunların lisanssız uygulanabildiğini söylüyor. Vectis havuzunun basın bülteni bağımsız yazılımı hedeflemediğini söylüyor. Hukuken doğrulanmadı. | Düşük risk — hukuken doğrulanmadı |
| AV1 (libaom kodlayıcı, dav1d çözücü; Electron içinde) | A, B, VP8 | Electron'un ana ikilisinde (ölçüldü). Zeyvola şu an AV1 ile dışa aktarmıyor; içe aktarılan AV1 videolar çözülür. · Chromium bildiriminde var | libaom: BSD-2-Clause + AOMedia Patent License 1.0; dav1d: BSD-2-Clause ("dav1d is an AV1 decoder :)" girişi) | AOMedia telifsiz patent lisansı var; Sisvel'in ücretli bir AV1 havuzu da var. Düşük risk, hukuken doğrulanmadı. | Düşük risk — hukuken doğrulanmadı |
| MP4 ve WebM kapsayıcı yazıcıları | A, B, VP8 | Zeyvola'nın kendi kodu (packages/media-web). MP4 yalnızca H.264 + AAC, WebM VP9 (deneysel dağıtımda VP8) + Opus taşır. | Zeyvola'nın kendi kodu (PolyForm Shield License 1.0.0) | Matroska açık bir biçim (RFC 9559). ISO BMFF için bilinen aktif bir patent havuzu bulunamadı; doğrulanmadı. | Düşük risk — hukuken doğrulanmadı |

