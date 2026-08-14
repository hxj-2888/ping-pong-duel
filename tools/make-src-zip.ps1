# make-src-zip.ps1 — 只合成项目文件的标准 zip（不含浏览器内核 node/、构建产物、缓存、用户数据）
# robocopy 复制项目根（排除目录/文件）到暂存 → Compress-Archive 合成标准 zip（Deflate, UTF-8 文件名）。
$ErrorActionPreference = 'Stop'
$ROOT = Split-Path -Parent $PSScriptRoot
$stage = Join-Path $env:TEMP 'ppd_src_stage_v21'
$name = '乒乓对决_项目文件_v2.1.zip'
$out1 = Join-Path $ROOT $name
$out2 = Join-Path ([Environment]::GetFolderPath('Desktop')) $name

# 复制项目文件：排除 浏览器内核(node/)、版本历史(.git)、构建产物(dist/ %PKG%/ build 目录)、
# Cloudflare 缓存(.wrangler)、依赖(node_modules)、历史 zip 自身、调试临时文件(tmp-*)、
# 用户数据(app.log records.json)。
# 注意 /XD 用纯目录名(如 build)匹配任意层级；/XF 支持通配符。
robocopy $ROOT $stage /E /XD node .git dist '%PKG%' .wrangler node_modules build /XF app.log records.json tmp-* *.zip | Out-Null
if ($LASTEXITCODE -ge 8) { Write-Host ('ERR: robocopy 失败, 退出码 ' + $LASTEXITCODE); exit 1 }

foreach ($o in @($out1, $out2)) {
  if (Test-Path $o) { Remove-Item $o -Force }
  # Compress-Archive: 标准 Deflate zip, UTF-8 文件名(中文跨平台解压不乱码)
  Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $o -CompressionLevel Optimal
  Write-Host ('CREATED: ' + $o + '  (' + [math]::Round((Get-Item $o).Length/1MB,1) + ' MB)')
}
Remove-Item $stage -Recurse -Force
Write-Host 'SRC_ZIP_DONE'
