# 影片下載工具組（m3u8-sniffer）

自製、全本地、不外送任何網址。一套搞定 m3u8 / mp4 影音的「嗅探 + 下載」。
**核心（2026-07 改版）：原生 Chrome/Edge 擴充嗅探 → 一鍵喚起本地 App 下載。** 不再依賴油猴。

## 元件總覽

| 檔案 | 用途 | 平台 |
| :--- | :--- | :--- |
| `extension/` | **原生 MV3 擴充**：全域嗅探 + 一鍵轉發下載（主力） | Chrome / Edge |
| `影片下載器.app` / `.command` | 雙擊啟動本地下載器（server + GUI） | Mac |
| `影片下載器.bat` | 雙擊啟動本地下載器 | Windows |
| `server.js` + `gui.html` | 下載後端（yt-dlp）+ 進度介面 | 跨平台 |
| `m3u8-sniffer.user.js` | 舊版油猴 userscript（互補：CF+cookie 鎖站頁內下載） | 跨平台 |
| `m3u8dl.zsh` | CLI 函式 `vdl` / `seriesdl` | Mac（zsh） |
| `series_extract.js` | Playwright 無頭抓 m3u8（`seriesdl` 用） | 跨平台（需各機裝 playwright） |

### `extension/` 內部
`manifest.json`（MV3）· `background.js`（webRequest 全域嗅探 + badge + 下載轉發）· `sniff.js`+`inject.js`（頁面層 hook fetch/XHR 讀 body + DOM 掃描，跨 iframe）· `content.js`（頁內浮動面板）· `popup.js`（工具列面板）

---

## 下載方式

### 1. 原生擴充（主力，推薦）
把整個瀏覽器的網路請求都嗅一遍（含跨域 iframe 播放器），比油猴更全。按下載自動喚起本地 App，全程不用先開任何東西。

**安裝（載入未封裝）**
1. Mac：先建下載器 App（見下方安裝）；`chrome://extensions` → 開「開發者模式」→「載入未封裝項目」→ 選 `extension/` 資料夾。Edge 同一份可載入。
2. 首次按下載會跳兩個系統詢問（Chrome：開啟「影片下載器」；macOS：允許控制 Chrome/Terminal），勾「一律允許」後就順。

**功能**
- 全格式嗅探：m3u8 / mp4 / mpd / webm / mkv / mov / m4v / flv…（含 Content-Type 偽裝副檔名補抓）
- 頁內浮動藥丸鈕（可拖曳、記位置）+ 工具列 popup 兩套面板
- **hover 清單項 → 頁面上對應影片被框起來**（怕影片多/廣告多下載錯）
- 手動貼網址、CF 站標註、referer 自動帶
- 按下載 → `videodl://` 喚起 App（沒開自動啟動）→ 跳**規格小窗**（畫質/檔名/位置）→ 確認才下
- 檔名自動帶網頁標題（劇名）

### 2. 本地 App / GUI（下載後端，也可單用）
- Mac：雙擊 `影片下載器.app`；Windows：雙擊 `影片下載器.bat`
- 介面 `http://127.0.0.1:7654`：貼網址 → 解析畫質 → 下載，即時進度（✕取消 / 清除完成 / 全部清除，下載中不會被清）
- yt-dlp 借 Chrome cookie（`--cookies-from-browser chrome`）→ 過 anime1 / CF+cookie 站的 403
- 下到 `~/Downloads`（規格小窗可改位置）

### 3. CLI（Mac）
```bash
vdl <網址>                 # 萬用：支援站直解 / m3u8 直下 / 不支援給提示
vdl <網址> 檔名 <referer>   # 防盜鏈帶 referer
seriesdl <ep1網址> 起 迄    # 整劇自動下（JS 動態站，用無頭瀏覽器逐集抓）
```

### 4. userscript（舊版，互補）
原生擴充已取代大部分功能。userscript 保留給**純瀏覽器 session 下載**（CF+cookie 鎖站，外部 yt-dlp 過不了時）。
- 先裝 [Tampermonkey](https://www.tampermonkey.net/) → 再點 **[👉 一鍵安裝腳本](https://raw.githubusercontent.com/DoDoSomeThing/m3u8-sniffer/main/m3u8-sniffer.user.js)**
- 下載走瀏覽器 session（cookie 自動帶）→ 能過 cookie 鎖的 CF 站

---

## 找網址：DevTools 最可靠

自動嗅探（userscript）對 iframe / 反爬蟲 / 偽裝副檔名的站時靈時不靈。**找不到時用 DevTools，一定看得到**：

```
F12 → Network → 篩 "master" 或 "m3u8" → 按播放 → 右鍵那條 → Copy link address
```
Content-Type 是 `application/vnd.apple.mpegurl` 或內容開頭 `#EXTM3U` 的就是 playlist。

---

## 站點分四類，對應工具

| 站類型 | 找網址 | 下載 |
| :--- | :--- | :--- |
| yt-dlp 支援站（主流平台約1800個） | 直接貼觀看頁 | GUI / vdl |
| JS 動態注入 m3u8 | userscript / DevTools | GUI / vdl / seriesdl |
| 純 Cloudflare 反爬蟲（無 cookie 鎖） | DevTools | GUI（已內建 `--impersonate chrome`） |
| **CF + cookie/session 鎖** | DevTools | **userscript 手動欄**（瀏覽器 session 才過，外部工具必 403） |
| **token 綁 IP/時間** | DevTools | GUI（同一台機、趁未過期即可） |

---

## 安裝

### Mac
```bash
brew install yt-dlp ffmpeg
pip install curl_cffi          # 給 yt-dlp --impersonate（過 CF）
# seriesdl 要 playwright：
cd 此資料夾 && npm install playwright && npx playwright install chromium
```
`~/.zshrc` 加一行：`source <此 repo 路徑>/m3u8dl.zsh`

### Windows
```powershell
winget install OpenJS.NodeJS
winget install yt-dlp.yt-dlp
winget install Gyan.FFmpeg
pip install curl_cffi          # 過 CF（需先有 Python）
```
裝完重開終端機讓 PATH 生效 → 雙擊 `影片下載器.bat`（首次會自動註冊 `videodl://` 協定 + 啟 server）。

**擴充一鍵下載要能用,`videodl://` 協定必須註冊**（Mac 靠 `.app` 的 Info.plist,Windows 靠登錄檔）:
- `影片下載器.bat` 首次執行會自動跑 `register_videodl_win.bat`（寫 `HKCU\Software\Classes\videodl` → 指向 `videodl_win.js`,免系統管理員）。
- 沒註冊的話,擴充按「下載/本頁」發出的 `videodl://` Windows 沒程式接 → **靜默無反應**。手動補註冊:雙擊 `register_videodl_win.bat`。
- `videodl_win.js` = Windows 版協定處理程式:server 沒跑就背景啟 → 排下載 → 開 GUI 確認(等同 Mac 的 `影片下載器.applescript`)。

（`vdl`/`seriesdl` 是 zsh，Windows 要 git-bash/WSL 才能用；GUI 不受影響。）

### userscript（兩台共用）
1. 先裝 [Tampermonkey](https://www.tampermonkey.net/)
2. 點 **[👉 一鍵安裝腳本](https://raw.githubusercontent.com/DoDoSomeThing/m3u8-sniffer/main/m3u8-sniffer.user.js)** → Tampermonkey 自動跳安裝頁，按「安裝」即可（之後改版會自動檢查更新）

兩台同步建議用 **TM 內建雲端同步**（工具→雲端同步→Google Drive/Dropbox，兩台登同帳號）。

---

## 設計原則（避開市面腳本的雷）
- 全本地，不外送任何 URL / referer / 標題到第三方
- 不把 GM API 掛 `unsafeWindow`（不開跨域後門）
- 無廣告、無導流
- AES-128 用 WebCrypto，IV 正確 hex 解析

## 版本
- **原生擴充 v1.0.0（2026-07）** — MV3 嗅探 + App 喚起 + 規格小窗 + hover 框選
- GUI / userscript v1.2.1（2026-06）
