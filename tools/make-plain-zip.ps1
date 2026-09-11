# make-plain-zip.ps1 — build the desktop distribution zip (Compress-Archive, Deflate).
# No Chinese literals in this file (PowerShell 5.1 reads UTF-8-no-BOM as ANSI);
# the Chinese package folder name is discovered at runtime.
#
# Source: the repo-root staging folder that has BOTH game/ and node/ subfolders
#         (i.e. <repo>/乒乓对决_安装包). Version comes from package.json.
# Output: <pkg>_v<version>.zip on the Desktop and in dist/installer/.
#
# Excluded from the zip:
#   - records.json : per-user career data (never redistribute)
#   - app.log      : runtime log
#   - *.zip        : stale archives of earlier releases that accumulated in game/
$ErrorActionPreference = 'Stop'
$ROOT = Split-Path -Parent $PSScriptRoot

# Discover the staging folder: must contain game/ and node/, and must not be an installed copy.
$pkgDir = Get-ChildItem $ROOT -Directory |
  Where-Object { (Test-Path (Join-Path $_.FullName 'game')) -and (Test-Path (Join-Path $_.FullName 'node')) } |
  Select-Object -First 1
if (-not $pkgDir) { Write-Host 'ERR: package dir not found (need a repo-root folder with game/ and node/)'; exit 1 }
$src = $pkgDir.FullName

# Version is a single source of truth: package.json
$pkgText = [System.IO.File]::ReadAllText((Join-Path $ROOT 'package.json'), [Text.Encoding]::UTF8)
if ($pkgText -match '"version"\s*:\s*"([0-9.]+)"') { $ver = $Matches[1] } else { $ver = 'unknown' }

$name = $pkgDir.Name + '_v' + $ver + '.zip'
$outDir = Join-Path $ROOT 'dist\installer'
New-Item -ItemType Directory -Force $outDir | Out-Null
$out1 = Join-Path $outDir $name
$out2 = Join-Path ([Environment]::GetFolderPath('Desktop')) $name

$stage = Join-Path $env:TEMP ('ppd_zip_stage_v' + $ver)
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item $stage -ItemType Directory | Out-Null
Copy-Item (Join-Path $src '*') $stage -Recurse -Force

# Drop per-user state, logs and stale release archives
Get-ChildItem -Path $stage -Recurse -Force -Include 'records.json', 'app.log' |
  Remove-Item -Force -ErrorAction SilentlyContinue
Get-ChildItem -Path $stage -Recurse -Force -Filter '*.zip' |
  Remove-Item -Force -ErrorAction SilentlyContinue

foreach ($o in @($out1, $out2)) {
  if (Test-Path $o) { Remove-Item $o -Force }
  Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $o -CompressionLevel Optimal
  Write-Host ('CREATED: ' + $o + '  (' + [math]::Round((Get-Item $o).Length/1MB,1) + ' MB)')
}
Remove-Item $stage -Recurse -Force
Write-Host 'PLAIN_ZIP_DONE'
