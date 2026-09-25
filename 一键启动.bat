@echo off
rem ============================================================
rem  Nurse Registry System - Quick Start Launcher
rem  IMPORTANT: This file must stay pure ASCII.
rem  Chinese text lives in scripts/launch.js instead, because
rem  cmd.exe mis-parses non-ASCII bytes and truncates commands.
rem ============================================================
setlocal
cd /d "%~dp0"

set "NODE_EXE="

if exist "%~dp0portable-node\node.exe" set "NODE_EXE=%~dp0portable-node\node.exe"
if not defined NODE_EXE if exist "%~dp0node.exe" set "NODE_EXE=%~dp0node.exe"
if not defined NODE_EXE for /f "delims=" %%p in ('where node 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%p"
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles(x86)%\nodejs\node.exe"
if not defined NODE_EXE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_EXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODE_EXE if exist "%APPDATA%\nvm\node.exe" set "NODE_EXE=%APPDATA%\nvm\node.exe"
if not defined NODE_EXE if exist "C:\nodejs\node.exe" set "NODE_EXE=C:\nodejs\node.exe"

if not defined NODE_EXE goto no_node

"%NODE_EXE%" "%~dp0scripts\launch.js"
set "EXITCODE=%ERRORLEVEL%"

endlocal
exit /b %EXITCODE%

:no_node
echo.
echo   [ERROR] Node.js not found.
echo.
echo   Make sure this file exists in the project folder:
echo      portable-node\node.exe
echo.
echo   Or install Node.js 18+ from https://nodejs.org/
echo.
pause
exit /b 1
