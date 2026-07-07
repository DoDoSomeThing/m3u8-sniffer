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
// 串流切片：一支影片幾百塊，抓了洗版還會讓人誤下到碎片（X 的 .m4s 就標 video/mp4）
// → 不收。抓 .m3u8/.mpd 母清單才是完整影片。
const SEG_EXT = /\.(ts|m4s|init|seg|frag|key|vtt|srt|aac)(\?|#|$)/i;
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

// ── master↔variant 收斂 ─────────────────────────────
// 一部 HLS 影片天生會抓到 master 母清單 + 各畫質 variant 子清單（720p/1080p/audio…），
// 全是 .m3u8 → 若不收斂會一片噴 7-9 條。inject 解析 manifest 帶回 children（子清單網址），
// 只留 master 一筆，其餘視為它的子項全部藏起來。

// 這個 url 是不是「某個已列 master 的子清單」→ 是就別再列
function childSuppressed(list, url) {
  return list.some((r) => Array.isArray(r.children) && r.children.includes(url));
}
// master 進來：記下它的 children，並回頭刪掉已經被列出的子清單
// （variant 的 GET 常比 master 解析完更早到，這裡補刪，解競態）
function attachMaster(list, url, children) {
  if (!Array.isArray(children) || !children.length) return false;
  const master = list.find((r) => r.url === url);
  if (master) master.children = children;
  let changed = !!master;
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].url !== url && children.includes(list[i].url)) { list.splice(i, 1); changed = true; }
  }
  return changed;
}

// ── 攔截：URL 副檔名（全格式）─────────────────────────
chrome.webRequest.onBeforeRequest.addListener(
  (d) => {
    if (d.tabId < 0) return;
    const t = extType(d.url);
    if (!t) return;
    console.log("[m3u8-ext] 抓到", t, ":", d.url.slice(0, 120), "tab", d.tabId);
    mutate((all) => {
      const list = all[d.tabId] || (all[d.tabId] = []);
      if (childSuppressed(list, d.url)) return false; // 已知 master 的子清單 → 不列
      const c = upsert(all, d.tabId, d.url, { type: t });
      setBadge(d.tabId, list.length);
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
    if (SEG_EXT.test(d.url)) return; // 切片碎塊，不收（Content-Type 常偽裝成 video/mp4）
    const urlT = extType(d.url);
    const ctT = ctType(ct);
    if (!urlT && !ctT) return; // 非影片

    // DASH init 標頭偽裝成 .mp4（X 的只有 ~786B）：完整影片不會 <100KB。
    // 這種 URL 帶副檔名，onBeforeRequest 已先收了 → 這裡看到 Content-Length 太小就踢掉。
    // 只套用在 mp4 類容器；m3u8/mpd 清單檔本來就小，不套用。
    const t0 = urlT || ctT;
    if (t0 !== "m3u8" && t0 !== "mpd") {
      const clen = parseInt(h.find((x) => x.name.toLowerCase() === "content-length")?.value || "0", 10);
      if (d.statusCode === 200 && clen > 0 && clen < 102400) {
        mutate((all) => {
          const list = all[d.tabId];
          if (!list) return false;
          const i = list.findIndex((r) => r.url === d.url);
          if (i < 0) return false;
          list.splice(i, 1);
          setBadge(d.tabId, list.length);
          return true;
        });
        return;
      }
    }

    // CF 特徵：cf-ray / server: cloudflare → 這站多半 CF+cookie 鎖，yt-dlp 外部下載易撞牆
    const cf = h.some((x) => {
      const n = x.name.toLowerCase();
      return n === "cf-ray" || (n === "server" && /cloudflare/i.test(x.value || ""));
    });
    if (!urlT && ctT) console.log("[m3u8-ext] 偽裝抓到", ctT, ":", d.url.slice(0, 120));
    mutate((all) => {
      const list = all[d.tabId] || (all[d.tabId] = []);
      if (childSuppressed(list, d.url)) return false; // 已知 master 的子清單 → 不列
      const c = upsert(all, d.tabId, d.url, {
        type: urlT || ctT,
        masked: !urlT && ctT ? true : undefined,
        needsInPage: cf ? true : undefined,
      });
      setBadge(d.tabId, list.length);
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
// tabId → 上次 pathname（SPA 換頁判斷基準）。
// 記憶體只當快取：service worker 閒置 ~30 秒就休眠、記憶體歸零，
// 基準必須落在 storage.session 才不會「看片超過 30 秒後換頁不重置」。
const TAB_PATH = {};
async function loadPath(tabId) {
  if (TAB_PATH[tabId] !== undefined) return TAB_PATH[tabId];
  const o = await chrome.storage.session.get("tabPaths");
  return (o.tabPaths || {})[tabId];
}
function savePath(tabId, p) {
  TAB_PATH[tabId] = p;
  chrome.storage.session.get("tabPaths").then((o) => {
    const tp = o.tabPaths || {};
    tp[tabId] = p;
    chrome.storage.session.set({ tabPaths: tp });
  }).catch(() => {});
}
// 每次真正導航（換頁/重整/前後退）一律重置該分頁清單，順便記 pathname 基準
chrome.webNavigation.onCommitted.addListener((d) => {
  if (d.frameId !== 0) return;
  let p = "";
  try { p = new URL(d.url).pathname; } catch {}
  savePath(d.tabId, p);
  clearTab(d.tabId);
});
// SPA(pushState) 換頁不觸發 onCommitted → 舊資源會殘留混進新頁，這裡補清。
// 只在 pathname 真的變了才清（播放器常 pushState 改 query/時間戳，那不算換片）。
chrome.webNavigation.onHistoryStateUpdated.addListener(async (d) => {
  if (d.frameId !== 0) return;
  let p = "";
  try { p = new URL(d.url).pathname; } catch {}
  const prev = await loadPath(d.tabId);
  savePath(d.tabId, p);
  if (prev !== p) clearTab(d.tabId); // 沒基準(undefined)也清：寧可多清不殘留
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
          const list = all[tabId] || (all[tabId] = []);
          // 是已知 master 的子清單、且自己不是 master → 不列（inject 可能先送 variant 再送 master，故排除自身）
          if (!msg.isMaster && childSuppressed(list, msg.url)) return false;
          let c = upsert(all, tabId, msg.url, { type: t, referer: msg.referer });
          // master 母清單：記 children + 回頭刪掉已列的子清單
          if (msg.isMaster && attachMaster(list, msg.url, msg.children)) c = true;
          setBadge(tabId, list.length);
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
