# Click driver for the real screen recording test on Windows (CI): while the app's interface test
# records the main display (testing/uitest.ts, ZEYVOLA_TEST_REAL_CAPTURE=1), this script moves the
# mouse and clicks at known places, so the recording's cursor log can be checked against it.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File windows-clicks.ps1 -SignalDir <folder> [-TimeoutSec 900]
#
# The app leaves "recording" in -SignalDir once the recording runs and "stopped" when it ends; this
# script writes clicks.json there (where it clicked, as fractions of the primary display). It only
# uses Windows' own user32 functions (SetCursorPos, mouse_event); nothing is installed. The places
# are on the empty desktop (the app minimizes its window while it records the display), away from
# the taskbar. This file stays ASCII so Windows PowerShell 5.1 reads it.
param(
  [Parameter(Mandatory = $true)][string]$SignalDir,
  [int]$TimeoutSec = 900
)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ZeyvolaMouse {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(int flags, int dx, int dy, int data, IntPtr extra);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, int flags, IntPtr extra);
}
'@
[void][ZeyvolaMouse]::SetProcessDPIAware()  # physical pixels, like the app's pointer helper
$w = [ZeyvolaMouse]::GetSystemMetrics(0)
$h = [ZeyvolaMouse]::GetSystemMetrics(1)
$started = Join-Path $SignalDir 'recording'
$stopped = Join-Path $SignalDir 'stopped'
$deadline = (Get-Date).AddSeconds($TimeoutSec)
while (-not (Test-Path $started)) {
  if ((Get-Date) -gt $deadline) { Write-Host 'windows-clicks: kayit baslamadi'; exit 1 }
  Start-Sleep -Milliseconds 100
}
Start-Sleep -Milliseconds 300
# left down/up 0x2/0x4, right down/up 0x8/0x10
$plan = @(
  @{ fx = 0.25; fy = 0.30; b = 'l' }, @{ fx = 0.75; fy = 0.30; b = 'l' }, @{ fx = 0.50; fy = 0.50; b = 'r' },
  @{ fx = 0.25; fy = 0.65; b = 'l' }, @{ fx = 0.75; fy = 0.65; b = 'l' }
)
$clicks = @()
foreach ($c in $plan) {
  if (Test-Path $stopped) { break }
  $x = [int]($c.fx * $w); $y = [int]($c.fy * $h)
  [void][ZeyvolaMouse]::SetCursorPos($x, $y)
  Start-Sleep -Milliseconds 150
  $down = if ($c.b -eq 'r') { 0x8 } else { 0x2 }
  [ZeyvolaMouse]::mouse_event($down, 0, 0, 0, [IntPtr]::Zero)
  $at = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  Start-Sleep -Milliseconds 60
  [ZeyvolaMouse]::mouse_event($down * 2, 0, 0, 0, [IntPtr]::Zero)
  $clicks += [ordered]@{ fx = $x / $w; fy = $y / $h; button = $c.b; epochMs = $at }
  Start-Sleep -Milliseconds 600
}
# Escape closes the desktop menu the right click may have opened (key up flag 0x2).
[ZeyvolaMouse]::keybd_event(0x1B, 0, 0, [IntPtr]::Zero)
[ZeyvolaMouse]::keybd_event(0x1B, 0, 0x2, [IntPtr]::Zero)
$json = [ordered]@{ screen = @{ width = $w; height = $h }; clicks = $clicks } | ConvertTo-Json -Depth 4 -Compress
[System.IO.File]::WriteAllText((Join-Path $SignalDir 'clicks.json'), $json, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "windows-clicks: $($clicks.Count) tiklama ($w x $h)"
exit 0
