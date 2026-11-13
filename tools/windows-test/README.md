# Windows testi

Zeyvola'nın Windows paketini gerçek bir Windows 10/11 x64 bilgisayarda dener. Uygulamanın kendi testlerini çalıştırır: duman testi (WebGL2 önizleme, düzenleme, dışa aktarma, lisanslar) ve codec sondası (kayıt biçimleri).

Dört yapılandırmayı dener:

| Yapılandırma | Ne denenir |
|---|---|
| `bundled` | Paket bugünkü haliyle, `d3dcompiler_47.dll` uygulamanın yanında. |
| `no-dll-d3d11` | DLL kenara alınmış; Direct3D 11 arka ucu. DLL'i başka bir yerden, örneğin Windows'un kendi kopyasından bulmak zorunda. |
| `no-dll-vulkan` | DLL kenara alınmış; Vulkan arka ucu. HLSL derleyicisi gerekmez. |
| `no-dll-gl` | DLL kenara alınmış; OpenGL arka ucu. HLSL derleyicisi gerekmez. |

DLL test bitince yerine konur. Betik hiçbir şey kurmaz ve ağa bir şey göndermez.

```powershell
powershell -ExecutionPolicy Bypass -File run-windows-tests.ps1 -App "C:\Users\<siz>\Downloads\Zeyvola"
```

Zip'i internetten indirdiyseniz Windows dosyaları engelleyebilir. Önce klasörde şunu çalıştırın:

```powershell
Get-ChildItem -Recurse | Unblock-File
```

Uygulama imzasız olduğu için SmartScreen "Windows bilgisayarınızı korudu" diyebilir. Bu durumda **Ek bilgi › Yine de çalıştır** seçin. Test sırasında Zeyvola pencereleri birkaç kez açılıp kapanır; bitene kadar bilgisayarı kullanmayın.

Sonuçlar `zeyvola-windows-test\summary.json` dosyasına yazılır. `renderer` sütunu hangi grafik arka ucunun gerçekten çalıştığını gösterir (ör. `Direct3D11`, `Vulkan`, `OpenGL`).

Bu sonuç, Windows sürümünün Microsoft DLL'i olmadan dağıtılıp dağıtılamayacağını belirler. Mümkünse hem bir Windows 10 hem bir Windows 11 bilgisayarda çalıştırın.
