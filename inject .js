/* MAIN-world hook. Captures any network response whose URL mentions "coupon". */
(function () {
  const buf = [];
  const MAX = 40;

  function record(url, status, text) {
    if (!/coupon/i.test(url)) return;
    buf.push({ url, status, text: (text || "").slice(0, 4000), t: Date.now() });
    if (buf.length > MAX) buf.shift();
  }

  // ---- hook fetch ----
  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    const res = await origFetch.apply(this, args);
    try {
      const url = res.url || (args[0] && args[0].url) || String(args[0] || "");
      if (/coupon/i.test(url)) {
        res.clone().text().then((t) => record(url, res.status, t)).catch(() => {});
      }
    } catch (e) {}
    return res;
  };

  // ---- hook XHR ----
  const OrigXHR = window.XMLHttpRequest;
  function PatchedXHR() {
    const xhr = new OrigXHR();
    xhr.addEventListener("loadend", function () {
      try {
        const url = xhr.responseURL || "";
        if (/coupon/i.test(url)) {
          let t = "";
          try {
            t = (xhr.responseType === "" || xhr.responseType === "text")
              ? xhr.responseText
              : JSON.stringify(xhr.response);
          } catch (e) {}
          record(url, xhr.status, t);
        }
      } catch (e) {}
    });
    return xhr;
  }
  PatchedXHR.prototype = OrigXHR.prototype;
  window.XMLHttpRequest = PatchedXHR;

  // ---- bridge ----
  window.addEventListener("message", (e) => {
    if (e.source !== window || !e.data) return;
    if (e.data.__elpc === "ask") window.postMessage({ __elpc: "buffer", data: buf }, "*");
    if (e.data.__elpc === "clear") buf.length = 0;
  });
})();