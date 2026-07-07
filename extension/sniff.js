// sniff.js — 跑在每個 frame（含跨域 iframe 播放器）的 document_start。
// 職責：①注入 inject.js（頁面 context hook fetch/XHR 讀 body）②掃 DOM video/source
//       ③把找到的資源轉給 background。UI 不在這（由 content.js 只在頂層畫）。

// ① 注入頁面層 hook（content script 是隔離世界，攔不到頁面自己的 fetch/XHR，需注入）
try {
  const s = document.createElement("script");
  s.src = chrome.runtime.getURL("inject.js");
  (document.head || document.documentElement).appendChild(s);
  s.onload = () => s.remove();
} catch (e) {}

// 統一送訊：擴充重載後 context 失效 → chrome.runtime 變 undefined，靜默略過
function send(m) {
  if (!chrome.runtime?.id) return;
  try { chrome.runtime.sendMessage(m, () => void chrome.runtime.lastError); } catch {}
}

// 收 inject.js 回傳的資源 → 交給 background
window.addEventListener("message", (e) => {
  const d = e.data;
  if (!d || d.__m3u8sniff !== 1 || !d.url) return;
  if (/^blob:|^data:/i.test(d.url)) return;
  // isMaster/children：inject 解析 manifest 帶回 → background 用來收斂 master↔variant
  send({ type: "addSniffed", url: d.url, mtype: d.type, referer: location.href, isMaster: d.isMaster, children: d.children });
});

// ② 掃 DOM <video>/<source>（有些站直接把網址掛在 src，不發網路請求給 webRequest 抓）
const V_EXT = /\.(m3u8|mpd|mp4|m4v|mov|webm|mkv|flv)(\?|#|$)/i;
const EL_MAP = new Map(); // 資源 URL → 頁面上對應的 <video>/<source> 元素（供 hover 框選）
function scanDom() {
  document.querySelectorAll("video, source").forEach((el) => {
    const src = el.currentSrc || el.src || el.getAttribute("src") || "";
    if (!/^https?:/i.test(src)) return;
    // 對應到可框的播放元素（source 記其父 video）
    EL_MAP.set(src, el.tagName === "SOURCE" ? (el.closest("video") || el) : el);
    const m = src.match(V_EXT);
    const mtype = m ? m[1].toLowerCase() : "video";
    send({ type: "addSniffed", url: src, mtype, referer: location.href });
  });
}
try {
  scanDom();
  const mo = new MutationObserver(scanDom);
  mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["src"] });
  let n = 0;
  const t = setInterval(() => { scanDom(); if (++n >= 10) clearInterval(t); }, 1000);
} catch (e) {}

// ③ hover 框選：content.js hover 清單項 → background 廣播 doHighlight 到每個 frame
let HL = []; // 目前高亮的元素（供還原）
function clearHighlight() {
  for (const h of HL) { try { h.el.style.outline = h.o; h.el.style.outlineOffset = h.oo; h.el.style.boxShadow = h.bs; } catch {} }
  HL = [];
}
function highlight(els) {
  clearHighlight();
  els.forEach((el, i) => {
    try {
      HL.push({ el, o: el.style.outline, oo: el.style.outlineOffset, bs: el.style.boxShadow });
      el.style.outline = "3px solid #8b5cf6";
      el.style.outlineOffset = "2px";
      el.style.boxShadow = "0 0 0 6px rgba(139,92,246,.35)";
      if (i === 0) el.scrollIntoView({ block: "center", behavior: "smooth" });
    } catch {}
  });
}
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.type !== "doHighlight") return;
  if (!msg.url) { clearHighlight(); return; }
  const exact = EL_MAP.get(msg.url);
  if (exact && exact.isConnected) { highlight([exact]); return; } // 精準：DOM 掃到的元素
  // 後備：此 frame 的所有有效 <video>（網路嗅到的無法對應元素時用）
  const vids = [...document.querySelectorAll("video")].filter((v) => (v.currentSrc || v.src));
  if (vids.length) highlight(vids);
});
