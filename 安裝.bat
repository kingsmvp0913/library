@echo off
cd /d "%~dp0"
echo ============================================
echo    圖書管理系統 安裝（第一次使用執行這個）
echo ============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [1/5] 安裝 Node.js ...
  winget install -e --id OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements
) else (
  echo [1/5] Node.js 已安裝，略過
)

set "PGOK="
where psql >nul 2>nul && set "PGOK=1"
reg query "HKLM\SOFTWARE\PostgreSQL\Installations" >nul 2>nul && set "PGOK=1"
if not defined PGOK (
  echo [2/5] 安裝 PostgreSQL 17 ...
  winget install -e --id PostgreSQL.PostgreSQL.17 --silent --accept-package-agreements --accept-source-agreements
) else (
  echo [2/5] PostgreSQL 已安裝，略過
)

where git >nul 2>nul
if errorlevel 1 (
  echo [3/5] 安裝 Git（啟動時自動更新需要）...
  winget install -e --id Git.Git --silent --accept-package-agreements --accept-source-agreements
) else (
  echo [3/5] Git 已安裝，略過
)

call :refreshpath

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node 已安裝完成，但需要重新開啟視窗才會生效。
  echo 請關掉這個視窗，再點一次「安裝.bat」即可繼續。
  echo.
  pause
  exit /b 1
)

echo [4/5] 安裝相依套件 ...
call npm install

echo [5/5] 建立資料庫並初始化 ...
node "scripts\setup.js"
if errorlevel 1 (
  echo.
  pause
  exit /b 1
)

echo.
echo ============================================
echo    安裝完成！請雙擊「啟動.bat」開始使用。
echo ============================================
pause
exit /b 0

:refreshpath
rem winget 裝完，本視窗的 PATH 仍是舊的，必須從登錄檔重讀
for /f "skip=2 tokens=2,*" %%A in ('reg query "HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment" /v Path 2^>nul') do set "MPATH=%%B"
for /f "skip=2 tokens=2,*" %%A in ('reg query "HKCU\Environment" /v Path 2^>nul') do set "UPATH=%%B"
call set "PATH=%MPATH%;%UPATH%"
goto :eof