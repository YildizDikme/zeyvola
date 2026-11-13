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
# A known shape on top of everything while the display is recorded: a 240 x 240 px magenta square
# on black, in the middle of the screen. The test measures its proportions in the video, so a picture
# squeezed or stretched by the recording shows.
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$size = 240
$form = New-Object System.Windows.Forms.Form
$form.FormBorderStyle = 'None'; $form.TopMost = $true; $form.ShowInTaskbar = $false; $form.StartPosition = 'Manual'
$form.BackColor = [System.Drawing.Color]::Black
$form.Bounds = New-Object System.Drawing.Rectangle([int](($w - $size - 40) / 2), [int](($h - $size - 40) / 2), ($size + 40), ($size + 40))
$panel = New-Object System.Windows.Forms.Panel
$panel.BackColor = [System.Drawing.Color]::FromArgb(255, 255, 0, 255)
$panel.Bounds = New-Object System.Drawing.Rectangle(20, 20, $size, $size)
$form.Controls.Add($panel)
$form.Show()
$shapeAt = $form.PointToScreen($panel.Location)
function Pump([int]$ms) { $end = (Get-Date).AddMilliseconds($ms); while ((Get-Date) -lt $end) { [System.Windows.Forms.Application]::DoEvents(); Start-Sleep -Milliseconds 15 } }
Pump 500
# Is the square really on the screen? Mean colour of its middle, read back from the screen.
function ScreenColor {
  try {
    $b = New-Object System.Drawing.Bitmap(40, 40)
    $g = [System.Drawing.Graphics]::FromImage($b)
    $g.CopyFromScreen($shapeAt.X + $size / 2 - 20, $shapeAt.Y + $size / 2 - 20, 0, 0, $b.Size)
    $r = 0; $gg = 0; $bb = 0
    for ($y = 0; $y -lt 40; $y += 4) { for ($x = 0; $x -lt 40; $x += 4) { $c = $b.GetPixel($x, $y); $r += $c.R; $gg += $c.G; $bb += $c.B } }
    $g.Dispose(); $b.Dispose()
    return @([int]($r / 100), [int]($gg / 100), [int]($bb / 100))
  } catch { return "okunamadi: $($_.Exception.Message)" }
}
$screenColor = ScreenColor
# The whole screen as the driver sees it (with the square), small: a 320 px wide JPEG (quality 60)
# in screen-shot.json, so the CI log can show it next to the recorded frame (uitest.ts). A failure
# here only leaves a note in the file.
function ScreenShot {
  try {
    $full = New-Object System.Drawing.Bitmap($w, $h)
    $g = [System.Drawing.Graphics]::FromImage($full)
    $g.CopyFromScreen(0, 0, 0, 0, $full.Size)
    $g.Dispose()
    $sw = 320; $sh = [int]($h * 320 / $w)
    $small = New-Object System.Drawing.Bitmap($sw, $sh)
    $g = [System.Drawing.Graphics]::FromImage($small)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBilinear
    $g.DrawImage($full, 0, 0, $sw, $sh)
    $g.Dispose(); $full.Dispose()
    $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
    $ep = New-Object System.Drawing.Imaging.EncoderParameters(1)
    $ep.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]60)
    $ms = New-Object System.IO.MemoryStream
    $small.Save($ms, $codec, $ep)
    $small.Dispose()
    $b64 = [Convert]::ToBase64String($ms.ToArray())
    $ms.Dispose()
    $json = [ordered]@{ width = $sw; height = $sh; screenWidth = $w; screenHeight = $h; at = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); jpeg = $b64 } | ConvertTo-Json -Compress
  } catch {
    $json = [ordered]@{ error = "$($_.Exception.Message)" } | ConvertTo-Json -Compress
  }
  [System.IO.File]::WriteAllText((Join-Path $SignalDir 'screen-shot.json'), $json, (New-Object System.Text.UTF8Encoding($false)))
}
ScreenShot
$formVisible = $form.Visible
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
  Pump 150
  $down = if ($c.b -eq 'r') { 0x8 } else { 0x2 }
  [ZeyvolaMouse]::mouse_event($down, 0, 0, 0, [IntPtr]::Zero)
  $at = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  Pump 60
  [ZeyvolaMouse]::mouse_event($down * 2, 0, 0, 0, [IntPtr]::Zero)
  $clicks += [ordered]@{ fx = $x / $w; fy = $y / $h; button = $c.b; epochMs = $at }
  Pump 600
}
# Escape closes the desktop menu the right click may have opened (key up flag 0x2).
[ZeyvolaMouse]::keybd_event(0x1B, 0, 0, [IntPtr]::Zero)
[ZeyvolaMouse]::keybd_event(0x1B, 0, 0x2, [IntPtr]::Zero)
# Keep the square up until the recording ends.
$deadline2 = (Get-Date).AddSeconds(20)
while (-not (Test-Path $stopped) -and (Get-Date) -lt $deadline2) { Pump 200 }
$form.Close()
$shape = [ordered]@{ x = $shapeAt.X; y = $shapeAt.Y; size = $size; fx = $shapeAt.X / $w; fy = $shapeAt.Y / $h; fw = $size / $w; fh = $size / $h; screenColor = $screenColor; formVisible = $formVisible }
$json = [ordered]@{ screen = @{ width = $w; height = $h }; clicks = $clicks; shape = $shape } | ConvertTo-Json -Depth 4 -Compress
[System.IO.File]::WriteAllText((Join-Path $SignalDir 'clicks.json'), $json, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "windows-clicks: $($clicks.Count) tiklama ($w x $h)"
exit 0
