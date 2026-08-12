# make-plain-zip.ps1 — build a plain/standard zip (PowerShell Compress-Archive, Deflate).
# No Chinese literals in this file (PowerShell 5.1 reads UTF-8-no-BOM as ANSI);
# the Chinese folder name is taken from the directory at runtime.
$ErrorActionPreference = 'Stop'
$ROOT = Split-Path -Parent $PSScriptRoot
$pkgDir = Get-ChildItem (Join-Path $ROOT 'dist\installer\package') -Directory | Select-Object -First 1
if (-not $pkgDir) { Write-Host 'ERR: package dir not found'; exit 1 }
$src = $pkgDir.FullName
$name = $pkgDir.Name + '_v1.7.1.zip'
$out1 = Join-Path $ROOT (Join-Path 'dist\installer' $name)
$out2 = Join-Path ([Environment]::GetFolderPath('Desktop')) $name
$stage = Join-Path $env:TEMP 'ppd_zip_stage_v171'

if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item $stage -ItemType Directory | Out-Null
Copy-Item (Join-Path $src '*') $stage -Recurse -Force
Get-ChildItem -Path $stage -Recurse -Force -Include 'records.json','app.log' |
  Remove-Item -Force -ErrorAction SilentlyContinue

foreach ($o in @($out1, $out2)) {
  if (Test-Path $o) { Remove-Item $o -Force }
  Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $o -CompressionLevel Optimal
  Write-Host ('CREATED: ' + $o + '  (' + [math]::Round((Get-Item $o).Length/1MB,1) + ' MB)')
}
Remove-Item $stage -Recurse -Force
Write-Host 'PLAIN_ZIP_DONE'
