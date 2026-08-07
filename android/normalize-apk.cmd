@echo off
rem normalize-apk.cmd - fix aapt2 Windows backslash asset entries -> forward slashes
setlocal
set "SRC=%~1"
set "DST=%~2"
powershell -NoProfile -Command "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; $zr=[System.IO.Compression.ZipFile]::OpenRead('%SRC%'); $zw=[System.IO.Compression.ZipFile]::Open('%DST%','Create'); foreach ($e in $zr.Entries) { $name=$e.FullName.Replace('\','/'); $ne=$zw.CreateEntry($name,[System.IO.Compression.CompressionLevel]::Optimal); $in=$e.Open(); $out=$ne.Open(); $in.CopyTo($out); $out.Close(); $in.Close() }; $zw.Dispose(); $zr.Dispose(); Write-Output 'NORMALIZED_OK'"
