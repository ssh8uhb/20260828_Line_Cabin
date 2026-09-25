@echo off
rem AI rendering local bridge launcher (double-click to run).
rem Starts tools/ai-bridge.mjs on 127.0.0.1 and opens the viewer page.
rem The API key is read from: env var DASHSCOPE_API_KEY -> .dashscope-key file -> prompt below.
rem This script never writes the key to disk. Docs: white-model-viewer/README.md, section AI effects.
rem Usage: start-ai-bridge.cmd [--mock] [--port=8787] [--max-calls=12] ...
chcp 65001 >nul
setlocal
cd /d "%~dp0"
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [x] node.exe not found. Install Node 22+ and put it on PATH.
  echo.
  pause
  exit /b 1
)

if not defined DASHSCOPE_API_KEY if exist ".dashscope-key" (
  set /p "DASHSCOPE_API_KEY=" < ".dashscope-key"
)
if not defined DASHSCOPE_API_KEY (
  echo [i] DASHSCOPE_API_KEY is not set.
  echo     Press Enter to skip - the key is only needed for real renders, --mock works without it.
  set /p "DASHSCOPE_API_KEY=    DashScope API key (sk-...): "
)

set "KEYMASK=(not set - only --mock will work)"
if defined DASHSCOPE_API_KEY set "KEYMASK=%DASHSCOPE_API_KEY:~0,3%*** (memory of this window only)"

echo.
echo   === AI bridge for the white-model viewer ===================
echo     URL   : http://127.0.0.1:8787    (localhost only - never expose it)
echo     Key   : %KEYMASK%
echo     Stop  : Ctrl+C in this window, or just close the window
echo     Cost  : each real render bills one image - the page asks before sending
echo     Free  : close this, then run  start-ai-bridge.cmd --mock
echo   ============================================================
echo.

if not defined AI_BRIDGE_NO_OPEN (
  setlocal enabledelayedexpansion
  set "DIR=%~dp0"
  set "DIR=!DIR:\=/!"
  echo   Opening the viewer: file:///!DIR!index.html?env=1
  start "" "file:///!DIR!index.html?env=1"
  endlocal
)

node "%~dp0tools\ai-bridge.mjs" %*

echo.
echo [i] bridge stopped.
pause
