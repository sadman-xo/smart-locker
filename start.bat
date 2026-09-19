@echo off
title Smart Locker Launcher
cd /d "%~dp0"

echo ============================================
echo   SMART LOCKER - starting server + tunnel
echo ============================================
echo.

REM --- 1. Start the web server on port 8080 (port 3000 is blocked on this PC) ---
start "Smart Locker Server" cmd /k "set PORT=8080&& node server.js"

REM --- give the server a moment to boot before the tunnel connects ---
timeout /t 4 /nobreak >nul

REM --- 2. Start the public tunnel with a FIXED subdomain (same URL every time) ---
start "Smart Locker Tunnel" cmd /k "npx --yes localtunnel --port 8080 --local-host 127.0.0.1 --subdomain smartlocker-sizan"

echo.
echo   Local (this laptop):   http://localhost:8080/
echo   Public (your phone):   https://smartlocker-sizan.loca.lt/
echo.
echo   First phone visit asks for a "tunnel password" = your public IP.
echo   Find it any time at: https://loca.lt/mytunnelpassword
echo.
echo   Two windows opened (Server, Tunnel). Close them to stop everything.
echo ============================================
pause
