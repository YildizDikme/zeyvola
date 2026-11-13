# Zeyvola Windows test: runs the packaged app's own tests on a real Windows 10/11 x64 PC.
#
#   powershell -ExecutionPolicy Bypass -File run-windows-tests.ps1 -App "C:\...\Zeyvola" [-Out "C:\...\results"]
#
# -App is the unzipped Windows package (the folder with Zeyvola.exe). For each configuration the
# app runs its smoke test (WebGL2 compositor, preview, editing, export, licenses) and the codec
# probe (recording formats), and writes JSON results to -Out:
#   1. bundled      d3dcompiler_47.dll next to Zeyvola.exe, as the package ships it today
#   2. no-dll-d3d11 that DLL moved aside; ANGLE's Direct3D 11 backend (needs a d3dcompiler_47.dll
#                   from somewhere else, for example the copy Windows itself has)
#   3. no-dll-vulkan that DLL moved aside; ANGLE's Vulkan backend (no HLSL compiler needed)
#   4. no-dll-gl    that DLL moved aside; ANGLE's OpenGL backend (no HLSL compiler needed)
# The DLL is always put back at the end. Nothing is installed, uploaded or sent anywhere.
param(
  [Parameter(Mandatory = $true)][string]$App,
  [string]$Out = (Join-Path (Get-Location) 'zeyvola-windows-test'),
  [int]$TimeoutMinutes = 15
)
$ErrorActionPreference = 'Stop'
$App = (Resolve-Path $App).Path  # Start-Process needs an absolute path
$exe = Join-Path $App 'Zeyvola.exe'
if (-not (Test-Path $exe)) { throw "Zeyvola.exe bulunamadi: $exe" }
New-Item -ItemType Directory -Force -Path $Out | Out-Null
$Out = (Resolve-Path $Out).Path
$dll = Join-Path $App 'd3dcompiler_47.dll'
$aside = "$dll.test-off"
if ((Test-Path $aside) -and -not (Test-Path $dll)) { Rename-Item $aside 'd3dcompiler_47.dll' }  # an earlier run was interrupted
$bundled = Test-Path $dll
$systemCopy = Test-Path (Join-Path $env:WINDIR 'System32\d3dcompiler_47.dll')

function Invoke-App([string]$name, [string[]]$appArgs) {
  $quoted = $appArgs | ForEach-Object { if ($_ -match '\s') { '"' + $_ + '"' } else { $_ } }
  $p = Start-Process -FilePath $exe -ArgumentList $quoted -PassThru -WindowStyle Normal
  $null = $p.Handle  # keeps the handle so ExitCode can be read after the process ends
  if (-not $p.WaitForExit($TimeoutMinutes * 60 * 1000)) {
    Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
    return @{ exitCode = $null; timedOut = $true }
  }
  return @{ exitCode = $p.ExitCode; timedOut = $false }
}

function Test-Config([string]$name, [string[]]$extra) {
  Write-Host "== $name"
  $smokeFile = Join-Path $Out "smoke-$name.json"
  $probeFile = Join-Path $Out "codec-probe-$name.json"
  Remove-Item $smokeFile, $probeFile -ErrorAction SilentlyContinue
  $smokeRun = Invoke-App $name (@('--smoke', '--smoke-report', $smokeFile) + $extra)
  $probeRun = Invoke-App $name (@('--codec-probe', $probeFile) + $extra)
  # The reports are UTF-8; this script itself stays ASCII so Windows PowerShell 5.1 reads it correctly.
  $smoke = if (Test-Path $smokeFile) { Get-Content $smokeFile -Raw -Encoding UTF8 | ConvertFrom-Json } else { $null }
  $webgl = if ($smoke) { $smoke.checks | Where-Object { $_.name -like 'WebGL2 *' } | Select-Object -First 1 } else { $null }
  $failed = if ($smoke) { @($smoke.checks | Where-Object { -not $_.ok } | ForEach-Object { $_.name }) } else { @() }
  return [ordered]@{
    config = $name
    args = ($extra -join ' ')
    smokeOk = if ($smoke) { [bool]$smoke.ok } else { $false }
    smokeChecks = if ($smoke) { @($smoke.checks).Count } else { 0 }
    smokeFailed = $failed
    smokeExit = $smokeRun.exitCode
    smokeTimedOut = $smokeRun.timedOut
    webgl2 = if ($webgl) { [bool]$webgl.ok } else { $false }
    renderer = if ($webgl) { $webgl.detail } else { $smoke.gpu }
    codecProbeWritten = (Test-Path $probeFile)
    codecProbeExit = $probeRun.exitCode
  }
}

$results = @()
try {
  if ($bundled) { $results += Test-Config 'bundled' @() }
  if ($bundled) { Rename-Item $dll 'd3dcompiler_47.dll.test-off' }
  $results += Test-Config 'no-dll-d3d11' @('--use-angle=d3d11')
  $results += Test-Config 'no-dll-vulkan' @('--use-angle=vulkan')
  $results += Test-Config 'no-dll-gl' @('--use-angle=gl')
} finally {
  if ((Test-Path $aside) -and -not (Test-Path $dll)) { Rename-Item $aside 'd3dcompiler_47.dll' }
}

$os = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion'
$summary = [ordered]@{
  date = (Get-Date).ToString('s')
  windows = "$($os.ProductName) $($os.DisplayVersion) (build $($os.CurrentBuild))"
  packageHadDll = $bundled
  systemHasD3dcompiler47 = $systemCopy
  results = $results
}
$summaryFile = Join-Path $Out 'summary.json'
$summary | ConvertTo-Json -Depth 6 | Set-Content -Encoding UTF8 $summaryFile
$results | ForEach-Object { [pscustomobject]$_ } | Format-Table config, smokeOk, smokeChecks, webgl2, codecProbeWritten, renderer -AutoSize
Write-Host "Sonuclar: $Out (summary.json ve her yapilandirmanin JSON dosyalari)"
