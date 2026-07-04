// 背景 service worker：webRequest 觀察 m3u8 → 依 tabId 分組去重 → badge + storage.session
// MV3 service worker 會休眠，狀態一律存 chrome.storage.session，popup / content 開啟時讀。

const STORE_KEY = "resources"; // { [tabId]: [ {url, type, ts, referer, masked, needsInPage, manual} ] }
const SERVER = "http://127.0.0.1:7654";

// 支援全格式：URL 副檔名直接看得出（含 query，如 ...mp4?token=）
// 刻意不含 .ts：HLS 切片一支影片上百個會洗版；抓到 .m3u8 母清單即可。
const VIDEO_EXT = /\.(m3u8|mpd|mp4|m4v|mov|webm|mkv|flv|f4v|avi|wmv|ogv)(\?|#|$)/i;
function extType(url) {
  const m = url.match(VIDEO_EXT);
  return m ? m[1].toLowerCase() : null;
}
// 偽裝副檔名靠 Content-Type 補抓（.txt / 無副檔名卻是影片或 HLS/DASH 清單）
function ctType(ct) {
  if (/mpegurl/i.test(ct)) return "m3u8";
  if (/dash\+xml/i.test(ct)) return "mpd";
  const m = ct.match(/video\/([a-z0-9.+-]+)/i);
  if (m) {
    let t = m[1].toLowerCase();
    if (t === "mp2t") return null;         // .ts 切片，跳過
    if (t === "x-matroska") return "mkv";
    if (t === "quicktime") return "mov";
    if (t === "x-msvideo") return "avi";
    if (t === "x-flv") return "flv";
    return t;                               // mp4 / webm / ogg...
  }
  return null;
}

async function loadAll() {
  const o = await chrome.storage.session.get(STORE_KEY);
  return o[STORE_KEY] || {};
}
async function saveAll(all) {
  await chrome.storage.session.set({ [STORE_KEY]: all });
}

// 序列化所有 storage 變更：webRequest 三個監聽器會並發，各自 load→改→save
// 若不排隊，後寫的會蓋掉前者（掉資源）。用一條 promise 鏈確保原子性。
let mutChain = Promise.resolve();
function mutate(fn) {
  mutChain = mutChain.then(async () => {
    const all = await loadAll();
    const changed = await fn(all);
    if (changed) await saveAll(all);
    return changed;
  }).catch((e) => { console.error("[mutate]", e); });
  return mutChain;
}

// badge 數字在 mutate 回呼內算（鏈內快照才準），這裡只負責畫
async function setBadge(tabId, n) {
  try {
    await chrome.action.setBadgeText({ tabId, text: n > 0 ? String(n) : "" });
    await chrome.action.setBadgeBackgroundColor({ tabId, color: "#e53935" });
  } catch (e) { /* tab 可能已關 */ }
}

// 新增或就地更新一筆資源（patch 會併進既有筆）
function upsert(all, tabId, url, patch) {
  if (tabId < 0 || !url) return false;
  const list = all[tabId] || (all[tabId] = []);
  const found = list.find((r) => r.url === url);
  if (found) {
    let touched = false;
    for (const k in patch) {
      if (patch[k] != null && found[k] == null) { found[k] = patch[k]; touched = true; }
    }
    return touched;
  }
  list.push({ url, ts: Date.now(), type: patch.type || "video", ...patch });
  return true;
}

// ── 攔截：URL 副檔名（全格式）─────────────────────────
chrome.webRequest.onBeforeRequest.addListener(
  (d) => {
    if (d.tabId < 0) return;
    const t = extType(d.url);
    if (!t) return;
    console.log("[m3u8-ext] 抓到", t, ":", d.url.slice(0, 120), "tab", d.tabId);
    mutate((all) => {
      const c = upsert(all, d.tabId, d.url, { type: t });
      setBadge(d.tabId, (all[d.tabId] || []).length);
      return c;
    });
  },
  { urls: ["<all_urls>"] }
);

// ── referer 自動帶：從真實請求標頭抓 Referer，補進對應資源 ──
chrome.webRequest.onBeforeSendHeaders.addListener(
  (d) => {
    if (d.tabId < 0 || !extType(d.url)) return;
    const ref = (d.requestHeaders || []).find((h) => h.name.toLowerCase() === "referer");
    if (!ref?.value) return;
    mutate((all) => upsert(all, d.tabId, d.url, { referer: ref.value }));
  },
  { urls: ["<all_urls>"] },
  ["requestHeaders"]
);

// ── 回應標頭：偽裝副檔名(Content-Type) + CF 站標註 ──
chrome.webRequest.onHeadersReceived.addListener(
  (d) => {
    if (d.tabId < 0) return;
    const h = d.responseHeaders || [];
    const ct = h.find((x) => x.name.toLowerCase() === "content-type")?.value || "";
    const urlT = extType(d.url);
    const ctT = ctType(ct);
    if (!urlT && !ctT) return; // 非影片

    // CF 特徵：cf-ray / server: cloudflare → 這站多半 CF+cookie 鎖，yt-dlp 外部下載易撞牆
    const cf = h.some((x) => {
      const n = x.name.toLowerCase();
      return n === "cf-ray" || (n === "server" && /cloudflare/i.test(x.value || ""));
    });
    if (!urlT && ctT) console.log("[m3u8-ext] 偽裝抓到", ctT, ":", d.url.slice(0, 120));
    mutate((all) => {
      const c = upsert(all, d.tabId, d.url, {
        type: urlT || ctT,
        masked: !urlT && ctT ? true : undefined,
        needsInPage: cf ? true : undefined,
      });
      setBadge(d.tabId, (all[d.tabId] || []).length);
      return c;
    });
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders"]
);

// ── 分頁生命週期：換頁清空、關閉移除 ──
function clearTab(tabId) {
  mutate((all) => { if (all[tabId]) { delete all[tabId]; return true; } return false; })
    .then(() => setBadge(tabId, 0));
}
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading" && changeInfo.url) clearTab(tabId);
});
// SPA(pushState) 換頁不觸發 onUpdated{loading,url} → 舊資源會殘留混進新頁，這裡補清。
// 只在 pathname 真的變了才清（播放器常 pushState 改 query/時間戳，那不算換片）。
const TAB_PATH = {}; // tabId → 上次 pathname（worker 休眠會歸零，只影響漏清一次，可接受）
chrome.webNavigation.onHistoryStateUpdated.addListener((d) => {
  if (d.frameId !== 0) return;
  let p = "";
  try { p = new URL(d.url).pathname; } catch {}
  if (TAB_PATH[d.tabId] !== undefined && TAB_PATH[d.tabId] !== p) clearTab(d.tabId);
  TAB_PATH[d.tabId] = p;
});
chrome.tabs.onRemoved.addListener((tabId) => {
  delete TAB_PATH[tabId];
  mutate((all) => { if (all[tabId]) { delete all[tabId]; return true; } return false; });
});

// ── content script 手動貼網址 ──
function addManual(all, tabId, url, referer) {
  return upsert(all, tabId, url, { type: extType(url) || "video", referer, manual: true });
}

// server 健康檢查（scheme 喚起後輪詢用）
// （舊 enqueueDownload 直連轉發已刪：下載一律走 videodl:// scheme，才能喚起/聚焦 App）
async function pingServer() {
  try {
    await fetch(`${SERVER}/jobs`, { signal: AbortSignal.timeout(2000) });
    return true;
  } catch { return false; }
}

// popup 按下載後自己會關（App 搶焦點），無法顯示成敗 → background 代盯：
// 20 秒內 server 沒起來就發系統通知（成功不吵）。
async function watchLaunch() {
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    if (await pingServer()) return;
  }
  try {
    chrome.notifications.create({
      type: "basic",
      iconUrl: "icons/icon128.png",
      title: "影片下載器",
      message: "App 沒回應，請確認已安裝「影片下載器」",
    });
  } catch (e) { console.error("[watchLaunch]", e); }
}

// ── popup / content 訊息 ──
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    const tabId = msg.tabId ?? sender?.tab?.id ?? -1; // popup 傳 tabId；content 用 sender.tab.id
    try {
      if (msg.type === "getResources") {
        const all = await loadAll();
        sendResponse({ list: all[tabId] || [] });
      } else if (msg.type === "clear") {
        await mutate((all) => { if (all[tabId]) { delete all[tabId]; return true; } return false; });
        await setBadge(tabId, 0);
        sendResponse({ ok: true });
      } else if (msg.type === "addManual") {
        await mutate((all) => {
          const c = addManual(all, tabId, msg.url, msg.referer);
          setBadge(tabId, (all[tabId] || []).length);
          return c;
        });
        sendResponse({ ok: true });
      } else if (msg.type === "addSniffed") {
        // content/inject 內容嗅探 + DOM 掃描來的資源
        const t = extType(msg.url) || msg.mtype || "video";
        await mutate((all) => {
          const c = upsert(all, tabId, msg.url, { type: t, referer: msg.referer });
          setBadge(tabId, (all[tabId] || []).length);
          return c;
        });
        sendResponse({ ok: true });
      } else if (msg.type === "ping") {
        sendResponse({ up: await pingServer() });
      } else if (msg.type === "watchLaunch") {
        watchLaunch(); // 不 await：popup 馬上要關，背景自己盯
        sendResponse({ ok: true });
      } else if (msg.type === "highlight") {
        // 廣播到該分頁所有 frame（含 iframe 播放器）→ sniff.js 框選對應影片
        try { chrome.tabs.sendMessage(tabId, { type: "doHighlight", url: msg.url }); } catch {}
        sendResponse({ ok: true });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String(e.message) });
    }
  })();
  return true; // async sendResponse
});
