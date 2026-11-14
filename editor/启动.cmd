@echo off
cd /d "%~dp0"
node "%~dp0serve.js" 8787 %1
pause
