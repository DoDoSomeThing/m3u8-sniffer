#!/bin/zsh
# 雙擊啟動影片下載器：起本地伺服器（前景，此視窗＝運作指示燈，Ctrl+C 或關視窗即停）
DIR="${0:A:h}"   # 本腳本所在目錄（自動偵測，clone 到哪都能跑）
URL="http://127.0.0.1:7654"

# 找 node（GUI 啟動時 PATH 可能不全）
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

# 已在跑：可能是改 code 前的舊版，戳 /enqueue 驗（新版回 200，舊版 404）
if curl -s "$URL" >/dev/null 2>&1; then
  code=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$URL/enqueue" \
    -H "Content-Type: application/json" -d '{}' 2>/dev/null)
  if [ "$code" = "404" ]; then
    echo "偵測到舊版 server，重啟…"
    pkill -f "node.*server.js"
    sleep 1
  else
    echo "伺服器已在執行中：$URL"
    echo "（若要看即時 log，先關掉舊的：pkill -f 'node.*server.js' 再雙擊本檔）"
    sleep 1
    exit 0
  fi
fi

echo "=== 影片下載器 運作中（Ctrl+C 或關閉此視窗即停止）==="
cd "$DIR"
# 前景執行：視窗留著顯示 log，關掉即停
exec node server.js
