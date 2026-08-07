@echo off
chcp 936 >nul
title 乒乓对决 · 局域网联机防火墙放行（TCP 8765）
echo ============================================
echo   乒乓对决 · 局域网联机防火墙放行
echo   作用：放行 Windows 防火墙 TCP 8765，
echo         让同一网络（或 Radmin VPN）里的
echo         对方能连上你的游戏服务器。
echo ============================================
echo.

rem 检查是否管理员权限；不是则自动请求提升后重新运行
net session >nul 2>&1
if %errorlevel% neq 0 (
  echo 需要管理员权限，正在请求提升…
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

echo 正在放行 TCP 8765（删除旧规则后重建，幂等）…
netsh advfirewall firewall delete rule name="乒乓对决 8765" >nul 2>&1
netsh advfirewall firewall add rule name="乒乓对决 8765" dir=in action=allow protocol=TCP localport=8765 >nul
if %errorlevel% equ 0 (
  echo.
  echo 完成：已放行 TCP 8765。
  echo 现在对方可通过 http://本机IP:8765 打开游戏并输入房间码加入。
  echo 房主自己的联机地址见游戏内"房间已创建"面板。
) else (
  echo.
  echo 失败：请确认已以管理员身份运行本脚本。
)
echo.
pause
