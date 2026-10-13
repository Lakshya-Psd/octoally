@echo off
rem OctoAlly installer for Windows - double-click me, or run:
rem   install.cmd [-NoStart] [-Service] [-Desktop] [-SkipBuild]
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install.ps1" %*
set "OCTO_RC=%ERRORLEVEL%"
if "%~1"=="" pause
exit /b %OCTO_RC%
