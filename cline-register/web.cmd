@echo off
chcp 65001 >nul
title Cline Register (Web Console)

cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo [ERROR] Node.js not found. Install it first: https://nodejs.org/
  echo.
  pause
  exit /b 1
)

echo Starting web console...
start "" http://127.0.0.1:8788/
node web.mjs

echo.
echo Console stopped. Press any key to close.
pause >nul
