@echo off
chcp 65001 >nul
title Cline Register

cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo [ERROR] Node.js not found. Install it first: https://nodejs.org/
  echo.
  pause
  exit /b 1
)

node start.mjs

echo.
echo ============================================================
echo Done. Press any key to close.
pause >nul
