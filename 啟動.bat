@echo off
chcp 65001 >nul
cd /d "%~dp0"
rem Update before node starts, so the new version takes effect this run.
rem Silently skipped when git is absent or this folder is not a git repo.
where git >nul 2>nul && git pull --ff-only
node "scripts\start.js"
if errorlevel 1 pause