# Removes the SiteCloner shortcuts and its small app-window profile. Your clones are NOT deleted.
$ErrorActionPreference = 'SilentlyContinue'
Remove-Item -LiteralPath (Join-Path ([Environment]::GetFolderPath('Programs')) 'SiteCloner.lnk') -Force
Remove-Item -LiteralPath (Join-Path ([Environment]::GetFolderPath('Desktop')) 'SiteCloner.lnk') -Force
Remove-Item -LiteralPath (Join-Path $env:LOCALAPPDATA 'SiteCloner') -Recurse -Force
Write-Host 'Shortcuts removed. Clones in the clones folder were left alone.'
