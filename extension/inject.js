// 注入頁面 context：hook fetch / XHR，讀「回應內容」補抓 URL 看不出來的 m3u8
// （偽裝副檔名 .txt、動態產生、blob 前身）。找到就 postMessage 回 content script。
(function () {
  const post = (type, url) => {
    try { if (url) window.postMessage({ __m3u8sniff: 1, type, url: String(url) }, "*"); } catch {}
  };
  const isM3u8 = (u) => { try { return /\.m3u8?(\?|$)/i.test(new URL(u, location.href).pathname); } catch { return false; } };
  const isVid = (u) => { try { return /\.(mp4|m4v|webm|mkv|mov|flv)(\?|$)/i.test(new URL(u, location.href).pathname); } catch { return false; } };

  // hook fetch
  const _fetch = window.fetch;
  if (_fetch) {
    window.fetch = function (...a) {
      return _fetch.apply(this, a).then((resp) => {
        try {
          const url = (resp && resp.url) || (typeof a[0] === "string" ? a[0] : (a[0] && a[0].url)) || "";
          if (isM3u8(url)) { post("m3u8", url); return resp; }
          if (isVid(url)) { post(url.match(/\.(\w+)(\?|$)/)[1].toLowerCase(), url); return resp; }
          const ct = (resp.headers && resp.headers.get && (resp.headers.get("content-type") || "")) || "";
          const clen = parseInt((resp.headers && resp.headers.get && resp.headers.get("content-length")) || "0", 10);
          const looks = /mpegurl/i.test(ct) || /\.(m3u8|txt)(\?|$)/i.test(url)
            || (/text\/plain|octet-stream/i.test(ct) && (!clen || clen < 300000));
          if (looks && (!clen || clen < 500000)) {
            resp.clone().text().then((t) => {
              if (t && t.trim().startsWith("#EXTM3U")) post("m3u8", url || location.href);
            }).catch(() => {});
          }
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
        if (isM3u8(u)) post("m3u8", u);
        else if (isVid(u)) post(u.match(/\.(\w+)(\?|$)/)[1].toLowerCase(), u);
        else if (this.responseText && this.responseText.trim().startsWith("#EXTM3U")) post("m3u8", u);
      } catch {}
    });
    return _open.apply(this, arguments);
  };
})();
