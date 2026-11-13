# First-start flow of the Microsoft d3dcompiler_47.dll terms on Windows (apps/desktop/src/main/windows-terms.ts),
# driven from outside like a person would: the app is started normally (not in a test mode), the
# system dialog is found with Windows' own UI Automation and its buttons are pressed.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File terms-flow.ps1 -Exe <Zeyvola.exe | electron.exe> [-AppArg <app folder>] -Out <folder>
#
# -AppArg is the app folder when -Exe is the development electron.exe. Every scenario uses its own
# throwaway settings folder (ZEYVOLA_TEST_HOME), never the user's. Scenarios:
#   decline   dialog shown before any window, d3dcompiler_47.dll not loaded meanwhile; "decline"
#             quits the app and nothing is recorded
#   accept    "accept" records the acceptance and the app starts again by itself, now with
#             hardware acceleration (the DLL is loaded) and without the dialog
#   accepted  a later start with the recorded acceptance: no dialog
#   no-dll    a copy of the app folder without the DLL: no dialog, the main window opens
# Not automated: "Read the terms" opens the text in another program; only the file is checked.
# Writes terms-flow.json to -Out. Exit code 0 when every scenario passed. ASCII only (PowerShell 5.1).
param(
  [Parameter(Mandatory = $true)][string]$Exe,
  [string]$AppArg,
  [Parameter(Mandatory = $true)][string]$Out
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$A = [System.Windows.Automation.AutomationElement]
$TreeScope = [System.Windows.Automation.TreeScope]

New-Item -ItemType Directory -Force -Path $Out | Out-Null
$Out = (Resolve-Path $Out).Path
$Exe = (Resolve-Path $Exe).Path
$results = @()

function AppProcesses([string]$exePath) {
  @(Get-Process -ErrorAction SilentlyContinue | Where-Object { try { $_.Path -eq $exePath } catch { $false } })
}
function StopApp([string]$exePath) {
  AppProcesses $exePath | ForEach-Object { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Milliseconds 800
}
function DllLoaded([string]$exePath) {
  foreach ($p in (AppProcesses $exePath)) {
    try { if ($p.Modules | Where-Object { $_.ModuleName -ieq 'd3dcompiler_47.dll' }) { return $true } } catch { }
  }
  return $false
}
# Top-level windows of the app's processes: dialogs (#32770) and app windows.
function AppWindows([string]$exePath) {
  $ids = @(AppProcesses $exePath | ForEach-Object { $_.Id })
  if ($ids.Count -eq 0) { return @() }
  $all = $A::RootElement.FindAll($TreeScope::Children, [System.Windows.Automation.Condition]::TrueCondition)
  @($all | Where-Object { $ids -contains $_.Current.ProcessId })
}
function WaitFor([scriptblock]$cond, [int]$seconds) {
  $deadline = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $deadline) { $v = & $cond; if ($v) { return $v }; Start-Sleep -Milliseconds 250 }
  return $null
}
function Dialog([string]$exePath) { AppWindows $exePath | Where-Object { $_.Current.ClassName -eq '#32770' } | Select-Object -First 1 }
function MainWindow([string]$exePath) { AppWindows $exePath | Where-Object { $_.Current.ClassName -ne '#32770' -and $_.Current.Name -match 'Zeyvola' } | Select-Object -First 1 }
function Buttons($dialog) {
  $cond = New-Object System.Windows.Automation.PropertyCondition($A::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)
  @($dialog.FindAll($TreeScope::Descendants, $cond))
}
function Press($button) {
  $button.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
}
# The dialog's buttons, waited for (the window can appear before its contents).
function WaitButtons($dialog) {
  $found = WaitFor { $b = Buttons $dialog; if ($b.Count -ge 3) { , $b } } 15
  if ($found) { return , $found }
  return , @()
}
# What UI Automation sees inside the dialog, for the log when the buttons are not found.
function DumpTree($dialog) {
  $all = $dialog.FindAll($TreeScope::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
  @($all | ForEach-Object { "{0}|{1}|{2}|{3}" -f $_.Current.ControlType.ProgrammaticName, $_.Current.ClassName, $_.Current.AutomationId, $_.Current.Name })
}
Add-Type -AssemblyName System.Windows.Forms
# Keyboard fallback, as a person would: the dialog's default button is "Read the terms" (index 1),
# Escape is its cancel button ("Decline", index 2), Shift+Tab from the default reaches "Accept".
function PressByKeys($dialog, [string]$which) {
  try { $dialog.SetFocus() } catch { }
  Start-Sleep -Milliseconds 300
  if ($which -eq 'decline') { [System.Windows.Forms.SendKeys]::SendWait('{ESC}') } else { [System.Windows.Forms.SendKeys]::SendWait('+{TAB}'); Start-Sleep -Milliseconds 200; [System.Windows.Forms.SendKeys]::SendWait(' ') }
}
function Answer($r, $dialog, [string]$which) {
  $btn = WaitButtons $dialog
  $r.buttons = @($btn | ForEach-Object { $_.Current.Name })
  if ($btn.Count -ge 3) { Press $btn[$(if ($which -eq 'decline') { 2 } else { 0 })]; $r.answeredBy = 'UI Automation'; return }
  $r.tree = DumpTree $dialog
  $r.notes += "dugme bulunamadi ($($btn.Count)); klavyeyle yanitlandi"
  PressByKeys $dialog $which
  $r.answeredBy = 'klavye'
}
function Start-App([string]$exePath, [string]$th) {
  $env:ZEYVOLA_TEST_HOME = $th
  $argList = @(); if ($AppArg) { $argList += '"' + $AppArg + '"' }
  if ($argList.Count) { Start-Process -FilePath $exePath -ArgumentList $argList -PassThru } else { Start-Process -FilePath $exePath -PassThru }
}
function StateFile([string]$th) { Join-Path $th 'userData\third-party-terms.json' }
function Shot([string]$name) {
  try {
    Add-Type -AssemblyName System.Windows.Forms, System.Drawing
    $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    $bmp = New-Object System.Drawing.Bitmap($b.Width, $b.Height)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
    $bmp.Save((Join-Path $Out "$name.png"), [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $bmp.Dispose()
  } catch { }
}
function Scenario([string]$name, [scriptblock]$body) {
  Write-Host "== $name"
  $r = [ordered]@{ scenario = $name; ok = $false; notes = @() }
  try { & $body $r } catch { $r.notes += "hata: $($_.Exception.Message)" }
  $script:results += $r
  Write-Host ("   {0} {1}" -f $(if ($r.ok) { 'OK ' } else { 'FAIL' }), ($r.notes -join ' | '))
}

$work = Join-Path ([System.IO.Path]::GetTempPath()) ("zeyvola-terms-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Force -Path $work | Out-Null
$dllPresent = Test-Path (Join-Path (Split-Path $Exe) 'd3dcompiler_47.dll')
StopApp $Exe

Scenario 'decline' {
  param($r)
  $th = Join-Path $work 'decline'
  $p = Start-App $Exe $th
  $d = WaitFor { Dialog $Exe } 45
  if (-not $d) { $r.notes += 'iletisim kutusu cikmadi'; Shot 'terms-decline-none'; return }
  $r.title = $d.Current.Name
  $r.windowsBeforeAnswer = @(AppWindows $Exe | ForEach-Object { "$($_.Current.ClassName)|$($_.Current.Name)" })
  $r.dllLoadedBeforeAnswer = DllLoaded $Exe
  Shot 'terms-dialog'
  Answer $r $d 'decline'
  $gone = WaitFor { if ((AppProcesses $Exe).Count -eq 0) { $true } } 20
  $r.exited = [bool]$gone
  $r.stateRecorded = Test-Path (StateFile $th)
  $r.ok = $r.exited -and -not $r.stateRecorded -and -not $r.dllLoadedBeforeAnswer -and @($r.windowsBeforeAnswer | Where-Object { -not $_.StartsWith('#32770|') }).Count -eq 0
  if ($r.dllLoadedBeforeAnswer) { $r.notes += 'DLL yanit verilmeden yuklendi' }
  StopApp $Exe
}

Scenario 'accept' {
  param($r)
  $th = Join-Path $work 'accept'
  $p = Start-App $Exe $th
  $d = WaitFor { Dialog $Exe } 45
  if (-not $d) { $r.notes += 'iletisim kutusu cikmadi'; return }
  $first = $p.Id
  $r.dllLoadedBeforeAnswer = DllLoaded $Exe
  Answer $r $d 'accept'
  $r.stateRecorded = [bool](WaitFor { Test-Path (StateFile $th) } 15)
  if ($r.stateRecorded) { $r.state = Get-Content (StateFile $th) -Raw | ConvertFrom-Json }
  # The app starts itself again (a new process) and opens its main window.
  $main = WaitFor { MainWindow $Exe } 60
  $r.relaunched = [bool]$main -and -not (Get-Process -Id $first -ErrorAction SilentlyContinue)
  $r.dialogAgain = [bool](Dialog $Exe)
  Start-Sleep -Seconds 3
  $r.dllLoadedAfter = DllLoaded $Exe
  Shot 'terms-after-accept'
  $r.ok = $r.stateRecorded -and $r.relaunched -and -not $r.dialogAgain -and $r.dllLoadedAfter -and -not $r.dllLoadedBeforeAnswer
  if (-not $r.dllLoadedAfter) { $r.notes += 'kabulden sonra DLL yuklu degil (donanim hizlandirma acik mi?)' }
  StopApp $Exe
  $script:acceptedHome = $th
}

Scenario 'accepted' {
  param($r)
  if (-not $script:acceptedHome) { $r.notes += 'accept senaryosu kaydi birakmadi'; return }
  $p = Start-App $Exe $script:acceptedHome
  $main = WaitFor { MainWindow $Exe } 60
  $r.mainWindow = [bool]$main
  $r.dialog = [bool](Dialog $Exe)
  $r.ok = $r.mainWindow -and -not $r.dialog
  StopApp $Exe
}

Scenario 'no-dll' {
  param($r)
  $copy = Join-Path $work 'app-without-dll'
  Copy-Item -Recurse -Path (Split-Path $Exe) -Destination $copy
  Remove-Item (Join-Path $copy 'd3dcompiler_47.dll') -ErrorAction SilentlyContinue
  $exe2 = Join-Path $copy (Split-Path $Exe -Leaf)
  $th = Join-Path $work 'no-dll'
  $p = Start-App $exe2 $th
  $main = WaitFor { MainWindow $exe2 } 60
  $r.mainWindow = [bool]$main
  $r.dialog = [bool](Dialog $exe2)
  $r.stateRecorded = Test-Path (StateFile $th)
  $r.ok = $r.mainWindow -and -not $r.dialog -and -not $r.stateRecorded
  StopApp $exe2
}

$termsFile = Get-ChildItem -Recurse -Path (Split-Path $Exe) -Filter 'MICROSOFT-D3DCOMPILER-TERMS.txt' -ErrorAction SilentlyContinue | Select-Object -First 1
$summary = [ordered]@{
  exe = Split-Path $Exe -Leaf
  dllInPackage = $dllPresent
  systemHasD3dcompiler47 = Test-Path (Join-Path $env:WINDIR 'System32\d3dcompiler_47.dll')
  termsFileInPackage = [bool]$termsFile
  notAutomated = 'Kosullari oku dugmesi metni baska bir programda acar; otomatik denenmedi'
  scenarios = $results
}
$json = $summary | ConvertTo-Json -Depth 6
$json | Set-Content -Encoding UTF8 (Join-Path $Out 'terms-flow.json')
Write-Host $json
Remove-Item Env:\ZEYVOLA_TEST_HOME -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
$failed = @($results | Where-Object { -not $_.ok }).Count
Write-Host "Kosullar akisi: $($results.Count - $failed)/$($results.Count) senaryo gecti"
exit $(if ($failed -eq 0) { 0 } else { 1 })
