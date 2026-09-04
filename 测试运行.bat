@echo off
setlocal

title KiroLuker - Build and Run
cd /d "%~dp0"

echo ==================================================
echo   KiroLuker - Build and Run
echo ==================================================
echo.

where node.exe >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js was not found. Install Node.js 20 or newer first.
  goto :failed
)

where npm.cmd >nul 2>nul
if errorlevel 1 (
  echo [ERROR] npm was not found. Check your Node.js installation.
  goto :failed
)

if not exist "package.json" (
  echo [ERROR] package.json was not found in: %CD%
  goto :failed
)

if not exist "node_modules\electron\install.js" (
  echo [1/3] Dependencies are missing. Running npm install...
  call npm.cmd install
  if errorlevel 1 goto :failed
) else if not exist "node_modules\.bin\electron-vite.cmd" (
  echo [1/3] Dependencies are incomplete. Running npm install...
  call npm.cmd install
  if errorlevel 1 goto :failed
) else (
  echo [1/3] Dependencies already exist. Skipping npm install.
)

if not exist "node_modules\electron\dist\electron.exe" (
  echo.
  echo [INFO] Electron runtime is missing. Downloading from the official source...
  node "node_modules\electron\install.js"

  if not exist "node_modules\electron\dist\electron.exe" (
    echo [INFO] Official download failed. Retrying with the npmmirror mirror...
    set "ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/"
    node "node_modules\electron\install.js"
  )

  if not exist "node_modules\electron\dist\electron.exe" (
    echo [ERROR] Electron download failed. Check your network or proxy settings.
    goto :failed
  )
)

echo.
echo [2/3] Running type checks and production build...
call npm.cmd run build
if errorlevel 1 goto :failed

echo.
echo [3/3] Build completed. Starting the application...
echo [INFO] Keep this window open to view runtime logs.
echo.
call npm.cmd start
if errorlevel 1 goto :failed

echo.
echo The application has exited.
pause
exit /b 0

:failed
echo.
echo ==================================================
echo [FAILED] Build or startup did not complete.
echo Review the error messages above.
echo ==================================================
pause
exit /b 1
