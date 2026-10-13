@echo off
rem OctoAlly CLI launcher for Windows (cmd.exe / PowerShell / Git Bash).
rem Runs bin\octoally-win.mjs with Node.js and passes the exit code through.
setlocal
set "OCTO_NODE=node"
where node >nul 2>nul || set "OCTO_NODE=%ProgramFiles%\nodejs\node.exe"
if not "%OCTO_NODE%"=="node" if not exist "%OCTO_NODE%" goto :nonode
"%OCTO_NODE%" "%~dp0octoally-win.mjs" %*
exit /b %ERRORLEVEL%

:nonode
echo [OctoAlly] Node.js was not found. Install Node.js 20+ from https://nodejs.org and open a new terminal. 1>&2
exit /b 1
