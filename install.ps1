# Installs fibrous-cloner as a Start-menu app (no admin needed). Add -Desktop for a desktop shortcut too.
param([switch]$Desktop)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

$node = (Get-Command node -ErrorAction Stop).Source
Write-Host "Using Node: $node"

& $node (Join-Path $here 'scripts\make-icon.mjs')
if ($LASTEXITCODE -ne 0) { throw 'icon generation failed' }

# silent launcher: wscript runs node with no console window
$vbs = Join-Path $here 'launch.vbs'
$line = 'CreateObject("WScript.Shell").Run """' + $node + '"" ""' + (Join-Path $here 'app.mjs') + '""", 0, False'
Set-Content -LiteralPath $vbs -Value $line -Encoding ASCII

function New-Shortcut($path) {
  $ws = New-Object -ComObject WScript.Shell
  $s = $ws.CreateShortcut($path)
  $s.TargetPath = Join-Path $env:WINDIR 'System32\wscript.exe'
  $s.Arguments = '//B //Nologo "' + $vbs + '"'
  $s.WorkingDirectory = $here
  $s.IconLocation = (Join-Path $here 'icon.ico') + ',0'
  $s.Description = 'fibrous-cloner - copy a website frontend and run it on localhost'
  $s.Save()
}

# drop shortcuts left by the pre-rename (SiteCloner) install
foreach ($f in 'Programs','Desktop') { Remove-Item -LiteralPath (Join-Path ([Environment]::GetFolderPath($f)) 'SiteCloner.lnk') -Force -ErrorAction SilentlyContinue }

foreach ($legacyFolder in 'Programs','Desktop') { Remove-Item -LiteralPath (Join-Path ([Environment]::GetFolderPath($legacyFolder)) 'Fibrous Sites.lnk') -Force -ErrorAction SilentlyContinue }
$start = Join-Path ([Environment]::GetFolderPath('Programs')) 'fibrous-cloner.lnk'
New-Shortcut $start
Write-Host "Start menu entry: $start"
if ($Desktop) {
  $d = Join-Path ([Environment]::GetFolderPath('Desktop')) 'fibrous-cloner.lnk'
  New-Shortcut $d
  Write-Host "Desktop shortcut: $d"
}
Write-Host 'Done. Press the Windows key and type "fibrous-cloner".'
