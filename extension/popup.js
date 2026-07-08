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

async function currentTabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id ?? -1;
}

async function render() {
  const tabId = await currentTabId();
  const { list = [] } = (await chrome.runtime.sendMessage({ type: "getResources", tabId })) || {};
  $status.textContent = list.length ? `${list.length} 筆` : "";
  if (!list.length) {
    $list.innerHTML = '<div class="empty">尚未嗅到 m3u8</div>';
    return;
  }
  $list.innerHTML = "";
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
    dl.onclick = () => enqueue(r.url, r.referer);

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
    $list.append(div);
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

async function enqueue(url, referer) {
  const tab = (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  const ref = referer || tab?.url || "";
  const name = cleanTitle(tab?.title); // 檔名 = 分頁標題(劇名)
  // 一律用 videodl:// 喚起 App：送下載 + 把影片下載器視窗帶到最前
  openScheme(url, ref, name);
  // popup 馬上會被 App 搶焦點關掉 → 交給 background 盯 20 秒，失敗發系統通知
  try { chrome.runtime.sendMessage({ type: "watchLaunch" }); } catch {}
  toast("開啟影片下載器…", "#f0c14b");
}

document.getElementById("refresh").onclick = render;
document.getElementById("clear").onclick = async () => {
  const tabId = await currentTabId();
  await chrome.runtime.sendMessage({ type: "clear", tabId });
  render();
};

render();
