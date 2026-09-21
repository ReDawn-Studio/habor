@echo off
setlocal
chcp 65001 >nul
where node.exe >nul 2>nul
if errorlevel 1 (
  echo Node.js 22.19 or newer is required. Install it from https://nodejs.org/
  exit /b 1
)
if not exist "%~dp0packages\cli\dist\index.js" (
  echo First run: powershell -ExecutionPolicy Bypass -File "%~dp0setup-windows.ps1"
  exit /b 1
)
node.exe "%~dp0packages\cli\dist\index.js" %*
exit /b %errorlevel%
