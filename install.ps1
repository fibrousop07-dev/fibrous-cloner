# Installs SiteCloner as a Start-menu app (no admin needed). Add -Desktop for a desktop shortcut too.
param([switch]$Desktop)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

$node = (Get-Command node -ErrorAction Stop).Source
Write-Host "Using Node: $node"

& $node (Join-Path $here 'make-icon.mjs')
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
  $s.Description = 'SiteCloner - copy a website frontend and run it on localhost'
  $s.Save()
}

$start = Join-Path ([Environment]::GetFolderPath('Programs')) 'SiteCloner.lnk'
New-Shortcut $start
Write-Host "Start menu entry: $start"
if ($Desktop) {
  $d = Join-Path ([Environment]::GetFolderPath('Desktop')) 'SiteCloner.lnk'
  New-Shortcut $d
  Write-Host "Desktop shortcut: $d"
}
Write-Host 'Done. Press the Windows key and type "SiteCloner".'
