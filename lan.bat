@echo off
cd /d "%~dp0"
set "BACKUP_SCOPE=%~1"
rem Edit this line below to set default (full or minimal):
if "%BACKUP_SCOPE%"=="" set "BACKUP_SCOPE=minimal"
if /i "%BACKUP_SCOPE%"=="minimal" goto launch
if /i "%BACKUP_SCOPE%"=="full" goto launch
if not "%BACKUP_SCOPE%"=="" (
  echo Unknown backup scope "%BACKUP_SCOPE%". Use "full" or "minimal".
  exit /b 1
)
:launch
echo.
echo Using backup scope: %BACKUP_SCOPE%
powershell -NoProfile -Command "$env:BACKUP_SCOPE='%BACKUP_SCOPE%'; bun run lan --silent"
