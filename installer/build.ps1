# Builds dist\SiteCloner-Setup.exe with IExpress (built into Windows). Bundles the Node runtime found on PATH.
$ErrorActionPreference = 'Stop'
$root  = Split-Path -Parent $PSScriptRoot
$dist  = Join-Path $root 'dist'
$stage = Join-Path $env:TEMP ('sc-stage-' + [guid]::NewGuid().ToString('N'))
$ver   = (Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
$node  = (Get-Command node -ErrorAction Stop).Source

$app = Join-Path $stage 'app'
New-Item -ItemType Directory -Force $app, (Join-Path $app 'runtime'), $dist | Out-Null
foreach ($f in 'sitecloner.mjs','ui.mjs','app.mjs','icon.ico','icon.png','package.json','README.md') { Copy-Item (Join-Path $root $f) $app }
Copy-Item (Join-Path $PSScriptRoot 'uninstall.ps1') $app
Copy-Item $node (Join-Path $app 'runtime\node.exe')
Compress-Archive -Path (Join-Path $app '*') -DestinationPath (Join-Path $stage 'payload.zip') -CompressionLevel Optimal
Copy-Item (Join-Path $PSScriptRoot 'setup.ps1') $stage
Set-Content (Join-Path $stage 'version.txt') $ver -Encoding ASCII
Set-Content (Join-Path $stage 'setup.cmd') '@powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0setup.ps1"' -Encoding ASCII

$out = Join-Path $dist 'SiteCloner-Setup.exe'
Remove-Item $out -Force -ErrorAction SilentlyContinue
$sed = @"
[Version]
Class=IEXPRESS
SEDVersion=3
[Options]
PackagePurpose=InstallApp
ShowInstallProgramWindow=0
HideExtractAnimation=1
UseLongFileName=1
InsideCompressed=0
CAB_FixedSize=0
CAB_ResvCodeSigning=0
RebootMode=N
InstallPrompt=
DisplayLicense=
FinishMessage=
TargetName=$out
FriendlyName=SiteCloner Setup
AppLaunched=setup.cmd
PostInstallCmd=<None>
AdminQuietInstCmd=
UserQuietInstCmd=
SourceFiles=SourceFiles
[Strings]
FILE0="setup.cmd"
FILE1="setup.ps1"
FILE2="payload.zip"
FILE3="version.txt"
[SourceFiles]
SourceFiles0=$stage\
[SourceFiles0]
%FILE0%=
%FILE1%=
%FILE2%=
%FILE3%=
"@
$sedPath = Join-Path $stage 'build.sed'
Set-Content $sedPath $sed -Encoding ASCII
& iexpress.exe /N /Q $sedPath | Out-Null
# IExpress hands off to a child process, so wait until the file appears and stops growing
$last = -1
for ($i = 0; $i -lt 240; $i++) {
  Start-Sleep -Milliseconds 500
  if (Test-Path $out) { $n = (Get-Item $out).Length; if ($n -gt 0 -and $n -eq $last) { break }; $last = $n }
}
if (-not (Test-Path $out)) { throw 'IExpress did not produce the installer' }
Remove-Item $stage -Recurse -Force
'{0}  ({1:N1} MB)' -f $out, ((Get-Item $out).Length / 1MB)
