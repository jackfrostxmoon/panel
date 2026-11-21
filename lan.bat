@echo off
cd /d "%~dp0"
rem Arguments can be given in any order:
rem   full | minimal   backup scope (default: minimal - edit below)
rem   smol             run the API in Bun's low-memory mode
rem   -v | --verbose   show API logs (default: silent, e.g. for tray/autostart)
rem Examples: lan.bat   lan.bat full   lan.bat -v   lan.bat minimal smol -v
set "BACKUP_SCOPE="
set "SMOL_ARG="
set "VERBOSE="
for %%A in (%*) do (
  if /i "%%A"=="full" (set "BACKUP_SCOPE=full") else if /i "%%A"=="minimal" (set "BACKUP_SCOPE=minimal") else if /i "%%A"=="smol" (set "SMOL_ARG=$env:BUN_SMOL='1';") else if /i "%%A"=="-v" (set "VERBOSE=1") else if /i "%%A"=="--verbose" (set "VERBOSE=1") else if /i "%%A"=="verbose" (set "VERBOSE=1") else (
    echo Unknown option "%%A". Use "full", "minimal", "smol" or "-v".
    exit /b 1
  )
)
rem Edit this line below to set default (full or minimal):
if "%BACKUP_SCOPE%"=="" set "BACKUP_SCOPE=minimal"
set "SILENT_ARG=--silent"
if defined VERBOSE set "SILENT_ARG="
:launch
echo.
echo Using backup scope: %BACKUP_SCOPE%
if defined VERBOSE (echo Logs: verbose) else (echo Logs: silent)
powershell -NoProfile -Command "$env:NODE_ENV='production'; $env:BACKUP_SCOPE='%BACKUP_SCOPE%'; %SMOL_ARG% bun run lan %SILENT_ARG%"
