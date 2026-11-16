# SiteCloner uninstaller (installed copy). Your clones are never deleted.
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Windows.Forms
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$clones = Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'SiteCloner\clones'
$r = [System.Windows.Forms.MessageBox]::Show("Remove SiteCloner?`n`nYour clones in`n$clones`nwill be kept.", 'SiteCloner Uninstall', 'YesNo', 'Question')
if ($r -ne 'Yes') { exit 0 }
Get-Process node | Where-Object { $_.Path -and $_.Path -like "$dir*" } | Stop-Process -Force
Remove-Item (Join-Path ([Environment]::GetFolderPath('Programs')) 'SiteCloner.lnk') -Force
Remove-Item (Join-Path ([Environment]::GetFolderPath('Desktop')) 'SiteCloner.lnk') -Force
Remove-Item (Join-Path $env:LOCALAPPDATA 'SiteCloner') -Recurse -Force
Remove-Item 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\SiteCloner' -Recurse -Force
# this script lives in the folder being removed, so delete it from a detached helper after we exit
Start-Process cmd.exe -WindowStyle Hidden -ArgumentList ('/c ping -n 3 127.0.0.1 >nul & rmdir /s /q "' + $dir + '"')
[void][System.Windows.Forms.MessageBox]::Show('SiteCloner was removed. Your clones were left in place.', 'SiteCloner Uninstall', 'OK', 'Information')
