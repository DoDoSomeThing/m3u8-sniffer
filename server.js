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

// 展開路徑開頭的 ~ / $HOME
function expandDir(dir) {
  if (!dir) return DLDIR;
  dir = dir.replace(/^~(?=\/|$)/, os.homedir()).replace(/^\$HOME/, os.homedir());
  return dir;
}
// 確保找得到 yt-dlp / ffmpeg（GUI 啟動時 PATH 可能不全）
// 只在 macOS 補 Mac 常見路徑；Windows 沿用系統 PATH（yt-dlp/ffmpeg 需在 PATH 中）
const ENV = Object.assign({}, process.env);
if (process.platform === "darwin") {
  ENV.PATH = "/opt/homebrew/bin:/usr/local/bin:/Library/Frameworks/Python.framework/Versions/3.14/bin:" + (process.env.PATH || "");
}

function send(res, code, type, body) {
  res.writeHead(code, { "Content-Type": type, "Access-Control-Allow-Origin": "*" });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let d = "";
    req.on("data", (c) => (d += c));
    req.on("end", () => { try { resolve(JSON.parse(d || "{}")); } catch { resolve({}); } });
  });
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

  // CORS 預檢（popup 從 chrome-extension:// POST JSON 會先送 OPTIONS）
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
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
    const name = u.searchParams.get("name") || "";
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
    args.push("-o", path.join(DLDIR, (name ? name : "%(title)s") + ".%(ext)s"), url);

    ev({ type: "log", line: "yt-dlp " + args.join(" ") });
    const p = spawn("yt-dlp", args, { env: ENV });

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

    req.on("close", () => { try { p.kill(); } catch {} });
    return;
  }

  // 擴充轉發：接 url → spawn yt-dlp 背景下載，狀態進 JOBS 清單供 GUI 輪詢顯示。
  // 立即回 200 不等下載完（popup 按一下就走），但保留進度/錯誤讓 GUI 看得到。
  // POST（擴充直連）+ GET（videodl:// URL scheme 喚起時用 query 帶參數）都支援。
  if (u.pathname === "/enqueue" && (req.method === "POST" || req.method === "GET")) {
    const b = req.method === "POST"
      ? await readBody(req)
      : {
          url: u.searchParams.get("url") || "",
          referer: u.searchParams.get("referer") || "",
          name: u.searchParams.get("name") || "",
          format: u.searchParams.get("format") || "",
          dir: u.searchParams.get("dir") || "",
        };
    if (!b.url) { send(res, 200, "application/json", JSON.stringify({ ok: false, error: "沒有網址" })); return; }

    // --cookies-from-browser chrome：借瀏覽器 cookie，破 anime1 / CF+cookie 鎖站的 403
    const outDir = expandDir(b.dir);
    const args = ["--newline", "--no-warnings", "--concurrent-fragments", "8", "--no-mtime", "--impersonate", "chrome", "--cookies-from-browser", "chrome"];
    if (b.format) args.push("-f", b.format);
    if (b.referer) args.push("--referer", b.referer);
    args.push("-o", path.join(outDir, (b.name ? b.name : "%(title)s") + ".%(ext)s"), b.url);

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
      const p = spawn("yt-dlp", args, { env: ENV }); // 不 detached：server 追蹤進度/結果
      PROCS[job.id] = p;
      let lastErr = "";
      const onLine = (buf) => {
        for (const line of buf.toString().split(/\r?\n/)) {
          if (!line.trim()) continue;
          const dest = line.match(/Destination:\s*(.+)$/);
          if (dest) job.name = dest[1].split("/").pop();
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
        if (code === 0) { job.status = "done"; job.pct = 100; job.log = "完成"; }
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
    const b = req.method === "POST" ? await readBody(req) : {
      url: u.searchParams.get("url") || "",
      referer: u.searchParams.get("referer") || "",
      name: u.searchParams.get("name") || "",
    };
    if (!b.url) { send(res, 200, "application/json", JSON.stringify({ ok: false, error: "沒有網址" })); return; }
    const item = { id: "p" + (++pendSeq), url: b.url, referer: b.referer || "", name: b.name || "", ts: Date.now() };
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
      if (p) { try { p.kill(); } catch {} delete PROCS[b.id]; }
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
