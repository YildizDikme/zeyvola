# Environment dump for the Windows CI run (diagnosis only): what on this machine can change the
# app's test results. Nothing personal is written: no computer, user or network names.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File env-dump.ps1 -Out <folder>
#
# Writes <folder>/windows-env.json: Windows edition and build, installation type (Server with or
# without Desktop Experience), the Media Foundation feature (Server) or Media Feature Pack (N
# editions), display adapters, WARP and d3dcompiler_47.dll in System32, whether the session is
# interactive and the screen size, and Media Foundation's H.264 / AAC encoders and decoders with a
# small H.264 encode (tests/media-check/mf-check.ps1 -Inventory). The browser side (ANGLE renderer,
# WebCodecs) comes from the app's own smoke report. ASCII only (Windows PowerShell 5.1).
param([Parameter(Mandatory = $true)][string]$Out)
$ErrorActionPreference = 'Continue'
New-Item -ItemType Directory -Force -Path $Out | Out-Null
$Out = (Resolve-Path $Out).Path
$r = [ordered]@{}

$os = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion'
$r.windows = [ordered]@{
  productName = $os.ProductName; editionId = $os.EditionID; installationType = $os.InstallationType
  displayVersion = $os.DisplayVersion; build = "$($os.CurrentBuild).$($os.UBR)"
  caption = (Get-CimInstance Win32_OperatingSystem).Caption
}

# Media Foundation: an optional feature on Windows Server, part of the system elsewhere except the
# N editions (Media Feature Pack).
$features = [ordered]@{}
try { $f = Get-WindowsFeature -Name Server-Media-Foundation -ErrorAction Stop; $features.serverMediaFoundation = "$($f.InstallState)" } catch { $features.serverMediaFoundation = "sorulamadi: $($_.Exception.Message)" }
try { $f = Get-WindowsOptionalFeature -Online -FeatureName ServerMediaFoundation -ErrorAction Stop; $features.optionalServerMediaFoundation = "$($f.State)" } catch { $features.optionalServerMediaFoundation = "sorulamadi" }
try { $c = Get-WindowsCapability -Online -Name 'Media.MediaFeaturePack*' -ErrorAction Stop | Select-Object -First 1; $features.mediaFeaturePack = if ($c) { "$($c.State)" } else { 'yok (N surumu degil ya da listelenmiyor)' } } catch { $features.mediaFeaturePack = 'sorulamadi' }
foreach ($dll in 'mfplat.dll', 'mfreadwrite.dll', 'msmpeg2vdec.dll', 'mfh264enc.dll', 'msmpeg2adec.dll', 'mfaacenc.dll', 'd3dcompiler_47.dll', 'd3d10warp.dll', 'd3d11.dll', 'vulkan-1.dll', 'Windows.Graphics.Capture.dll', 'dwmapi.dll') {
  $features["System32\$dll"] = Test-Path (Join-Path $env:WINDIR "System32\$dll")
}
$r.components = $features

$r.displayAdapters = @(Get-CimInstance Win32_VideoController | ForEach-Object {
  [ordered]@{ name = $_.Name; driverVersion = $_.DriverVersion; status = $_.Status; mode = "$($_.CurrentHorizontalResolution)x$($_.CurrentVerticalResolution)"; pnp = ($_.PNPDeviceID -split '\\')[0] }
})

Add-Type -AssemblyName System.Windows.Forms
$screens = [System.Windows.Forms.Screen]::AllScreens
$explorer = @(Get-Process explorer -ErrorAction SilentlyContinue).Count -gt 0
$r.session = [ordered]@{
  userInteractive = [Environment]::UserInteractive
  sessionId = (Get-Process -Id $PID).SessionId
  explorerRunning = $explorer
  screens = @($screens | ForEach-Object { [ordered]@{ primary = $_.Primary; bounds = "$($_.Bounds.Width)x$($_.Bounds.Height)"; bitsPerPixel = $_.BitsPerPixel } })
  smartScreenPolicy = (Get-ItemProperty 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\System' -ErrorAction SilentlyContinue).EnableSmartScreen
}

# Media Foundation inventory and encode test (same probe the tests use).
$mf = Join-Path $PSScriptRoot '..\media-check\mf-check.ps1'
$line = & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $mf -Inventory -Out $Out 2>&1 | Select-Object -Last 1
try { $r.mediaFoundation = $line | ConvertFrom-Json } catch { $r.mediaFoundation = "cikti okunamadi: $line" }

$r | ConvertTo-Json -Depth 10 | Set-Content -Encoding UTF8 (Join-Path $Out 'windows-env.json')
Write-Host (Get-Content (Join-Path $Out 'windows-env.json') -Raw)
exit 0
