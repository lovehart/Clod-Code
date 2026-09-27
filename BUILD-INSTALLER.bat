@echo off
title Clod Code - Build Installer
cd /d "%~dp0"

where node >nul 2>nul
if %errorlevel% neq 0 (
    echo Node.js not found. Please run SETUP-WINDOWS.bat first.
    pause
    exit /b
)

if not exist "node_modules" call npm install

echo.
echo Building the Windows installer. This takes a few minutes...
echo.
call npm run build:win

echo.
echo ============================================
echo   Done. Look in the "dist" folder for:
echo      Clod Code Setup 1.1.0.exe
echo ============================================
echo.
echo That .exe installs the app like normal software -
echo Start Menu shortcut, no terminal needed afterwards.
echo.
pause
