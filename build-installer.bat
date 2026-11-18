@echo off
rem  Live Studio - builds the Windows installer on this PC.
rem  Double-click this file. The finished Setup.exe appears in the "dist" folder.
title Building Live Studio installer
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  Node.js is needed once to build the installer.
  echo  Install the "LTS" version from https://nodejs.org , then double-click this file again.
  echo.
  start https://nodejs.org
  pause
  exit /b 1
)

echo.
echo  [1/3] Downloading build tools (first time takes a few minutes)...
call npm install --no-audit --no-fund
if errorlevel 1 goto fail

if not exist "resources\ffmpeg\ffmpeg.exe" (
  echo.
  echo  [2/3] Downloading the video encoder - FFmpeg...
  powershell -NoProfile -ExecutionPolicy Bypass -Command ^
    "$ErrorActionPreference='Stop';" ^
    "Invoke-WebRequest -Uri 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip' -OutFile ffmpeg.zip;" ^
    "Expand-Archive ffmpeg.zip -DestinationPath ffmpeg-tmp -Force;" ^
    "New-Item -ItemType Directory -Force -Path resources\ffmpeg | Out-Null;" ^
    "Copy-Item (Get-ChildItem ffmpeg-tmp -Recurse -Filter ffmpeg.exe | Select-Object -First 1).FullName resources\ffmpeg\ffmpeg.exe;" ^
    "Remove-Item ffmpeg.zip; Remove-Item ffmpeg-tmp -Recurse -Force"
  if errorlevel 1 goto fail
) else (
  echo  [2/3] Video encoder already downloaded.
)

echo.
echo  [3/3] Building the installer...
call npx electron-builder --win --publish never
if errorlevel 1 goto fail

echo.
echo  Done! Your installer is in the "dist" folder:
dir /b dist\*.exe
explorer dist
pause
exit /b 0

:fail
echo.
echo  Something went wrong - scroll up to see the message, or send a screenshot to Claude.
pause
exit /b 1
