@echo off
cd /d "%~dp0"
set "BACKUP_SCOPE=%~1"
rem Edit this line below to set default (full or minimal):
if "%BACKUP_SCOPE%"=="" set "BACKUP_SCOPE=minimal"
if /i "%BACKUP_SCOPE%"=="minimal" goto scopeok
if /i "%BACKUP_SCOPE%"=="full" goto scopeok
if not "%BACKUP_SCOPE%"=="" (
  echo Unknown backup scope "%BACKUP_SCOPE%". Use "full" or "minimal".
  exit /b 1
)
:scopeok
rem Optional second argument: "smol" runs the API in Bun's low-memory mode
rem (smaller JS heap, more frequent GC). Example: lan.bat minimal smol
set "SMOL_ARG="
if /i "%~2"=="smol" set "SMOL_ARG=$env:BUN_SMOL='1';"
if not "%~2"=="" if /i not "%~2"=="smol" (
  echo Unknown option "%~2". Use "smol" or leave empty.
  exit /b 1
)
:launch
echo.
echo Using backup scope: %BACKUP_SCOPE%
powershell -NoProfile -Command "$env:BACKUP_SCOPE='%BACKUP_SCOPE%'; %SMOL_ARG% bun run lan --silent"
