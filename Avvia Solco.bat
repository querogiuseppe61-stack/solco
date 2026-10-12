@echo off
setlocal
cd /d "%~dp0"

if "%~1"==":waitopen" goto :waitopen

if not defined PORT set "PORT=3747"
set "URL=http://localhost:%PORT%"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js non risulta installato, oppure non e' nel PATH.
  echo.
  echo Installalo da https://nodejs.org
  echo.
  pause
  exit /b 1
)

rem Solco usa fetch(), disponibile dalla 18.
for /f "delims=" %%v in ('node -p "process.versions.node.split('.')[0]" 2^>nul') do set "NODE_MAJOR=%%v"
if not defined NODE_MAJOR set "NODE_MAJOR=0"
if %NODE_MAJOR% LSS 18 (
  echo Serve Node.js 18 o superiore.
  node -v
  echo.
  echo Aggiornalo da https://nodejs.org
  echo.
  pause
  exit /b 1
)

if not exist "server.js" (
  echo server.js non trovato in questa cartella:
  echo   %cd%
  echo.
  echo Tieni il file .bat insieme al resto dell'app.
  echo.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo Dipendenze mancanti: le installo ^(serve la rete, una volta sola^)...
  call npm install
  if errorlevel 1 (
    echo.
    echo Installazione delle dipendenze non riuscita.
    echo.
    pause
    exit /b 1
  )
  echo.
)

rem Apre il browser solo quando il server risponde davvero (attesa massima ~10 s).
start "" /b cmd /c call "%~f0" :waitopen

echo Solco si sta avviando su %URL%
echo Per fermarlo: chiudi questa finestra.
echo.

node server.js

echo.
pause
exit /b 0

:waitopen
if not defined PORT set "PORT=3747"
set "URL=http://localhost:%PORT%"
set "tentativi=0"

:attendi_loop
set /a tentativi=tentativi+1
where curl >nul 2>nul
if errorlevel 1 goto :attendi_powershell
curl -s -o nul --max-time 1 "%URL%" >nul 2>nul
if not errorlevel 1 goto :apri
goto :attendi_prossimo

:attendi_powershell
powershell -NoProfile -Command "try { $c = New-Object Net.Sockets.TcpClient; $c.Connect('127.0.0.1', %PORT%); $c.Close(); exit 0 } catch { exit 1 }" >nul 2>nul
if not errorlevel 1 goto :apri

:attendi_prossimo
if %tentativi% GEQ 50 goto :apri
ping -n 1 -w 200 127.0.0.1 >nul
goto :attendi_loop

:apri
start "" "%URL%"
exit /b 0
