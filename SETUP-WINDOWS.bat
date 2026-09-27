@echo off
title Clod Code - Setup
cd /d "%~dp0"

echo ============================================
echo   Clod Code - Windows Setup
echo ============================================
echo.

where node >nul 2>nul
if %errorlevel% neq 0 goto NONODE

echo [OK] Node.js found:
node --version
echo.

echo Installing dependencies (first run downloads Electron, ~150 MB)...
echo This can take a few minutes. Please wait.
echo.
call npm install
if %errorlevel% neq 0 goto FAILED

echo.
echo ============================================
echo   Done! Starting the app...
echo ============================================
call npm start
goto END

:NONODE
echo [X] Node.js is NOT installed.
echo.
echo Install it one of these ways, then run this file again:
echo.
echo   OPTION 1 - One command (easiest):
echo      Open PowerShell and run:
echo         winget install OpenJS.NodeJS.LTS
echo.
echo   OPTION 2 - Download the installer:
echo      https://nodejs.org/en/download
echo      Pick "Windows Installer (.msi)" - LTS version.
echo      Click Next through the installer, defaults are fine.
echo.
echo   IMPORTANT: after installing, CLOSE this window and any
echo   PowerShell/terminal windows, then run this file again.
echo   Windows only picks up the new PATH in fresh windows.
echo.
pause
goto END

:FAILED
echo.
echo [X] npm install failed. Common fixes:
echo     - Check your internet connection
echo     - Try running this file as Administrator
echo     - Delete the node_modules folder and retry
echo.
pause

:END
pause
