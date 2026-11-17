# fibrous-cloner uninstaller (installed copy). Also removes leftovers of a pre-rename SiteCloner install. Your clones are never deleted.
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Windows.Forms
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$clones = "$(Get-Content (Join-Path $dir 'clones-path.txt') -Raw)".Trim()
if (-not $clones) { $clones = Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'FibrousSites\clones' }
$r = [System.Windows.Forms.MessageBox]::Show("Remove fibrous-cloner?`n`nYour clones in`n$clones`nwill be kept.", 'fibrous-cloner Uninstall', 'YesNo', 'Question')
if ($r -ne 'Yes') { exit 0 }
$oldDir = Join-Path $env:LOCALAPPDATA 'Programs\SiteCloner'
Get-Process node | Where-Object { $_.Path -and ($_.Path -like "$dir*" -or $_.Path -like "$oldDir*") } | Stop-Process -Force
foreach ($name in 'fibrous-cloner.lnk', 'Fibrous Sites.lnk', 'SiteCloner.lnk') {
  Remove-Item (Join-Path ([Environment]::GetFolderPath('Programs')) $name) -Force
  Remove-Item (Join-Path ([Environment]::GetFolderPath('Desktop')) $name) -Force
}
foreach ($state in 'FibrousSites', 'SiteCloner') { Remove-Item (Join-Path $env:LOCALAPPDATA $state) -Recurse -Force }
foreach ($k in 'FibrousSites', 'SiteCloner') { Remove-Item ('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\' + $k) -Recurse -Force }
if ((Test-Path $oldDir) -and ($oldDir -ne $dir)) { Remove-Item $oldDir -Recurse -Force }
# this script lives in the folder being removed, so delete it from a detached helper after we exit
Start-Process cmd.exe -WindowStyle Hidden -ArgumentList ('/c ping -n 3 127.0.0.1 >nul & rmdir /s /q "' + $dir + '"')
[void][System.Windows.Forms.MessageBox]::Show('fibrous-cloner was removed. Your clones were left in place.', 'fibrous-cloner Uninstall', 'OK', 'Information')
