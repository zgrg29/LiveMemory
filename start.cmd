@echo off
rem LiveMemory development launcher (end users should use LiveMemory.exe).
rem UTF-8 code page keeps the tri-language console readable on Windows.
chcp 65001 >nul
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js was not found on PATH.
  echo LiveMemory needs Node.js 22.5 or newer for development runs.
  echo End users should run the packaged LiveMemory.exe instead.
  echo.
  pause
  exit /b 1
)

node src\launcher\launcher.mjs %*
set CODE=%ERRORLEVEL%
endlocal & exit /b %CODE%
