# Watches which d3dcompiler_47.dll the app's processes load while a test runs (CI on Windows):
# full path, process type (browser, gpu-process, renderer, ...) and file version, once per second,
# from the moment the app starts until it has been gone for a few seconds.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File dll-watch.ps1 -Exe <...\Zeyvola.exe> -Out <file.json> [-TimeoutSec 1200]
#
# Started in the background before the app; writes <file.json> when the app has ended. Also
# records the file version of the copy next to the app (if any) and of Windows' own copy in
# System32, so a run without the bundled DLL shows which one Chromium falls back to.
# Only reads process module lists; ASCII only (Windows PowerShell 5.1).
param(
  [Parameter(Mandatory = $true)][string]$Exe,
  [Parameter(Mandatory = $true)][string]$Out,
  [int]$TimeoutSec = 1200
)
$ErrorActionPreference = 'Continue'
$Exe = [System.IO.Path]::GetFullPath($Exe)
$bundled = Join-Path (Split-Path $Exe) 'd3dcompiler_47.dll'
$system = Join-Path $env:WINDIR 'System32\d3dcompiler_47.dll'
function Version([string]$p) {
  if (-not (Test-Path $p)) { return $null }
  # [pscustomobject]: Windows PowerShell 5.1 writes a nested [ordered] table as an empty object.
  $v = (Get-Item $p).VersionInfo
  # .NET directly: Get-FileHash is not always loaded in a hidden Windows PowerShell 5.1 process.
  $hash = try { $sha = [System.Security.Cryptography.SHA256]::Create(); $fs = [System.IO.File]::Open($p, 'Open', 'Read', 'ReadWrite'); try { ([BitConverter]::ToString($sha.ComputeHash($fs)) -replace '-', '').ToLower() } finally { $fs.Dispose() } } catch { "okunamadi: $($_.Exception.Message)" }
  [pscustomobject]@{ path = $p; fileVersion = $v.FileVersion; productVersion = $v.ProductVersion; bytes = (Get-Item $p).Length; sha256 = $hash }
}
function TypeOf($p) {
  try { $c = (Get-CimInstance Win32_Process -Filter "ProcessId=$($p.Id)").CommandLine; if ($c -match '--type=([\w-]+)') { $Matches[1] } else { 'browser' } } catch { '?' }
}
$seen = @{}
$types = @{}
$deadline = (Get-Date).AddSeconds($TimeoutSec)
$started = $false
$goneSince = $null
while ((Get-Date) -lt $deadline) {
  $procs = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { try { $_.Path -eq $Exe } catch { $false } })
  if ($procs.Count) {
    $started = $true
    $goneSince = $null
    foreach ($p in $procs) {
      $t = TypeOf $p
      $types[$t] = $true
      try {
        foreach ($m in ($p.Modules | Where-Object { $_.ModuleName -ieq 'd3dcompiler_47.dll' })) {
          $key = "$t|$($m.FileName)"
          if (-not $seen.ContainsKey($key)) { $seen[$key] = [pscustomobject]@{ process = $t; path = $m.FileName; bundled = ($m.FileName -ieq $bundled); system = ($m.FileName -ieq $system); firstSeen = (Get-Date).ToString('o') } }
        }
      } catch { }
    }
  } elseif ($started) {
    if (-not $goneSince) { $goneSince = Get-Date }
    if (((Get-Date) - $goneSince).TotalSeconds -ge 5) { break }
  }
  Start-Sleep -Milliseconds 1000
}
$result = [pscustomobject]@{
  exe = $Exe
  appStarted = $started
  processTypes = @($types.Keys | Sort-Object)
  bundledCopy = Version $bundled
  bundledPending = Version "$bundled.terms-pending"
  systemCopy = Version $system
  loaded = @($seen.Values)
}
$result | ConvertTo-Json -Depth 5 | Set-Content -Encoding UTF8 $Out
exit 0
