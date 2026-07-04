# SPEC — m3u8-sniffer 原生 Chrome/Edge 擴充（MV3）

> 目標：把現在的 Tampermonkey userscript 升級成**自建原生擴充**，不再依賴油猴。
> 架構對標 mediago：擴充當**薄嗅探器 + 轉發器**，解密/合併/下載重活全留在既有 `server.js`。
> 建立：2026-07-04（規劃對話產出，另開新對話依此執行）。

---

## ✅ 實作現況（2026-07-05 更新，接手看這段）

**P1–P3 全做完並實測打通，還超出原規劃加了「一鍵喚起 App + 規格小窗 + hover 框選」。** 全上 GitHub commit `ff56c85`。實際用法見 `README.md`。

### 檔案地圖
- `extension/` — 原生擴充。`manifest.json`(MV3) · `background.js`(webRequest 全域嗅探 + JOBS/PENDING 轉發 + badge) · `sniff.js`(all_frames+document_start：注入 inject + DOM 掃描 + hover 框選) · `inject.js`(頁面 context hook fetch/XHR 讀 body) · `content.js`(頁內浮動面板) · `popup.js/html`(工具列面板)
- `server.js` — 下載後端。`/enqueue`(GET+POST) · `/jobs`+`/jobs/cancel`(進度/取消) · `/pending`+`/pending/list`+`/pending/resolve`(規格小窗待確認) · `/probe`(畫質) · `/download`(SSE)
- `gui.html` — 進度介面 + 規格小窗(modal)
- `影片下載器.applescript` → 編進 `.app`；`.command`/`.bat` — 啟動器

### 比原 SPEC 多做的
1. **全格式**（不只 m3u8）：mp4/mpd/webm/mkv/mov/m4v/flv + Content-Type 偽裝補抓（anime1 是 mp4，逼出這需求）。
2. **內容嗅探 + DOM 掃描**（移植油猴）：`inject.js` hook fetch/XHR 讀 body 抓偽裝/blob；`sniff.js` 掃 `<video>/<source>`，跨 iframe。
3. **`videodl://` URL scheme 一鍵喚起 App**：擴充按下載 → macOS 啟動 `影片下載器.app` → 自動起 server + 開窗 + 送下載。server 沒開也自動啟。
4. **規格小窗（A）**：scheme 不直接下，先進 server `/pending` → GUI 跳窗選畫質/檔名/位置 → 確認才 `/enqueue`。
5. **hover 框選影片（B）**：hover 面板清單 → 頁面上對應 `<video>` 被紫框框起（精準＋全部後備）。
6. **cookie 破 403**：`--cookies-from-browser chrome`（anime1/CF+cookie 站）。
7. **App 體驗**：Chrome app 模式視窗（無網址列）；雙擊只背景起 server；可見 Terminal 當運作指示燈（Ctrl+C/關窗即停）。
8. **藥丸拖曳＋記位置**、清除保護下載中、單筆取消真 kill、context 失效防護。

### 關鍵踩雷（別重踩）
- content script 在 https 頁 fetch `http://127.0.0.1` 被擋 mixed-content → **下載一律走 background 或 scheme**。
- webRequest 三監聽器並發寫 storage 會互蓋 → `mutate()` promise 鏈序列化。
- 改 `main.scpt` 會壞 .app 簽章 → 每次 `codesign --force --deep -s -` 重簽；改 Info.plist scheme 後要 `lsregister -f`。
- 改 `server.js` 後 `.command` 會偵測舊版(戳 /enqueue 回 404)自動 pkill 重啟。
- **Brave 防指紋把 brands+UA 完全偽裝成 Chrome** → 瀏覽器偵測只能靠 `navigator.brave` 特徵(browserTag() in content/popup)。
- `/pending` GET 無法用 Origin 區分 App 的 curl 和惡意頁 `<img>`(都沒 Origin) → 用共享 token(`~/.videodl_token`,server 啟動生成 0600,App curl 讀檔帶上)。

### 沒做 / 未來
- 不搬油猴的 AES 解密 / ts→mp4 remux / mp4 多線程（yt-dlp 已包辦，冗餘）。
- P4 上架 Chrome Web Store（選配，$5）。
- i18n（第一版只 zh-TW）。

> 以下為 2026-07-04 原始規劃，保留供參考。實際實作已如上超出。

---

## 1. 為什麼做

- userscript 只能在頁面內攔 XHR/fetch，跨域 iframe 播放器（如 playmogo）常嗅不到。
- 原生擴充用 `chrome.webRequest` 監聽**整個瀏覽器**的網路請求（含 iframe / 背景 / worker），m3u8 一出現就抓 → 解決最大痛點。
- 不需要使用者先裝油猴。

## 2. 架構（跟 mediago 同分工）

```
背景 service worker (background.js)
  └ chrome.webRequest.onBeforeRequest 攔 *.m3u8 / *.m3u8?* / master.txt 偽裝
  └ 依 tabId 分組收集去重
  └ chrome.action.setBadgeText 顯示該分頁嗅到數量

popup (popup.html + popup.js)
  └ 讀當前分頁的資源清單
  └ 每筆一顆「下載」鈕 → POST 到 http://127.0.0.1:7654
  └ 「複製網址」「清空」

content script (content.js)  ← 選配，第二階段
  └ 頁內浮動面板（把現有 userscript 藥丸鈕 UI 搬過來）
  └ 手動貼 m3u8 欄

既有 server.js（幾乎不改）
  └ 已有 /probe (POST) + /download (SSE GET)，CORS 已開 *
  └ 只需新增 /enqueue：接 url → 背景 detached 下載 → 立即回 200
```

**分工原則**：擴充只負責「嗅 + 轉發」，不做解密/合併/下載。重活留 server.js，擴充薄好維護。

## 3. 檔案結構

```
600_Project/m3u8-sniffer/extension/
  manifest.json        # MV3
  background.js        # webRequest 攔截 + badge + 分頁分組
  popup.html
  popup.js             # 清單 + 下載鈕 → fetch server
  content.js           # (第二階段) 頁內面板
  icons/               # 16/32/48/128 png
```

## 4. manifest.json 重點（MV3）

```jsonc
{
  "manifest_version": 3,
  "name": "M3U8 嗅探下載器",
  "version": "1.0.0",
  "permissions": ["webRequest", "storage", "activeTab", "scripting"],
  "host_permissions": ["<all_urls>", "http://127.0.0.1:7654/*"],
  "background": { "service_worker": "background.js" },
  "action": { "default_popup": "popup.html" }
}
```

- `webRequest`（MV3 仍可**觀察**，只是不能阻擋；觀察 m3u8 URL 夠用）。
- `host_permissions` 要含 `http://127.0.0.1:7654/*` 才能從 popup fetch 本地。

## 5. 關鍵技術眉角（先講清楚免踩雷）

1. **MV3 webRequest 觀察 OK**：純讀取 URL 不需 blocking，MV3 允許。攔截點 `onBeforeRequest`，`urls: ["*://*/*.m3u8*"]` + 內容偵測補偽裝副檔名。
2. **service worker 會休眠**：狀態不能只放記憶體，收集的資源存 `chrome.storage.session`（或每次 badge 更新即寫入），popup 開啟時讀 storage。
3. **fetch 本地 http**：popup 是 extension 頁（`chrome-extension://`），fetch `http://127.0.0.1:7654` **不算 mixed-content**（extension 頁豁免），加上 `host_permissions` 即可，比 userscript 從 https 頁 fetch http 乾淨。
4. **server 新增 /enqueue**：現有 `/download` 是 SSE 綁連線、`req.on('close')` 會 kill 進程 → 不適合 fire-and-forget。新增 `/enqueue`：spawn 後 `unref()` detached，立即回 200，狀態進 GUI 清單（或寫暫存檔給 gui.html 輪詢）。
5. **referer / cookie**：外部 yt-dlp 下載仍可能撞 CF+cookie 鎖站（既有第④類）。這類站保留 userscript 的「瀏覽器 session 下載鈕」路線，擴充嗅到後標註「此站需頁內下載」。→ **擴充不完全取代 userscript，是互補**。

## 6. 安裝 / 散布

- **自己用**：`chrome://extensions` → 開發者模式 → 載入未封裝 → 選 `extension/`。免費永久。
- **給別人**：Chrome Web Store（一次性 $5 開發者費）或叫對方載入未封裝。
- Edge 同一份 manifest 可直接載入。

## 7. 分階段

- **P1（先做，打通閉環）✅ 2026-07-04**：manifest + background 攔 m3u8 + badge + popup 清單 + 下載鈕 → server 新增 `/enqueue` → 按鈕能觸發 App 下載。→ 達到 mediago 核心體感。
- **P2 ✅ 2026-07-04**：content.js 頁內浮動面板（紫玻璃藥丸鈕）+ 手動貼網址欄。下載走 background 轉發避 mixed-content。
- **P3 ✅ 2026-07-04**：偽裝副檔名 Content-Type 偵測、referer 從請求標頭自動帶、CF-cookie 站(cf-ray)標註「需頁內下載」、圖示程式生成。並發 storage 寫入用 promise 鏈序列化避 race。（i18n 依 §9 第一版不做）
- **P4（選）**：上 Chrome Web Store。尚未做。

## 8. 驗收（程式碼已備，待實機測）

- [x] 開有 m3u8 的頁 → badge 顯示數量（webRequest.onBeforeRequest + Content-Type 補抓）
- [x] 點擴充 → popup 列出資源（+ 頁內浮動面板兩套）
- [x] 按「下載」→ App（127.0.0.1:7654）/enqueue detached 下載 → ~/Downloads
- [x] 跨域 iframe 播放器也能嗅到（background 全域 webRequest，非頁內攔截）
- [x] 不需安裝油猴（原生 MV3 擴充）

## 9. 不做（範圍外）

- 擴充內不做解密/合併（留 server.js）。
- 不取代 userscript：CF+cookie 鎖站仍走 userscript 頁內下載。
- 第一版不上架、不做多語系。

---

## 執行入口（下個對話貼這段）

> 讀 `~/Dropbox/AI_agent/600_Project/m3u8-sniffer/SPEC_chrome-extension.md`，依 P1 建 `extension/` 骨架 + 改 `server.js` 加 `/enqueue`。做完給我載入未封裝的測試步驟。
