# SiteCloner installer logic. Runs from the self-extracting setup.exe (payload.zip sits beside this file).
# Per-user install: no admin rights needed.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
$here    = Split-Path -Parent $MyInvocation.MyCommand.Path
$version = (Get-Content (Join-Path $here 'version.txt') -Raw).Trim()
$dir     = Join-Path $env:LOCALAPPDATA 'Programs\SiteCloner'
$clones  = Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'SiteCloner\clones'

try {
  # stop a running copy so its files can be replaced
  Get-Process node -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path -like "$dir*" } | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 400
  if (Test-Path $dir) { Remove-Item $dir -Recurse -Force }
  New-Item -ItemType Directory -Force $dir | Out-Null
  Expand-Archive -LiteralPath (Join-Path $here 'payload.zip') -DestinationPath $dir -Force
  New-Item -ItemType Directory -Force $clones | Out-Null

  # silent launcher: bundled Node, no console window; clones live in Documents, not the install folder
  $node = Join-Path $dir 'runtime\node.exe'
  $app  = Join-Path $dir 'app.mjs'
  $vbs  = @(
    'Set sh = CreateObject("WScript.Shell")',
    ('sh.Environment("Process")("SITECLONER_CLONES") = "' + $clones + '"'),
    ('sh.Run """' + $node + '"" ""' + $app + '""", 0, False')
  ) -join "`r`n"
  Set-Content -LiteralPath (Join-Path $dir 'launch.vbs') -Value $vbs -Encoding ASCII

  $ws = New-Object -ComObject WScript.Shell
  function New-Shortcut($path) {
    $s = $ws.CreateShortcut($path)
    $s.TargetPath = Join-Path $env:WINDIR 'System32\wscript.exe'
    $s.Arguments = '//B //Nologo "' + (Join-Path $dir 'launch.vbs') + '"'
    $s.WorkingDirectory = $dir
    $s.IconLocation = (Join-Path $dir 'icon.ico') + ',0'
    $s.Description = 'SiteCloner - copy a website frontend and run it on localhost'
    $s.Save()
  }
  New-Shortcut (Join-Path ([Environment]::GetFolderPath('Programs')) 'SiteCloner.lnk')
  New-Shortcut (Join-Path ([Environment]::GetFolderPath('Desktop')) 'SiteCloner.lnk')

  # Apps & features entry
  $key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\SiteCloner'
  New-Item -Path $key -Force | Out-Null
  $size = [int]((Get-ChildItem $dir -Recurse -File | Measure-Object Length -Sum).Sum / 1KB)
  $props = [ordered]@{
    DisplayName = 'SiteCloner'; DisplayVersion = $version; Publisher = 'SiteCloner'
    InstallLocation = $dir; DisplayIcon = (Join-Path $dir 'icon.ico')
    UninstallString = ('powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + (Join-Path $dir 'uninstall.ps1') + '"')
    NoModify = 1; NoRepair = 1; EstimatedSize = $size
  }
  foreach ($k in $props.Keys) {
    $t = if ($props[$k] -is [int]) { 'DWord' } else { 'String' }
    New-ItemProperty -Path $key -Name $k -Value $props[$k] -PropertyType $t -Force | Out-Null
  }

  $msg = "SiteCloner $version is installed.`n`nYour clones are saved in:`n$clones`n`nOpen SiteCloner now?"
  $r = [System.Windows.Forms.MessageBox]::Show($msg, 'SiteCloner Setup', 'YesNo', 'Information')
  if ($r -eq 'Yes') { Start-Process (Join-Path $env:WINDIR 'System32\wscript.exe') -ArgumentList ('//B //Nologo "' + (Join-Path $dir 'launch.vbs') + '"') }
} catch {
  [void][System.Windows.Forms.MessageBox]::Show(("Setup failed:`n`n" + $_.Exception.Message), 'SiteCloner Setup', 'OK', 'Error')
  exit 1
}
