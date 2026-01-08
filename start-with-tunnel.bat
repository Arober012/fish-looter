@echo off
setlocal
cd /d "%~dp0"

rem === Quick launcher: backend + Cloudflare Tunnel ===
rem Adjust PORT if you want a different local port.
set PORT=8084

rem Tunnel mode: "named" uses your configured tunnel; "quick" starts a one-off tunnel URL each run.
set TUNNEL_MODE=named
set TUNNEL_NAME=fish-looter

rem Start backend API + overlay/panel assets (serves overlay.html + panel.html + /api)
start "fishing-backend" cmd /k "set PORT=%PORT%&& npm run dev"

rem Give the backend a moment to boot before starting the tunnel
timeout /t 6 /nobreak >nul

rem Start Cloudflare Tunnel to expose the local server over HTTPS.
if /I "%TUNNEL_MODE%"=="quick" (
    rem Quick tunnel (changes URL each run): copy the https://*.trycloudflare.com it prints.
    start "cf-quick-tunnel" cmd /k "cloudflared tunnel --url http://localhost:%PORT%"
) else (
    rem Named tunnel (stable hostname configured in cloudflared config/DNS)
    start "cf-named-tunnel" cmd /k "cloudflared tunnel run %TUNNEL_NAME%"
)

echo.
echo Backend listening on localhost:%PORT% (in the other window).
echo Tunnel window shows your public HTTPS URL to share for the panel.
echo Close both windows to stop.

endlocal
