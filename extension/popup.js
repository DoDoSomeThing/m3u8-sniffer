// popup：讀當前分頁資源清單 → 每筆下載鈕 POST /enqueue，另有複製/清空
const SERVER = "http://127.0.0.1:7654";

const $list = document.getElementById("list");
const $status = document.getElementById("status");
const $toast = document.getElementById("toast");

function toast(msg, color) {
  $toast.textContent = msg;
  $toast.style.color = color || "#4caf50";
  clearTimeout(toast._t);
  toast._t = setTimeout(() => ($toast.textContent = ""), 2500);
}

async function currentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

// 主流支援站：yt-dlp 有專屬 extractor，走「本頁」合軌才對；嗅到的分軌直下常是
// 音檔／無聲／浮水印／切片。這些站把「本頁」設主鈕、分軌摺疊，防手滑。
function preferPage(url) {
  try {
    const h = new URL(url).hostname;
    return /(^|\.)(douyin|tiktok|youtube|bilibili|instagram|facebook|twitter|x)\.com$/i.test(h)
        || /(^|\.)(youtu\.be|b23\.tv|fb\.watch)$/i.test(h);
  } catch { return false; }
}
// 某些站觀看頁網址 yt-dlp 不認 → 正規化。抖音精選/feed 是 ?modal_id=<id>，要轉 /video/<id>
function canonicalPageUrl(href) {
  try {
    const u = new URL(href);
    if (/(^|\.)douyin\.com$/i.test(u.hostname)) {
      const id = u.searchParams.get("modal_id") || (u.pathname.match(/\/video\/(\d+)/) || [])[1];
      if (id) return `https://www.douyin.com/video/${id}`;
    }
  } catch {}
  return href;
}

async function render() {
  const tab = await currentTab();
  const tabId = tab?.id ?? -1;
  const prefer = preferPage(tab?.url);
  const { list = [] } = (await chrome.runtime.sendMessage({ type: "getResources", tabId })) || {};
  $status.textContent = list.length ? `${list.length} 筆` : "";
  $list.innerHTML = "";

  // 本頁下載一律置頂：yt-dlp 支援 1800+ 站，先讓它用整頁網址找真片源合軌，
  // 嗅到的分軌只是 fallback。主流站(音畫分離)分軌摺疊；長尾站分軌直接顯示。
  const cta = document.createElement("div");
  cta.className = "pageCta";
  cta.innerHTML = `<button class="go primary">⬇ 本頁下載（推薦）</button><div class="ctahint">${
    prefer ? "此站音畫分離／需合軌，直接下嗅到的分軌常只有音檔或無聲"
           : "先試本頁（yt-dlp 支援 1800+ 站）；下不動再用下方嗅到的分軌"
  }</div>`;
  cta.querySelector(".go").onclick = downloadPage;
  $list.append(cta);

  if (!list.length) {
    const e = document.createElement("div"); e.className = "empty";
    e.textContent = prefer ? "（此站走本頁下載即可）" : "尚未嗅到 m3u8 分軌";
    $list.append(e);
    return;
  }
  let target = $list;
  if (prefer) {
    const det = document.createElement("details");
    det.className = "adv";
    det.innerHTML = `<summary>嗅到的分軌 ${list.length} 條（進階，通常不用）</summary>`;
    $list.append(det);
    target = det;
  }
  list.slice().reverse().forEach((r) => {
    const div = document.createElement("div");
    div.className = "item";

    const url = document.createElement("div");
    url.className = "url";
    const tag = "[" + (r.type || "video").toUpperCase() + (r.masked ? "·偽裝" : (r.manual ? "·手動" : "")) + "] ";
    url.textContent = tag + r.url;

    const row = document.createElement("div");
    row.className = "row";

    const dl = document.createElement("button");
    dl.className = "primary";
    dl.textContent = "下載";
    dl.onclick = () => {
      // 主流站直下分軌攔一下：避免手滑拿到音檔/無聲/浮水印（正解是「本頁下載」）
      if (prefer && !confirm("此站建議用「本頁下載」。\n直接下嗅到的分軌常只有音檔／無聲／浮水印。\n\n仍要直接下載這條？")) return;
      enqueue(r.url, r.referer);
    };

    const cp = document.createElement("button");
    cp.textContent = "複製網址";
    cp.onclick = async () => { await navigator.clipboard.writeText(r.url); toast("已複製"); };

    row.append(dl, cp);
    div.append(url, row);

    if (r.needsInPage) {
      const w = document.createElement("div");
      w.className = "warn";
      w.textContent = "⚠ 此站疑 CF 鎖，外部下載可能失敗，建議改用頁內浮動面板下載";
      div.append(w);
    }
    target.append(div);
  });
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

// 觸發 videodl:// 協定：用 <a> 點擊(沿用使用者手勢)。
// 隱藏 iframe 會被新版 Chrome 靜默擋掉(連「要開啟 App?」框都不跳)。
function openScheme(url, referer, name) {
  const qs = new URLSearchParams({ url, referer: referer || "", name: name || "", browser: browserTag() }).toString();
  const a = document.createElement("a");
  a.href = "videodl://download?" + qs;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
}

function cleanTitle(t) {
  t = (t || "").split(" - ")[0].split(" | ")[0].split("｜")[0];
  return t.replace(/[\\/:*?"<>|]+/g, "_").replace(/\s+/g, " ").trim();
}

// 抖音/TikTok 等要 cookie 的站：擴充用 chrome.cookies API 讀好推 server（yt-dlp 讀不到 Chrome cookie DB）
function cookieGated(url) {
  try {
    const h = new URL(url).hostname;
    return /(^|\.)(douyin|tiktok|instagram|facebook|twitter|x)\.com$/i.test(h) || /(^|\.)fb\.watch$/i.test(h);
  } catch { return false; }
}
async function pushCookiesIfGated(url) {
  if (cookieGated(url)) { try { await chrome.runtime.sendMessage({ type: "pushCookies", url }); } catch {} }
}

async function enqueue(url, referer) {
  const tab = (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  const ref = referer || tab?.url || "";
  const name = cleanTitle(tab?.title); // 檔名 = 分頁標題(劇名)
  await pushCookiesIfGated(url); // 先把該站 cookie 推給 server
  // 一律用 videodl:// 喚起 App：送下載 + 把影片下載器視窗帶到最前
  openScheme(url, ref, name);
  // popup 馬上會被 App 搶焦點關掉 → 交給 background 盯 20 秒，失敗發系統通知
  try { chrome.runtime.sendMessage({ type: "watchLaunch" }); } catch {}
  toast("開啟影片下載器…", "#f0c14b");
}

// 「本頁下載」：整頁網址(正規化後)交給 yt-dlp 直解 → 支援站自動合軌(抖音/TikTok 正解)
async function downloadPage() {
  const tab = await currentTab();
  if (!tab?.url) { toast("讀不到本頁網址", "#fca5a5"); return; }
  const pageUrl = canonicalPageUrl(tab.url);
  await pushCookiesIfGated(pageUrl); // 先把該站 cookie 推給 server
  openScheme(pageUrl, "", cleanTitle(tab.title));
  try { chrome.runtime.sendMessage({ type: "watchLaunch" }); } catch {}
  toast("開啟影片下載器…", "#f0c14b");
}
document.getElementById("page").onclick = downloadPage;
document.getElementById("refresh").onclick = render;
document.getElementById("clear").onclick = async () => {
  const tab = await currentTab();
  await chrome.runtime.sendMessage({ type: "clear", tabId: tab?.id ?? -1 });
  render();
};

render();
