# Removes the fibrous-cloner shortcuts and its small app-window profile (also the pre-rename SiteCloner ones). Your clones are NOT deleted.
$ErrorActionPreference = 'SilentlyContinue'
foreach ($name in 'fibrous-cloner.lnk', 'Fibrous Sites.lnk', 'SiteCloner.lnk') {
  Remove-Item -LiteralPath (Join-Path ([Environment]::GetFolderPath('Programs')) $name) -Force
  Remove-Item -LiteralPath (Join-Path ([Environment]::GetFolderPath('Desktop')) $name) -Force
}
foreach ($state in 'FibrousSites', 'SiteCloner') { Remove-Item -LiteralPath (Join-Path $env:LOCALAPPDATA $state) -Recurse -Force }
Write-Host 'Shortcuts removed. Clones in the clones folder were left alone.'
