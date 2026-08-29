# make-code-zip.ps1 - source-code-only zip: no website assets (images/audio/apk/icons), no personal info
# Output: ping-pong-duel_code_v<version>.zip on the Desktop
# NOTE: keep this file ASCII-only so PowerShell 5.1 parses it identically with or without BOM
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem

$ROOT = Split-Path -Parent $PSScriptRoot
$pkgText = [System.IO.File]::ReadAllText((Join-Path $ROOT 'package.json'), [Text.Encoding]::UTF8)
if ($pkgText -match '"version"\s*:\s*"([\d.]+)"') { $ver = $Matches[1] } else { $ver = 'unknown' }

$stage = Join-Path $env:TEMP ('ppd_code_stage_v' + $ver)
$name = 'ping-pong-duel_code_v' + $ver + '.zip'
$out = Join-Path ([Environment]::GetFolderPath('Desktop')) $name

if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }

# 1) copy, excluding binary assets and keys by extension
robocopy $ROOT $stage /E /XF *.png *.wav *.mp4 *.apk *.keystore *.jks *.key *.pem *.ico *.zip *.log records.json | Out-Null
if ($LASTEXITCODE -ge 8) { Write-Host ('ERR: robocopy failed, code ' + $LASTEXITCODE); exit 1 }

# 2) prune: keep only source directories (this also drops non-ASCII-named local folders)
$keepDirs = @('android', 'public', 'src', 'test', 'tools')
Get-ChildItem -Path $stage -Directory -Force |
  Where-Object { $keepDirs -notcontains $_.Name } | Remove-Item -Recurse -Force
Remove-Item (Join-Path $stage 'android\assets') -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item (Join-Path $stage 'tools\shots') -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item (Join-Path $stage 'tools\make-code-zip.ps1') -Force -ErrorAction SilentlyContinue

# 3) prune: at the root keep README/LICENSE and code/config files; drop the rest (records/reports contain personal info)
Get-ChildItem -Path $stage -File -Force | ForEach-Object {
  $isReadme = $_.Name -eq 'README.md'
  $isLicense = $_.Name -eq 'LICENSE'
  $isCodeExt = $_.Name -match '\.(js|json|toml|vbs|gitignore)$'
  if (-not ($isReadme -or $isLicense -or $isCodeExt)) { Remove-Item $_.FullName -Force }
}

# 4) verify: no binary resources and no personal info may remain in the stage
$leak = Get-ChildItem -Path $stage -Recurse -File -Force |
  Where-Object { $_.Name -match '\.(png|wav|mp4|apk|keystore|jks|key|pem|ico|zip|log)$' }
if ($leak) { Write-Host ('ERR: binary/resource files left: ' + ($leak.FullName -join ', ')); exit 1 }
$leakText = Get-ChildItem -Path $stage -Recurse -File -Force |
  Select-String -Pattern 'hexiangjie694|@gmail\.com'
if ($leakText) { Write-Host ('ERR: personal info found: ' + (($leakText | ForEach-Object { $_.Path + ':' + $_.LineNumber }) -join ', ')); exit 1 }

# 5) pack (.NET ZipFile; entry names use '/' separators)
if (Test-Path $out) { Remove-Item $out -Force }
$zip = [System.IO.Compression.ZipFile]::Open($out, 'Create')
foreach ($f in (Get-ChildItem -Path $stage -Recurse -File -Force)) {
  $rel = $f.FullName.Substring($stage.Length).TrimStart('\', '/') -replace '\\', '/'
  [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $f.FullName, $rel, 'Optimal') | Out-Null
}
$zip.Dispose()
Remove-Item $stage -Recurse -Force
Write-Host ('CREATED: ' + $out + '  (' + [math]::Round((Get-Item $out).Length / 1KB, 1) + ' KB)')
Write-Host 'CODE_ZIP_DONE'
