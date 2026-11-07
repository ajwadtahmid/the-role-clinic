@echo off
setlocal
set "NODE_OPTIONS="
set "NODE_PATH="
"%~dp0runtime\node.exe" "%~dp0launcher.mjs" %*
exit /b %errorlevel%
