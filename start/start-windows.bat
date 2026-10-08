@echo off
rem Double-click: builds the editor and opens it at http://localhost:5179.
rem Web MIDI needs a served page; the fixed port keeps the browser's MIDI permission.
cd /d "%~dp0.."
where npm >nul 2>nul
if errorlevel 1 (
  echo Node.js is needed: https://nodejs.org
  pause
  exit /b 1
)
if not exist node_modules (
  call npm install
  if errorlevel 1 (
    pause
    exit /b 1
  )
)
call npm start
if errorlevel 1 (
  echo.
  echo The editor did not start. If port 5179 is taken, it may already be running: open http://localhost:5179
  pause
)
