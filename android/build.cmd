@echo off
rem ============================================================
rem Ping-Pong Duel - Android APK build script (no Gradle)
rem Requires: JDK 17 + Android SDK (build-tools 34.0.0 / platform android-34) + 7-Zip
rem Output: android\PingPongDuel.apk
rem
rem Pipeline note (2026-08-07, fix for "invalid package" install errors):
rem   aapt2 on Windows writes zip entry names with backslashes, and the old
rem   normalize step re-zipped with .NET which COMPRESSED resources.arsc.
rem   Standard APKs must keep resources.arsc UNCOMPRESSED (mmap-able);
rem   compressed arsc makes some Android devices fail with "invalid package".
rem   New pipeline: aapt2 link WITHOUT -A assets, then add assets and
rem   classes.dex via 7-Zip (7z writes canonical forward-slash entry names
rem   and preserves the original STORED resources.arsc).
rem Path note (2026-08-07): aapt2 cannot open source paths with non-ASCII
rem   characters (e.g. a Chinese folder name) -> build in an ASCII temp dir
rem   %TEMP%\ppd_apk_build, then copy the APK back.
rem Sign note (2026-08-08): persistent keystore at android\release.keystore
rem   so every build shares the same signature -> users can install over old
rem   versions without uninstalling first.
rem ============================================================
setlocal
set "SDK=C:\Users\ASUS\AppData\Local\Android\Sdk"
set "BT=%SDK%\build-tools\34.0.0"
set "PLAT=%SDK%\platforms\android-34\android.jar"
set "SZ=C:\Program Files\7-Zip\7z.exe"
set "ROOT=%~dp0"
set "WORK=%TEMP%\ppd_apk_build"
set "OUT=%WORK%\build"

if not exist "%BT%\aapt2.exe" ( echo [ERR] build-tools not found: %BT% & exit /b 1 )
if not exist "%PLAT%" ( echo [ERR] platform not found: %PLAT% & exit /b 1 )
if not exist "%SZ%" ( echo [ERR] 7-Zip not found: %SZ% & exit /b 1 )

rem copy build inputs to an ASCII temp workspace (aapt2 non-ASCII path fix)
if exist "%WORK%" rmdir /s /q "%WORK%"
mkdir "%WORK%" || goto :err
xcopy /E /I /Y /Q "%ROOT%res" "%WORK%\res" >nul || goto :err
xcopy /E /I /Y /Q "%ROOT%assets" "%WORK%\assets" >nul || goto :err
xcopy /E /I /Y /Q "%ROOT%java" "%WORK%\java" >nul || goto :err
copy /Y "%ROOT%AndroidManifest.xml" "%WORK%\AndroidManifest.xml" >nul || goto :err
set "ROOT=%WORK%\"
mkdir "%OUT%\gen" "%OUT%\classes" "%OUT%\dex" 2>nul

echo [1/7] compile resources...
"%BT%\aapt2.exe" compile --dir "%ROOT%res" -o "%OUT%\res.zip" || goto :err

echo [2/7] link manifest + resources (no -A assets: added by 7-Zip in [5/7])...
"%BT%\aapt2.exe" link -o "%OUT%\unsigned.apk" -I "%PLAT%" ^
  --manifest "%ROOT%AndroidManifest.xml" -R "%OUT%\res.zip" --auto-add-overlay ^
  --java "%OUT%\gen" --min-sdk-version 24 --target-sdk-version 34 ^
  --version-code 5 --version-name 1.6 || goto :err

echo [3/7] compile java...
javac -encoding UTF-8 -source 1.8 -target 1.8 -classpath "%PLAT%" -d "%OUT%\classes" ^
  "%OUT%\gen\com\ppd\duel\R.java" "%ROOT%java\com\ppd\duel\MainActivity.java" || goto :err

echo [4/7] dex...
jar cf "%OUT%\classes.jar" -C "%OUT%\classes" . || goto :err
call "%BT%\d8.bat" --release --lib "%PLAT%" --output "%OUT%\dex" "%OUT%\classes.jar" || goto :err

echo [5/7] add assets + classes.dex via 7-Zip (forward-slash names, arsc stays STORED)...
pushd "%ROOT%"
"%SZ%" a -tzip "%OUT%\unsigned.apk" assets -mx5 || goto :err
popd
pushd "%OUT%\dex"
"%SZ%" a -tzip "%OUT%\unsigned.apk" classes.dex -mx5 || goto :err
popd

echo [6/7] zipalign...
"%BT%\zipalign.exe" -f 4 "%OUT%\unsigned.apk" "%OUT%\aligned.apk" || goto :err

echo [7/7] sign...
rem Persistent keystore (android\release.keystore): same signature every build,
rem so users can install over old versions without uninstalling.
if not exist "%~dp0release.keystore" (
  keytool -genkeypair -keystore "%~dp0release.keystore" -alias ppd -keyalg RSA -keysize 2048 ^
    -validity 10000 -storepass ppd123456 -keypass ppd123456 -dname "CN=PPD, OU=PPD, O=PPD, L=CN, S=CN, C=CN" -noprompt
)
call "%BT%\apksigner.bat" sign --ks "%~dp0release.keystore" --ks-pass pass:ppd123456 ^
  --key-pass pass:ppd123456 --v1-signing-enabled false --out "%OUT%\PingPongDuel.apk" "%OUT%\aligned.apk" || goto :err

rem copy the APK back to the source folder
copy /Y "%OUT%\PingPongDuel.apk" "%~dp0PingPongDuel.apk" >nul || goto :err
echo.
echo [DONE] %~dp0PingPongDuel.apk
exit /b 0

:err
echo [ERR] build failed
exit /b 1
