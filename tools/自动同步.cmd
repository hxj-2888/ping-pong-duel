@echo off
rem 乒乓对决 · 自动同步（源头=本工程，修改后自动同步到桌面/安装包/APK资产/ECS 全部副本）
rem 运行后常驻后台监听，关闭窗口即停止；也可手动跑一次性同步：node tools\autosync.js --once
cd /d "%~dp0.."
start "乒乓对决自动同步" /min cmd /c "node tools\autosync.js && pause"
