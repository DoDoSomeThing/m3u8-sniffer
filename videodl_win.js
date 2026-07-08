// videodl_win.js — Windows 的 videodl:// 協定處理程式（對應 Mac 的 影片下載器.applescript）
// 擴充按下載會發 videodl://download?url=...&referer=...&name=...&browser=...
// 本程式：①server 沒跑就背景啟 node server.js ②讀 ~/.videodl_token ③GET /pending 排下載
//          ④開預設瀏覽器到 GUI(127.0.0.1:7654)讓使用者確認畫質/檔名後下載。
const http = require("http");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const PORT = 7654;
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN_FILE = path.join(os.homedir(), ".videodl_token");
const SCRIPT_DIR = __dirname;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// server 活著嗎（/jobs 有回就算活）
function serverUp(timeout = 1500) {
  return new Promise((resolve) => {
    const req = http.get(BASE + "/jobs", { timeout }, (res) => { res.resume(); resolve(true); });
    req.on("timeout", () => { req.destroy(); resolve(false); });
    req.on("error", () => resolve(false));
  });
}

// server 沒跑 → 開一個「看得見的」終端機視窗跑 server（當運作指示燈，
// 關視窗或 Ctrl+C 即停止；對應 Mac 版用 Terminal 前景跑的行為）。最多等 ~15 秒起來。
async function ensureServer() {
  if (await serverUp()) return true;
  const title = "影片下載器 運作中 — 關閉此視窗或按 Ctrl+C 即停止";
  // start 開新視窗；cmd /k 讓視窗留著（server 停了也能看錯誤）；chcp 65001 讓中文不亂碼
  const cmdline = `start "${title}" cmd /k "chcp 65001>nul && node server.js"`;
  const child = spawn("cmd", ["/c", cmdline], {
    cwd: SCRIPT_DIR, detached: true, stdio: "ignore", windowsVerbatimArguments: true,
  });
  child.unref();
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    if (await serverUp()) return true;
  }
  return false;
}

function readToken() {
  try { return fs.readFileSync(TOKEN_FILE, "utf8").trim(); } catch { return ""; }
}

// GET /pending 排下載（querystring 已由擴充 URL-encode，原樣轉送 + 帶 token）
function enqueue(qs, token) {
  return new Promise((resolve) => {
    const url = `${BASE}/pending?${qs}&token=${encodeURIComponent(token)}`;
    const req = http.get(url, (res) => { res.resume(); resolve(res.statusCode); });
    req.on("error", () => resolve(0));
  });
}

// 開預設瀏覽器到 GUI（start 第一個空字串參數是視窗標題佔位）
function openGui() {
  spawn("cmd", ["/c", "start", "", BASE], { detached: true, stdio: "ignore", windowsHide: true }).unref();
}

(async () => {
  const arg = process.argv[2] || "";
  const qi = arg.indexOf("?");
  const qs = qi >= 0 ? arg.slice(qi + 1).replace(/\/+$/, "") : ""; // 去尾斜線（有些瀏覽器會補）
  const up = await ensureServer();
  if (up && qs) {
    await enqueue(qs, readToken());
  }
  openGui(); // server 起不來也開 GUI，讓使用者看得到狀態
})();
