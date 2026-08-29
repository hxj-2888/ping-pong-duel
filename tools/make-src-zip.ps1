# make-src-zip.ps1 — 纯源代码纯净压缩包（无任何二进制/密钥/生成产物/本地状态）
# 产物：ping-pong-duel_src_v<package.json 版本>.zip（项目根 + 桌面各一份）
#
# 排除原则：
#   1. 二进制分发物：*.apk（安装包）、*.zip
#   2. 密钥与敏感文件：release.keystore / *.jks / *.pem / *.key / .env*
#   3. 生成物与镜像：dist、%PKG%、build、obj、bin、android\assets（public 的同步镜像）、安装包暂存目录
#   4. 本地状态与缓存：.git、.wrangler、node_modules、node（浏览器内核）、app.log、records.json、tmp-*、test-out*
# 说明：robocopy 的相对路径排除(android\assets)实测不生效，故改为复制后显式删除；
#       打包用 .NET ZipFile（条目分隔符为 /，跨平台解压正常），不用 Compress-Archive（会写入 \）。
# 编码：本文件保存为 UTF-8 with BOM（PowerShell 5.1 否则按 ANSI 解析）
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem

$ROOT = Split-Path -Parent $PSScriptRoot
# package.json 是 UTF-8 无 BOM：必须显式按 UTF-8 读取，避免 PowerShell 5.1 按 ANSI 解析导致中文乱码
$pkgText = [System.IO.File]::ReadAllText((Join-Path $ROOT 'package.json'), [Text.Encoding]::UTF8)
if ($pkgText -match '"version"\s*:\s*"([\d.]+)"') { $ver = $Matches[1] } else { $ver = 'unknown' }

$stage = Join-Path $env:TEMP ('ppd_src_stage_v' + $ver)
$name = 'ping-pong-duel_src_v' + $ver + '.zip'
$out1 = Join-Path $ROOT $name
$out2 = Join-Path ([Environment]::GetFolderPath('Desktop')) $name

if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }

# 1) 复制（只排除纯目录名，robocopy 对这类排除 100% 生效）
robocopy $ROOT $stage /E /XD node .git dist '%PKG%' .wrangler node_modules build obj bin .vercel .collect-temp | Out-Null
if ($LASTEXITCODE -ge 8) { Write-Host ('ERR: robocopy 失败, 退出码 ' + $LASTEXITCODE); exit 1 }

# 2) 显式删除生成镜像 / 暂存目录
foreach ($d in @('android\assets', '乒乓对决_安装包')) {
  $t = Join-Path $stage $d
  if (Test-Path $t) { Remove-Item $t -Recurse -Force }
}

# 3) 按名称删除二进制、密钥与本地状态文件
$kill = @('*.apk', '*.keystore', '*.jks', '*.pem', '*.key', '*.zip', 'records.json', 'app.log', '*.log')
Get-ChildItem -Path $stage -Recurse -Force -File -Include $kill -ErrorAction SilentlyContinue |
  Remove-Item -Force -ErrorAction SilentlyContinue
Get-ChildItem -Path $stage -Recurse -Force -File -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -like 'tmp-*' -or $_.Name -like 'test-out*' -or $_.Name -like '.env*' } |
  Remove-Item -Force -ErrorAction SilentlyContinue

# 4) 打包（Deflate；逐个文件写入，条目名统一用 /，跨平台解压不会出现反斜杠文件名）
foreach ($o in @($out1, $out2)) {
  if (Test-Path $o) { Remove-Item $o -Force }
  $zip = [System.IO.Compression.ZipFile]::Open($o, 'Create')
  foreach ($f in (Get-ChildItem -Path $stage -Recurse -File -Force)) {
    $rel = $f.FullName.Substring($stage.Length).TrimStart('\', '/') -replace '\\', '/'
    [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $f.FullName, $rel, 'Optimal') | Out-Null
  }
  $zip.Dispose()
  Write-Host ('CREATED: ' + $o + '  (' + [math]::Round((Get-Item $o).Length / 1MB, 2) + ' MB)')
}
Remove-Item $stage -Recurse -Force
Write-Host 'SRC_ZIP_DONE'
