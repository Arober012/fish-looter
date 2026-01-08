@echo off
setlocal
cd /d "%~dp0"

rem Unified launcher: backend + overlay dev (customizable port)
rem Change this if 3000/3001/5176 are occupied
set PORT=3200
set VITE_SOCKET_URL=http://localhost:%PORT%
set OVERLAY_PORT=5182

start "fishing-backend" cmd /k "set PORT=%PORT%&& npm start"
start "fishing-overlay" cmd /k "set VITE_SOCKET_URL=%VITE_SOCKET_URL%&& npm run overlay:dev -- --port %OVERLAY_PORT%"

echo Backend on %PORT% and overlay dev on %OVERLAY_PORT% started (watch the two windows). Close them to stop.
endlocal
