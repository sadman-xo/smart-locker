@echo off
title Smart Locker Launcher (ngrok - permanent link)
cd /d "%~dp0"

REM ============================================================
REM   PASTE YOUR NGROK STATIC DOMAIN BELOW (between the = and nothing else)
REM   Get it at: https://dashboard.ngrok.com/domains
REM   Example:  set NGROK_DOMAIN=smartlocker-1234.ngrok-free.app
REM ============================================================
set NGROK_DOMAIN=dimly-frugally-coleslaw.ngrok-free.dev
REM ============================================================

echo ==================================================
echo   SMART LOCKER - server + ngrok (permanent link)
echo ==================================================
echo.
echo   Use ONLY this file (not start.bat / start-cloudflare.bat)
echo   at the same time - they all use port 8080.
echo.

REM --- 1. Start the web server on port 8080 (your laptop = the one real server) ---
start "Smart Locker Server" cmd /k "set PORT=8080&& node server.js"

REM --- give the server a moment to boot before the tunnel connects ---
timeout /t 4 /nobreak >nul

REM --- 2. Start ngrok on your FIXED domain (same URL every launch) ---
start "Smart Locker Tunnel (ngrok)" cmd /k "ngrok\ngrok.exe http --url=https://%NGROK_DOMAIN% 8080"

echo.
echo   Local (this laptop):   http://localhost:8080/
echo   Public (your phone):   https://%NGROK_DOMAIN%/
echo.
echo   This public link is the SAME every time you run this file,
echo   even after you shut the laptop down and start again.
echo.
echo   The laptop server is the only server; the link is just a
echo   doorway to it. Close the Server window and the public link
echo   stops serving your app.
echo ==================================================
pause
