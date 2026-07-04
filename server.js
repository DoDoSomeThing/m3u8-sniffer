// 影片下載器 — 本地網頁 GUI 後端
// 起伺服器：node server.js   →   瀏覽器開 http://127.0.0.1:7654
// 無外部套件，全用 Node 內建模組 + 系統 yt-dlp/ffmpeg

const http = require("http");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

const PORT = 7654;
const DLDIR = path.join(os.homedir(), "Downloads");
// 擴充 /enqueue 下載任務清單（記憶體，GUI 輪詢 /jobs 顯示）
let JOBS = [];
let jobSeq = 0;
const PROCS = {}; // jobId → yt-dlp child process（供取消 kill；不進 JSON）
// 待確認清單：scheme 喚起先丟這，GUI 跳規格小窗，使用者按下載才轉成 JOB
let PENDING = [];
let pendSeq = 0;

// 展開路徑開頭的 ~ / $HOME；resolve 後限制在 home 或 /Volumes 下（防路徑穿越亂寫檔）
function expandDir(dir) {
  if (!dir) return DLDIR;
  dir = dir.replace(/^~(?=\/|$)/, os.homedir()).replace(/^\$HOME/, os.homedir());
  const abs = path.resolve(dir);
  const home = os.homedir();
  if (abs === home || abs.startsWith(home + path.sep) || abs.startsWith("/Volumes" + path.sep)) return abs;
  return DLDIR;
}
// 檔名消毒：砍路徑分隔/.. 防穿越（% 轉義在組 -o template 時才做，避免重複轉義）
function sanitizeName(name) {
  if (!name) return "";
  return String(name)
    .replace(/[\\/]+/g, "_")
    .replace(/\.\./g, "_")
    .replace(/[\0-\x1f:*?"<>|]+/g, "_")
    .trim();
}
// Origin 白名單：本地 server 沒認證，靠 Origin 擋「惡意網頁 fetch 127.0.0.1 驅動下載」(CSRF)。
// 放行：無 Origin（curl / 同源 GET / scheme 喚起）、自家擴充、GUI 自己。
function originAllowed(origin) {
  if (!origin) return true;
  return origin.startsWith("chrome-extension://") || origin === `http://127.0.0.1:${PORT}`;
}
// /pending GET 專用 token：curl(App) 和惡意網頁 <img> 都沒 Origin，分不出來 →
// 靠共享秘密區分。啟動時生成寫 ~/.videodl_token(0600)，App 端 curl 讀檔帶上。
const TOKEN_FILE = path.join(os.homedir(), ".videodl_token");
let TOKEN = "";
try {
  TOKEN = fs.readFileSync(TOKEN_FILE, "utf8").trim();
} catch {}
if (!TOKEN) {
  TOKEN = require("crypto").randomBytes(24).toString("hex");
  try { fs.writeFileSync(TOKEN_FILE, TOKEN, { mode: 0o600 }); } catch (e) { console.error("token 檔寫入失敗:", e.message); }
}
// 確保找得到 yt-dlp / ffmpeg（GUI 啟動時 PATH 可能不全）
// 只在 macOS 補 Mac 常見路徑；Windows 沿用系統 PATH（yt-dlp/ffmpeg 需在 PATH 中）
const ENV = Object.assign({}, process.env);
if (process.platform === "darwin") {
  ENV.PATH = "/opt/homebrew/bin:/usr/local/bin:/Library/Frameworks/Python.framework/Versions/3.14/bin:" + (process.env.PATH || "");
}

function send(res, code, type, body) {
  const origin = res.req?.headers?.origin;
  const h = { "Content-Type": type };
  if (origin && originAllowed(origin)) h["Access-Control-Allow-Origin"] = origin;
  res.writeHead(code, h);
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let d = "";
    req.on("data", (c) => {
      d += c;
      if (d.length > 1048576) { req.destroy(); resolve({}); } // 1MB 上限，防灌爆
    });
    req.on("end", () => { try { resolve(JSON.parse(d || "{}")); } catch { resolve({}); } });
  });
}

// 殺整棵進程樹：yt-dlp 下 HLS 會 spawn ffmpeg，只 kill yt-dlp 會留孤兒 ffmpeg 續跑。
// spawn 時 detached:true 讓子進程自成 process group → kill(-pid) 連坐整組。
function spawnDl(args) {
  return spawn("yt-dlp", args, { env: ENV, detached: process.platform !== "win32" });
}
function killTree(p) {
  if (!p || p.killed) return;
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(p.pid), "/T", "/F"]);
    } else {
      process.kill(-p.pid, "SIGTERM"); // 負 pid = 整個 process group
    }
  } catch { try { p.kill(); } catch {} }
}

// 解析畫質：yt-dlp -J
function probe(url, referer) {
  return new Promise((resolve) => {
    const args = ["-J", "--no-warnings", "--no-playlist", "--impersonate", "chrome"];
    if (referer) args.push("--referer", referer);
    args.push(url);
    let out = "", err = "";
    const p = spawn("yt-dlp", args, { env: ENV });
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => {
      if (code !== 0) { resolve({ ok: false, error: (err.trim().split("\n").pop() || "解析失敗") }); return; }
      try {
        const j = JSON.parse(out);
        const fmts = (j.formats || [])
          .filter((f) => f.vcodec && f.vcodec !== "none") // 有畫面的
          .map((f) => ({
            id: f.format_id,
            height: f.height || 0,
            ext: f.ext,
            note: f.format_note || "",
            tbr: f.tbr || 0,
            size: f.filesize || f.filesize_approx || 0,
          }))
          .sort((a, b) => (b.height - a.height) || (b.tbr - a.tbr));
        resolve({ ok: true, title: j.title || "", formats: fmts });
      } catch (e) { resolve({ ok: false, error: "解析輸出異常" }); }
    });
    p.on("error", () => resolve({ ok: false, error: "找不到 yt-dlp" }));
  });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://127.0.0.1:${PORT}`);

  // Origin 閘門：非白名單來源（一般網頁）一律 403，擋 CSRF 驅動下載
  const origin = req.headers.origin;
  if (!originAllowed(origin)) {
    res.writeHead(403, { "Content-Type": "text/plain" });
    res.end("forbidden origin");
    return;
  }

  // CORS 預檢（popup 從 chrome-extension:// POST JSON 會先送 OPTIONS）
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": origin || "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
    });
    res.end();
    return;
  }

  // 首頁
  if (u.pathname === "/" || u.pathname === "/index.html") {
    const html = fs.readFileSync(path.join(__dirname, "gui.html"), "utf8");
    send(res, 200, "text/html; charset=utf-8", html);
    return;
  }

  // 解析畫質
  if (u.pathname === "/probe" && req.method === "POST") {
    const b = await readBody(req);
    if (!b.url) { send(res, 200, "application/json", JSON.stringify({ ok: false, error: "沒有網址" })); return; }
    const r = await probe(b.url, b.referer);
    send(res, 200, "application/json", JSON.stringify(r));
    return;
  }

  // 下載（SSE 即時進度）
  if (u.pathname === "/download" && req.method === "GET") {
    const url = u.searchParams.get("url");
    const fmt = u.searchParams.get("format") || "";
    const name = sanitizeName(u.searchParams.get("name") || "");
    const referer = u.searchParams.get("referer") || "";
    if (!url) { send(res, 400, "text/plain", "no url"); return; }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });
    const ev = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

    const args = ["--newline", "--no-warnings", "--concurrent-fragments", "8", "--no-mtime", "--impersonate", "chrome", "--cookies-from-browser", "chrome"];
    if (fmt) args.push("-f", fmt);
    if (referer) args.push("--referer", referer);
    args.push("-o", path.join(DLDIR, (name ? name.replace(/%/g, "%%") : "%(title)s") + ".%(ext)s"), url);

    ev({ type: "log", line: "yt-dlp " + args.join(" ") });
    const p = spawnDl(args);

    const onLine = (buf) => {
      for (const line of buf.toString().split(/\r?\n/)) {
        if (!line.trim()) continue;
        const m = line.match(/\[download\]\s+([\d.]+)%/);
        if (m) ev({ type: "progress", pct: parseFloat(m[1]), line });
        else ev({ type: "log", line });
      }
    };
    p.stdout.on("data", onLine);
    p.stderr.on("data", onLine);
    p.on("close", (code) => { ev({ type: code === 0 ? "done" : "error", code }); res.end(); });
    p.on("error", (e) => { ev({ type: "error", line: String(e.message) }); res.end(); });

    req.on("close", () => killTree(p)); // 連 ffmpeg 一起殺，不留孤兒
    return;
  }

  // 擴充轉發：接 url → spawn yt-dlp 背景下載，狀態進 JOBS 清單供 GUI 輪詢顯示。
  // 立即回 200 不等下載完（popup 按一下就走），但保留進度/錯誤讓 GUI 看得到。
  // 只收 POST（GET 會被 <img> 之類無 Origin 請求繞過閘門；scheme 喚起走 /pending）。
  if (u.pathname === "/enqueue" && req.method === "POST") {
    const b = await readBody(req);
    if (!b.url) { send(res, 200, "application/json", JSON.stringify({ ok: false, error: "沒有網址" })); return; }
    b.name = sanitizeName(b.name);

    // --cookies-from-browser：借「觸發下載的那個瀏覽器」的 cookie（Brave 嗅到的要借 Brave 的，
    // 借錯瀏覽器會缺登入態 → X/NSFW/CF 站 403）。破 anime1 / CF+cookie 鎖站。
    const COOKIE_BROWSERS = { chrome: "chrome", brave: "brave", edge: "edge", opera: "opera", vivaldi: "vivaldi" };
    const cookieSrc = COOKIE_BROWSERS[b.browser] || "chrome";
    const outDir = expandDir(b.dir);
    const args = ["--newline", "--no-warnings", "--concurrent-fragments", "8", "--no-mtime", "--impersonate", "chrome", "--cookies-from-browser", cookieSrc];
    if (b.format) args.push("-f", b.format);
    if (b.referer) args.push("--referer", b.referer);
    args.push("-o", path.join(outDir, (b.name ? b.name.replace(/%/g, "%%") : "%(title)s") + ".%(ext)s"), b.url);

    console.log("[enqueue] yt-dlp " + args.join(" "));
    const job = {
      id: "e" + (++jobSeq),
      name: b.name || b.url.split("/").pop() || b.url,
      url: b.url,
      status: "downloading", // downloading | done | error
      pct: 0,
      log: "啟動中…",
      ts: Date.now(),
    };
    JOBS.unshift(job);
    if (JOBS.length > 50) JOBS.length = 50;

    try {
      const p = spawnDl(args); // detached=自成 process group（取消時連 ffmpeg 一起殺），server 仍追蹤進度
      PROCS[job.id] = p;
      let lastErr = "";
      let skipped = false;
      const onLine = (buf) => {
        for (const line of buf.toString().split(/\r?\n/)) {
          if (!line.trim()) continue;
          const dest = line.match(/Destination:\s*(.+)$/);
          if (dest) job.name = dest[1].split("/").pop();
          if (/has already been downloaded/.test(line)) skipped = true; // 同名檔已存在，yt-dlp 沒下就收工
          const m = line.match(/\[download\]\s+([\d.]+)%/);
          if (m) { job.pct = parseFloat(m[1]); job.log = line; }
          else { job.log = line; if (/error|ERROR/.test(line)) lastErr = line; }
        }
      };
      p.stdout.on("data", onLine);
      p.stderr.on("data", (buf) => { onLine(buf); });
      p.on("close", (code) => {
        delete PROCS[job.id];
        if (job.status === "cancelled") return; // 使用者取消，不覆寫
        if (code === 0) { job.status = "done"; job.pct = 100; job.log = skipped ? "⚠ 同名檔已存在，未重新下載（要重下請先刪/改名舊檔）" : "完成"; }
        else { job.status = "error"; job.log = lastErr || ("yt-dlp 結束碼 " + code); }
      });
      p.on("error", (e) => { delete PROCS[job.id]; job.status = "error"; job.log = "找不到 yt-dlp：" + e.message; });
      send(res, 200, "application/json", JSON.stringify({ ok: true, id: job.id }));
    } catch (e) {
      job.status = "error"; job.log = String(e.message);
      send(res, 200, "application/json", JSON.stringify({ ok: false, error: String(e.message) }));
    }
    return;
  }

  // GUI 輪詢：擴充下載任務清單
  if (u.pathname === "/jobs" && req.method === "GET") {
    send(res, 200, "application/json", JSON.stringify({ jobs: JOBS }));
    return;
  }

  // 待確認：scheme 喚起丟這（POST json 或 GET query）→ GUI 跳規格小窗
  if (u.pathname === "/pending" && (req.method === "POST" || req.method === "GET")) {
    // GET 無法用 Origin 區分「App 的 curl」和「惡意頁 <img>」→ 驗共享 token
    if (req.method === "GET" && u.searchParams.get("token") !== TOKEN) {
      send(res, 403, "text/plain", "bad token");
      return;
    }
    const b = req.method === "POST" ? await readBody(req) : {
      url: u.searchParams.get("url") || "",
      referer: u.searchParams.get("referer") || "",
      name: u.searchParams.get("name") || "",
      browser: u.searchParams.get("browser") || "",
    };
    if (!b.url) { send(res, 200, "application/json", JSON.stringify({ ok: false, error: "沒有網址" })); return; }
    const item = { id: "p" + (++pendSeq), url: b.url, referer: b.referer || "", name: sanitizeName(b.name || ""), browser: b.browser || "", ts: Date.now() };
    PENDING.push(item);
    if (PENDING.length > 20) PENDING.shift();
    console.log("[pending] " + item.url);
    send(res, 200, "application/json", JSON.stringify({ ok: true, id: item.id }));
    return;
  }

  // GUI 輪詢待確認清單
  if (u.pathname === "/pending/list" && req.method === "GET") {
    send(res, 200, "application/json", JSON.stringify({ pending: PENDING }));
    return;
  }

  // 移除待確認（按下載轉 JOB 後 / 取消時呼叫）
  if (u.pathname === "/pending/resolve" && req.method === "POST") {
    const b = await readBody(req);
    PENDING = PENDING.filter((p) => p.id !== b.id);
    send(res, 200, "application/json", JSON.stringify({ ok: true }));
    return;
  }

  // 清除任務。下載中一律保留（不誤清進行中）。
  //   done = 只清「完成」；all = 清「完成 + 失敗/取消」
  if (u.pathname === "/jobs/clear" && req.method === "POST") {
    const b = await readBody(req);
    if (b.mode === "all") JOBS = JOBS.filter((j) => j.status === "downloading");
    else JOBS = JOBS.filter((j) => j.status !== "done");
    send(res, 200, "application/json", JSON.stringify({ ok: true }));
    return;
  }

  // 取消單一任務：kill yt-dlp + 從清單移除
  if (u.pathname === "/jobs/cancel" && req.method === "POST") {
    const b = await readBody(req);
    const job = JOBS.find((j) => j.id === b.id);
    if (job) {
      job.status = "cancelled";
      const p = PROCS[b.id];
      if (p) { killTree(p); delete PROCS[b.id]; }
      JOBS = JOBS.filter((j) => j.id !== b.id);
    }
    send(res, 200, "application/json", JSON.stringify({ ok: true }));
    return;
  }

  send(res, 404, "text/plain", "not found");
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`影片下載器 GUI: http://127.0.0.1:${PORT}  (下載到 ${DLDIR})`);
});
