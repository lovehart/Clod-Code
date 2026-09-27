@echo off
title Clod Code
cd /d "%~dp0"

where node >nul 2>nul
if %errorlevel% neq 0 (
    echo Node.js not found. Please run SETUP-WINDOWS.bat first.
    pause
    exit /b
)

if not exist "node_modules" (
    echo Dependencies not installed yet. Running setup first...
    call npm install
)

call npm start
