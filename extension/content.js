// content.js — 頁內浮動面板（P2）。只在頂層頁畫 UI；iframe 不畫，嗅探由 background 全域負責。
// 下載一律 sendMessage 給 background 轉發，避開 https 頁 fetch http 的 mixed-content。
console.log("[m3u8-ext] content injected @", location.href, "top=", window.top === window);
if (window.top === window) {
  (function () {
    const host = document.createElement("div");
    host.id = "__m3u8_sniffer_host";
    host.style.cssText = "position:fixed;z-index:2147483647;top:0;left:0;width:0;height:0;";
    const shadow = host.attachShadow({ mode: "open" });
    (document.body || document.documentElement).appendChild(host);

    shadow.innerHTML = `
<style>
  .pill { position: fixed; right: 20px; top: 20px; width: 44px; height: 44px; border-radius: 50%;
    display: flex; align-items: center; justify-content: center; color: #fff; cursor: pointer; user-select: none;
    background: linear-gradient(135deg,#6366f1,#8b5cf6); box-shadow: 0 4px 16px rgba(139,92,246,.5);
    transition: transform .12s, box-shadow .12s; }
  .pill:hover { transform: scale(1.08); box-shadow: 0 6px 22px rgba(139,92,246,.6); }
  .pill.active { animation: pulse 2s infinite; }
  @keyframes pulse { 0%,100%{box-shadow:0 4px 16px rgba(139,92,246,.5)} 50%{box-shadow:0 4px 26px rgba(239,68,68,.7)} }
  .badge { position: absolute; top: -4px; right: -4px; min-width: 18px; height: 18px; padding: 0 4px;
    border-radius: 9px; background: #ef4444; color: #fff; font: 700 11px/18px sans-serif; text-align: center; }
  .badge[hidden] { display: none; }
  .panel { position: fixed; right: 20px; bottom: 74px; width: 380px; max-height: 70vh; overflow: hidden;
    display: none; flex-direction: column; background: rgba(20,20,28,.86); backdrop-filter: blur(18px);
    border: 1px solid rgba(255,255,255,.12); border-radius: 14px; box-shadow: 0 12px 48px rgba(0,0,0,.5);
    color: #e5e7eb; font: 13px/1.5 -apple-system,"Segoe UI",sans-serif; }
  .panel.open { display: flex; }
  .head { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid rgba(255,255,255,.1); }
  .head b { flex: 1; font-size: 13px; }
  .head .x { cursor: pointer; opacity: .7; padding: 0 4px; }
  .manual { display: flex; gap: 6px; padding: 10px 12px; }
  .mInput { flex: 1; background: rgba(0,0,0,.3); border: 1px solid rgba(255,255,255,.12); border-radius: 8px;
    color: #e5e7eb; padding: 6px 9px; font-size: 12px; outline: none; }
  .mInput:focus { border-color: #8b5cf6; }
  .mBtn { border: none; border-radius: 8px; padding: 0 12px; font-size: 12px; font-weight: 600; cursor: pointer;
    color: #fff; background: linear-gradient(135deg,#6366f1,#8b5cf6); }
  .list { overflow-y: auto; padding: 0 12px 12px; display: flex; flex-direction: column; gap: 6px; }
  .list::-webkit-scrollbar { width: 7px; } .list::-webkit-scrollbar-thumb { background: rgba(255,255,255,.18); border-radius: 4px; }
  .empty { padding: 18px; text-align: center; opacity: .55; }
  .item { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; padding: 8px; border-radius: 9px; background: rgba(255,255,255,.05); }
  .item:hover { background: rgba(255,255,255,.09); }
  .tag { padding: 2px 7px; border-radius: 6px; font-size: 11px; font-weight: 700; background: rgba(139,92,246,.25); color: #c4b5fd; }
  .url { flex: 1 1 100%; word-break: break-all; font-size: 11px; opacity: .8; }
  .warn { flex: 1 1 100%; font-size: 11px; color: #fcd34d; background: rgba(252,211,77,.1); border-radius: 6px; padding: 4px 7px; }
  .btn { border: none; border-radius: 6px; padding: 4px 9px; font-size: 12px; cursor: pointer; color: #fff; background: rgba(255,255,255,.14); }
  .btn:hover { background: rgba(255,255,255,.26); }
  .btn.dl { background: linear-gradient(135deg,#6366f1,#8b5cf6); }
  .toast { padding: 0 12px 8px; font-size: 11px; min-height: 14px; color: #86efac; }
</style>
<div class="pill" title="M3U8 嗅探"><svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M8 5v14l11-7z"/></svg><span class="badge" hidden>0</span></div>
<div class="panel">
  <div class="head"><b>M3U8 嗅探</b><span class="x" title="關閉">✕</span></div>
  <div class="manual"><input class="mInput" placeholder="貼 m3u8 網址手動下載（自動漏抓時用）"><button class="mBtn">加入</button></div>
  <div class="toast"></div>
  <div class="list"><div class="empty">尚未嗅到 m3u8</div></div>
</div>`;

    const $ = (s) => shadow.querySelector(s);
    const pill = $(".pill"), badge = $(".badge"), panel = $(".panel");
    const list = $(".list"), mInput = $(".mInput"), toastEl = $(".toast");
    let open = false;

    function toast(msg, color) {
      toastEl.textContent = msg; toastEl.style.color = color || "#86efac";
      clearTimeout(toast._t); toast._t = setTimeout(() => (toastEl.textContent = ""), 2500);
    }

    function msg(m) {
      return new Promise((res) => {
        // 擴充重載後舊分頁 context 失效 → chrome.runtime 變 undefined，靜默略過
        if (!chrome.runtime?.id) return res({});
        try {
          chrome.runtime.sendMessage(m, (r) => { void chrome.runtime.lastError; res(r || {}); });
        } catch { res({}); }
      });
    }
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    // 檔名 = 網頁標題(劇名)，砍「 - 站名 / | 站名」後綴 + 清非法字元
    function pageTitleName() {
      let t = (document.title || "").split(" - ")[0].split(" | ")[0].split("｜")[0];
      return t.replace(/[\\/:*?"<>|]+/g, "_").replace(/\s+/g, " ").trim();
    }

    // 偵測自己跑在哪個瀏覽器 → App 開對應瀏覽器的視窗（不然永遠開 Chrome）
    // Brave 防指紋會把 brands/UA 偽裝成 Chrome → 只能靠它專屬的 navigator.brave 認
    function browserTag() {
      if (navigator.brave?.isBrave) return "brave";
      const brands = (navigator.userAgentData?.brands || []).map((b) => b.brand.toLowerCase()).join(" ");
      const ua = navigator.userAgent;
      if (brands.includes("edge") || / Edg\//.test(ua)) return "edge";
      if (brands.includes("opera") || / OPR\//.test(ua)) return "opera";
      if (brands.includes("vivaldi") || /Vivaldi/.test(ua)) return "vivaldi";
      return "chrome";
    }

    // 用隱藏 iframe 觸發 videodl:// 協定，不會把當前頁導走
    function openScheme(url, referer, name) {
      const qs = new URLSearchParams({ url, referer: referer || "", name: name || "", browser: browserTag() }).toString();
      const f = document.createElement("iframe");
      f.style.display = "none";
      f.src = "videodl://download?" + qs;
      document.body.appendChild(f);
      setTimeout(() => f.remove(), 1500);
    }

    // 下載：一律用 videodl:// 喚起 App → App 會「送下載 + 把影片下載器視窗帶到最前」。
    // 不管 App 本來開沒開都走這條，確保按下載一定跳到影片下載器。
    async function startDownload(r) {
      const referer = r.referer || location.href;
      const name = r.name || pageTitleName(); // 檔名優先劇名，空的讓 yt-dlp 抓標題
      openScheme(r.url, referer, name);
      toast("開啟影片下載器…", "#fcd34d");
      for (let i = 0; i < 20; i++) { // 20s：涵蓋首次啟 server 較慢的情況
        await sleep(1000);
        if ((await msg({ type: "ping" })).up) { toast("下載中 → 影片下載器"); return; }
      }
      toast("App 沒回應，請確認已安裝「影片下載器」", "#fca5a5");
    }

    async function refresh() {
      const { list: items = [] } = await msg({ type: "getResources" });
      const n = items.length;
      badge.textContent = n; badge.hidden = n === 0;
      pill.classList.toggle("active", n > 0);
      if (!open) return;
      if (!n) { list.innerHTML = '<div class="empty">尚未嗅到 m3u8</div>'; return; }
      list.innerHTML = "";
      items.slice().reverse().forEach((r) => {
        const it = document.createElement("div"); it.className = "item";
        const tag = (r.type || "video").toUpperCase() + (r.masked ? "·偽裝" : (r.manual ? "·手動" : ""));
        const warn = r.needsInPage ? '<div class="warn">⚠ 此站疑 CF 鎖，外部下載可能失敗，建議用頁內下載鈕</div>' : "";
        it.innerHTML = `<span class="tag">${tag}</span><button class="btn dl">下載</button><button class="btn cp">複製</button><div class="url"></div>${warn}`;
        it.querySelector(".url").textContent = r.url;
        it.querySelector(".dl").onclick = () => startDownload(r);
        // hover 清單項 → 在頁面框選對應影片（怕影片多/廣告多下載錯）
        it.addEventListener("mouseenter", () => msg({ type: "highlight", url: r.url }));
        it.addEventListener("mouseleave", () => msg({ type: "highlight", url: null }));
        it.querySelector(".cp").onclick = async () => { await navigator.clipboard.writeText(r.url); toast("已複製"); };
        list.append(it);
      });
    }

    $(".mBtn").onclick = async () => {
      const url = mInput.value.trim();
      if (!/^https?:\/\//i.test(url)) { toast("要 http 開頭的網址", "#fca5a5"); return; }
      await msg({ type: "addManual", url, referer: location.href });
      mInput.value = "";
      refresh();
    };
    mInput.addEventListener("keydown", (e) => { if (e.key === "Enter") $(".mBtn").click(); });

    // ── 藥丸拖曳 + 位置記憶（8）──
    function setPillPos(left, top) {
      // 夾在視窗內，藥丸不超出邊界
      left = Math.max(8, Math.min(innerWidth - 52, left));
      top = Math.max(8, Math.min(innerHeight - 52, top));
      pill.style.left = left + "px"; pill.style.top = top + "px";
      pill.style.right = "auto"; pill.style.bottom = "auto";
    }
    function placePanel() {
      const r = pill.getBoundingClientRect();
      // 水平：面板靠齊藥丸、夾在視窗內
      panel.style.left = Math.max(10, Math.min(r.left + r.width - 380, innerWidth - 390)) + "px";
      panel.style.right = "auto";
      // 垂直：預設開在藥丸下方；下方空間不足才往上
      const belowRoom = innerHeight - r.bottom;
      if (belowRoom > 240) {
        panel.style.top = (r.bottom + 8) + "px"; panel.style.bottom = "auto";
      } else {
        panel.style.bottom = (innerHeight - r.top + 8) + "px"; panel.style.top = "auto";
      }
    }
    function toggle() { open = !open; if (open) placePanel(); panel.classList.toggle("open", open); refresh(); }

    // 還原上次位置（posVer<2 = 舊版右下/亂位，清掉套新預設右上角）
    try {
      chrome.storage.local.get(["pillPos", "posVer"], (o) => {
        if (!o || o.posVer !== 2) { chrome.storage.local.set({ posVer: 2 }); chrome.storage.local.remove("pillPos"); return; }
        if (o.pillPos) setPillPos(o.pillPos.left, o.pillPos.top);
      });
    } catch {}

    // 拖曳（移動 >5px 算拖動，否則算點擊開關面板）
    (function makeDraggable() {
      let sx, sy, moved, startLeft, startTop;
      pill.addEventListener("mousedown", (e) => {
        e.preventDefault();
        moved = false; sx = e.clientX; sy = e.clientY;
        const r = pill.getBoundingClientRect();
        startLeft = r.left; startTop = r.top;
        const mm = (ev) => {
          const dx = ev.clientX - sx, dy = ev.clientY - sy;
          if (!moved && Math.abs(dx) + Math.abs(dy) > 5) moved = true;
          if (moved) { setPillPos(startLeft + dx, startTop + dy); if (open) placePanel(); }
        };
        const mu = () => {
          document.removeEventListener("mousemove", mm);
          document.removeEventListener("mouseup", mu);
          if (!moved) toggle();
          else { const r2 = pill.getBoundingClientRect(); try { chrome.storage.local.set({ pillPos: { left: r2.left, top: r2.top } }); } catch {} }
        };
        document.addEventListener("mousemove", mm);
        document.addEventListener("mouseup", mu);
      });
    })();

    $(".x").onclick = () => { open = false; panel.classList.remove("open"); };

    // 點面板/藥丸以外收起
    document.addEventListener("click", (e) => {
      if (open && !e.composedPath().includes(host)) { open = false; panel.classList.remove("open"); }
    });

    // 背景可能在面板開著時嗅到新資源 → 輪詢更新 badge/清單
    setInterval(refresh, 1500);
    refresh();
  })();
}
