@echo off
setlocal

title KiroLuker Mobile - Build APK
cd /d "%~dp0"

echo ==================================================
echo   KiroLuker Mobile - Build APK
echo ==================================================
echo.

set "FLUTTER_BIN="
where flutter.bat >nul 2>nul
if %ERRORLEVEL% EQU 0 (
  for /f "delims=" %%i in ('where flutter.bat') do (
    if not defined FLUTTER_BIN set "FLUTTER_BIN=%%i"
  )
)

if not defined FLUTTER_BIN (
  if exist "D:\develops\flutter\bin\flutter.bat" (
    set "FLUTTER_BIN=D:\develops\flutter\bin\flutter.bat"
  ) else if exist "C:\develops\flutter\bin\flutter.bat" (
    set "FLUTTER_BIN=C:\develops\flutter\bin\flutter.bat"
  ) else if exist "C:\flutter\bin\flutter.bat" (
    set "FLUTTER_BIN=C:\flutter\bin\flutter.bat"
  ) else if exist "D:\flutter\bin\flutter.bat" (
    set "FLUTTER_BIN=D:\flutter\bin\flutter.bat"
  )
)

if not defined FLUTTER_BIN (
  echo [ERROR] Flutter SDK not found.
  echo Please make sure Flutter is installed and added to PATH.
  goto :failed
)

for %%i in ("%FLUTTER_BIN%") do set "FLUTTER_DIR=%%~dpi"
set "PATH=%FLUTTER_DIR%;%PATH%"
echo [1/4] Flutter: %FLUTTER_BIN%

if not defined JAVA_HOME (
  if exist "D:\develops\Android\Android Stuidio\jbr" (
    set "JAVA_HOME=D:\develops\Android\Android Stuidio\jbr"
  ) else if exist "C:\Program Files\Android\Android Studio\jbr" (
    set "JAVA_HOME=C:\Program Files\Android\Android Studio\jbr"
  )
)

if defined JAVA_HOME (
  set "PATH=%JAVA_HOME%\bin;%PATH%"
  echo [2/4] JDK: %JAVA_HOME%
) else (
  echo [2/4] Using system default Java environment
)

if not defined ANDROID_HOME (
  if exist "D:\develops\Android\SDK" (
    set "ANDROID_HOME=D:\develops\Android\SDK"
  ) else if exist "%LOCALAPPDATA%\Android\Sdk" (
    set "ANDROID_HOME=%LOCALAPPDATA%\Android\Sdk"
  )
)
if defined ANDROID_HOME (
  echo [3/4] Android SDK: %ANDROID_HOME%
) else (
  echo [3/4] Using Flutter default Android SDK configuration
)

echo.
echo ==================================================
echo Select build mode:
echo   [1] Debug APK (fast, recommended for testing)
echo   [2] Release APK
echo ==================================================
set "BUILD_CHOICE="
set /p BUILD_CHOICE="Enter option [1 or 2, default: 1]: "
if "%BUILD_CHOICE%"=="" set BUILD_CHOICE=1

echo.
echo [4/4] Resolving dependencies and building APK...
call "%FLUTTER_BIN%" pub get
if %ERRORLEVEL% NEQ 0 (
  echo [ERROR] flutter pub get failed.
  goto :failed
)

if "%BUILD_CHOICE%"=="2" (
  echo [INFO] Building Release APK...
  call "%FLUTTER_BIN%" build apk --release
) else (
  echo [INFO] Building Debug APK...
  call "%FLUTTER_BIN%" build apk --debug
)

if %ERRORLEVEL% NEQ 0 (
  echo.
  echo [ERROR] APK build failed. Review the logs above.
  goto :failed
)

echo.
echo ==================================================
echo [SUCCESS] APK built successfully!
echo ==================================================

set "OUTPUT_DIR=%~dp0build\app\outputs\flutter-apk"
if exist "%OUTPUT_DIR%" (
  echo Output directory: %OUTPUT_DIR%
  explorer.exe "%OUTPUT_DIR%"
)

pause
exit /b 0

:failed
echo.
echo ==================================================
echo [FAILED] Build did not complete.
echo ==================================================
pause
exit /b 1
