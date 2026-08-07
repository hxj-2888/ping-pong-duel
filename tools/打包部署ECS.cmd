@echo off
chcp 65001 >nul
REM ============================================================
REM 乒乓对决 · 生成 ECS 部署包（dist\ecs\）
REM 运行后把 dist\ecs\ 上传到 ECS，执行 bash 部署到ECS.sh
REM ============================================================
setlocal
cd /d "%~dp0.."
set OUT=dist\ecs
if exist "%OUT%" rmdir /s /q "%OUT%"
mkdir "%OUT%\public"

echo 正在复制文件...
copy /y server.js "%OUT%\server.js" >nul
copy /y package.json "%OUT%\package.json" >nul
copy /y "tools\部署到ECS.sh" "%OUT%\部署到ECS.sh" >nul
copy /y "tools\部署到ECS.txt" "%OUT%\部署说明.txt" >nul
xcopy /e /i /y /q "public" "%OUT%\public" >nul

echo.
echo 部署包已生成: dist\ecs
echo 下一步：
echo   1. 上传 dist\ecs 到 ECS（如 scp -r dist\ecs\* root@ECS_IP:/root/ppd/）
echo   2. ECS 上执行: cd /root/ppd ^&^& bash 部署到ECS.sh
echo   3. 阿里云控制台安全组放行 TCP 8765
echo   4. 玩家打开 http://ECS_IP:8765 即可游玩
pause
