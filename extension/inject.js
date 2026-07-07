// 注入頁面 context：hook fetch / XHR，讀「回應內容」補抓 URL 看不出來的 m3u8
// （偽裝副檔名 .txt、動態產生、blob 前身）。找到就 postMessage 回 content script。
// 對 m3u8 一律讀 body 解析：master 母清單抽出 variant 子清單網址 → 交 background 收斂
// （master 吃掉 variant，一部影片只留一個下載點，不再一片噴 7-9 條）。
(function () {
  const post = (type, url, extra) => {
    try {
      if (url) window.postMessage(Object.assign({ __m3u8sniff: 1, type, url: String(url) }, extra || {}), "*");
    } catch {}
  };
  const isM3u8 = (u) => { try { return /\.m3u8?(\?|$)/i.test(new URL(u, location.href).pathname); } catch { return false; } };
  const isVid = (u) => { try { return /\.(mp4|m4v|webm|mkv|mov|flv)(\?|$)/i.test(new URL(u, location.href).pathname); } catch { return false; } };
  // 副檔名一律從 pathname 取（raw url 帶 query/fragment 會取錯）
  const vidExt = (u) => { try { return new URL(u, location.href).pathname.match(/\.(\w+)$/)[1].toLowerCase(); } catch { return "video"; } };

  // 解析 HLS manifest：判斷是不是 master、抽出所有 variant/rendition 子清單網址（絕對化）
  //  - master：含 #EXT-X-STREAM-INF（多畫質）或 #EXT-X-MEDIA（分離音軌/字幕），下一行/URI= 就是子清單
  //  - media playlist：只有 #EXTINF 切片，不是 master、無 children
  function parseM3u8(text, baseUrl) {
    const abs = (u) => { try { return new URL(u, baseUrl).href; } catch { return null; } };
    const lines = text.split(/\r?\n/);
    const children = [];
    let isMaster = false;
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i].trim();
      if (ln.startsWith("#EXT-X-STREAM-INF")) {
        isMaster = true;
        // 下一個非空、非註解行 = 該畫質的子清單 URI
        for (let j = i + 1; j < lines.length; j++) {
          const nx = lines[j].trim();
          if (!nx || nx.startsWith("#")) continue;
          const a = abs(nx); if (a) children.push(a);
          break;
        }
      } else if (ln.startsWith("#EXT-X-MEDIA")) {
        const m = ln.match(/URI="([^"]+)"/);
        if (m) { isMaster = true; const a = abs(m[1]); if (a) children.push(a); }
      }
    }
    return { isMaster, children };
  }

  // 讀到 m3u8 body → 解析 → post（帶 isMaster/children 供 background 收斂）
  function handleM3u8Body(url, text) {
    const u = url || location.href;
    if (!text || !text.trim().startsWith("#EXTM3U")) { post("m3u8", u); return; }
    const { isMaster, children } = parseM3u8(text, u);
    post("m3u8", u, { isMaster, children });
  }

  // hook fetch
  const _fetch = window.fetch;
  if (_fetch) {
    window.fetch = function (...a) {
      return _fetch.apply(this, a).then((resp) => {
        try {
          const url = (resp && resp.url) || (typeof a[0] === "string" ? a[0] : (a[0] && a[0].url)) || "";
          const ct = (resp.headers && resp.headers.get && (resp.headers.get("content-type") || "")) || "";
          const clen = parseInt((resp.headers && resp.headers.get && resp.headers.get("content-length")) || "0", 10);
          // m3u8：副檔名看得出、或 Content-Type mpegurl、或偽裝成 txt/octet-stream 的小檔
          const looksM3u8 = isM3u8(url) || /mpegurl/i.test(ct)
            || (/text\/plain|octet-stream/i.test(ct) && (!clen || clen < 500000));
          if (looksM3u8) {
            resp.clone().text().then((t) => {
              if (t && t.trim().startsWith("#EXTM3U")) handleM3u8Body(url, t);
            }).catch(() => {});
            return resp;
          }
          if (isVid(url)) post(vidExt(url), url);
        } catch {}
        return resp;
      });
    };
  }

  // hook XHR
  const _open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (m, u) {
    this.addEventListener("load", () => {
      try {
        // responseType 非 text 時讀 responseText 會丟例外 → guard
        let txt = "";
        try { txt = typeof this.responseText === "string" ? this.responseText : ""; } catch {}
        if (txt && txt.trim().startsWith("#EXTM3U")) { handleM3u8Body(u, txt); return; }
        if (isM3u8(u)) { post("m3u8", u); return; } // body 讀不到（blob/arraybuffer）→ 至少留網址
        if (isVid(u)) post(vidExt(u), u);
      } catch {}
    });
    return _open.apply(this, arguments);
  };
})();
