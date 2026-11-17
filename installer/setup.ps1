# fibrous-cloner installer logic. Runs from the self-extracting setup.exe (payload.zip sits beside this file).
# Per-user install: no admin rights needed. Migrates a pre-rename SiteCloner install if one is found.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
$here    = Split-Path -Parent $MyInvocation.MyCommand.Path
$version = (Get-Content (Join-Path $here 'version.txt') -Raw).Trim()
$dir     = Join-Path $env:LOCALAPPDATA 'Programs\FibrousSites'
$oldDir  = Join-Path $env:LOCALAPPDATA 'Programs\SiteCloner'
$docs    = [Environment]::GetFolderPath('MyDocuments')
$clones  = Join-Path $docs 'FibrousSites\clones'
$oldClones = Join-Path $docs 'SiteCloner\clones'
# keep using the old clones folder if that is where the user's clones already are
if (-not (Test-Path $clones) -and (Test-Path $oldClones)) { $clones = $oldClones }
$uninstKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall'

try {
  # stop a running copy (new or pre-rename install) so its files can be replaced
  Get-Process node -ErrorAction SilentlyContinue | Where-Object { $_.Path -and ($_.Path -like "$dir*" -or $_.Path -like "$oldDir*") } | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 400
  if (Test-Path $dir) { Remove-Item $dir -Recurse -Force }

  # remove the pre-rename SiteCloner install (program files, shortcuts, Apps entry); clones are left alone
  if (Test-Path $oldDir) { Remove-Item $oldDir -Recurse -Force -ErrorAction SilentlyContinue }
  foreach ($f in 'Programs', 'Desktop') { Remove-Item (Join-Path ([Environment]::GetFolderPath($f)) 'SiteCloner.lnk') -Force -ErrorAction SilentlyContinue }
  Remove-Item (Join-Path $uninstKey 'SiteCloner') -Recurse -Force -ErrorAction SilentlyContinue

  New-Item -ItemType Directory -Force $dir | Out-Null
  Expand-Archive -LiteralPath (Join-Path $here 'payload.zip') -DestinationPath $dir -Force
  New-Item -ItemType Directory -Force $clones | Out-Null

  # silent launcher: bundled Node, no console window; clones live in Documents, not the install folder
  $node = Join-Path $dir 'runtime\node.exe'
  $app  = Join-Path $dir 'app.mjs'
  $vbs  = @(
    'Set sh = CreateObject("WScript.Shell")',
    ('sh.Environment("Process")("FIBROUS_SITES_CLONES") = "' + $clones + '"'),
    ('sh.Run """' + $node + '"" ""' + $app + '""", 0, False')
  ) -join "`r`n"
  Set-Content -LiteralPath (Join-Path $dir 'launch.vbs') -Value $vbs -Encoding ASCII
  Set-Content -LiteralPath (Join-Path $dir 'clones-path.txt') -Value $clones -Encoding UTF8

foreach ($legacyFolder in 'Programs','Desktop') { Remove-Item -LiteralPath (Join-Path ([Environment]::GetFolderPath($legacyFolder)) 'Fibrous Sites.lnk') -Force -ErrorAction SilentlyContinue }
  $ws = New-Object -ComObject WScript.Shell
  function New-Shortcut($path) {
    $s = $ws.CreateShortcut($path)
    $s.TargetPath = Join-Path $env:WINDIR 'System32\wscript.exe'
    $s.Arguments = '//B //Nologo "' + (Join-Path $dir 'launch.vbs') + '"'
    $s.WorkingDirectory = $dir
    $s.IconLocation = (Join-Path $dir 'icon.ico') + ',0'
    $s.Description = 'fibrous-cloner - copy a website frontend and run it on localhost'
    $s.Save()
  }
  New-Shortcut (Join-Path ([Environment]::GetFolderPath('Programs')) 'fibrous-cloner.lnk')
  New-Shortcut (Join-Path ([Environment]::GetFolderPath('Desktop')) 'fibrous-cloner.lnk')

  # Apps & features entry
  $key = Join-Path $uninstKey 'FibrousSites'
  New-Item -Path $key -Force | Out-Null
  $size = [int]((Get-ChildItem $dir -Recurse -File | Measure-Object Length -Sum).Sum / 1KB)
  $props = [ordered]@{
    DisplayName = 'fibrous-cloner'; DisplayVersion = $version; Publisher = 'fibrous-cloner'
    InstallLocation = $dir; DisplayIcon = (Join-Path $dir 'icon.ico')
    UninstallString = ('powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + (Join-Path $dir 'uninstall.ps1') + '"')
    NoModify = 1; NoRepair = 1; EstimatedSize = $size
  }
  foreach ($k in $props.Keys) {
    $t = if ($props[$k] -is [int]) { 'DWord' } else { 'String' }
    New-ItemProperty -Path $key -Name $k -Value $props[$k] -PropertyType $t -Force | Out-Null
  }

  $msg = "fibrous-cloner $version is installed.`n`nYour clones are saved in:`n$clones`n`nOpen fibrous-cloner now?"
  $r = [System.Windows.Forms.MessageBox]::Show($msg, 'fibrous-cloner Setup', 'YesNo', 'Information')
  if ($r -eq 'Yes') { Start-Process (Join-Path $env:WINDIR 'System32\wscript.exe') -ArgumentList ('//B //Nologo "' + (Join-Path $dir 'launch.vbs') + '"') }
} catch {
  [void][System.Windows.Forms.MessageBox]::Show(("Setup failed:`n`n" + $_.Exception.Message), 'fibrous-cloner Setup', 'OK', 'Error')
  exit 1
}
