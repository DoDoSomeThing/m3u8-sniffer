@echo off
chcp 65001 >nul
rem 註冊 videodl:// 協定 → 指向本資料夾的 videodl_win.js（HKCU，免系統管理員）
rem 擴充按下載發 videodl:// → Windows 靠這條註冊找到處理程式
setlocal
set "DIR=%~dp0"
if "%DIR:~-1%"=="\" set "DIR=%DIR:~0,-1%"

rem 找 node.exe 絕對路徑（登錄檔要寫死路徑，不能靠 PATH）
for %%i in (node.exe) do set "NODE=%%~$PATH:i"
if "%NODE%"=="" (
  echo [錯誤] PATH 找不到 node.exe，請先安裝 Node.js 並重開終端機
  pause
  exit /b 1
)

set "HANDLER=%DIR%\videodl_win.js"
reg add "HKCU\Software\Classes\videodl" /ve /d "URL:videodl Protocol" /f >nul
reg add "HKCU\Software\Classes\videodl" /v "URL Protocol" /d "" /f >nul
reg add "HKCU\Software\Classes\videodl\shell\open\command" /ve /d "\"%NODE%\" \"%HANDLER%\" \"%%1\"" /f >nul

echo videodl:// 已註冊
echo   node    : %NODE%
echo   handler : %HANDLER%
endlocal
