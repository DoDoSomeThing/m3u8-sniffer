@echo off
chcp 65001 >nul
rem 影片下載器 GUI（Windows）：雙擊啟動本地伺服器 + 開瀏覽器
rem 需求：先裝 Node.js、yt-dlp、ffmpeg，且都在 PATH 中
cd /d "%~dp0"

rem 首次確保 videodl:// 協定已註冊（擴充按下載才喚得起本 App）；已註冊則覆蓋同值，無害
if not exist "%USERPROFILE%\.videodl_registered" (
  call "%~dp0register_videodl_win.bat"
  echo done> "%USERPROFILE%\.videodl_registered"
)

echo 啟動影片下載器 GUI...
rem 可見視窗當運作指示燈：關視窗或 Ctrl+C 即停止 server（不再 /min 藏後台）
start "影片下載器 運作中 — 關閉此視窗或按 Ctrl+C 即停止" cmd /k "chcp 65001>nul && node server.js"
timeout /t 2 >nul
start "" "http://127.0.0.1:7654"
exit
