@echo off
title Smart Locker Launcher (Cloudflare)
cd /d "%~dp0"

echo ==================================================
echo   SMART LOCKER - server + Cloudflare tunnel
echo ==================================================
echo.
echo   NOTE: Use EITHER start.bat OR this file, not both
echo   at the same time (they both use port 8080).
echo.

REM --- 1. Start the web server on port 8080 (same as start.bat) ---
start "Smart Locker Server" cmd /k "set PORT=8080&& node server.js"

REM --- give the server a moment to boot before the tunnel connects ---
timeout /t 4 /nobreak >nul

REM --- 2. Start a Cloudflare quick tunnel (no account, no password) ---
REM     A fresh https://<random>.trycloudflare.com URL is printed in the
REM     tunnel window each time you run this. Copy it from that window.
start "Smart Locker Tunnel (Cloudflare)" cmd /k "cloudflare\cloudflared.exe tunnel --url http://localhost:8080"

echo.
echo   Local (this laptop):   http://localhost:8080/
echo   Public (your phone):   see the "trycloudflare.com" link that
echo                          appears in the Tunnel window below.
echo.
echo   No tunnel password is needed with Cloudflare.
echo.
echo   Two windows opened (Server, Tunnel). Close them to stop everything.
echo ==================================================
pause
