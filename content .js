/* ISOLATED-world bridge between inject.js and the service worker. */
let buffer = [];

window.addEventListener("message", (e) => {
  if (e.source !== window || !e.data) return;
  if (e.data.__elpc === "buffer") buffer = e.data.data || [];
});

function interpret(entries) {
  for (const e of entries) {
    let data = null;
    try { data = JSON.parse(e.text); } catch (_) {}
    if (data && typeof data === "object") {
      for (const k of ["valid", "is_valid", "success", "applied"]) {
        if (k in data) {
          if (data[k] === true) return { verdict: "valid", detail: e.url };
          if (data[k] === false) return { verdict: "invalid", detail: e.url };
        }
      }
      if (data.error || data.detail) {
        return { verdict: "invalid", detail: String(data.error || data.detail).slice(0, 120) };
      }
      if (data.coupon || data.percent_off) return { verdict: "valid", detail: e.url };
    }
    if (e.status >= 400) return { verdict: "invalid", detail: "HTTP " + e.status };
  }

  const t = (document.body ? document.body.innerText : "").toLowerCase();
  if (t.includes("coupon") && /applied|activated|success|redeemed/.test(t)) {
    return { verdict: "valid", detail: "page toast" };
  }
  if (/invalid|expired|not valid|doesn't exist/.test(t)) {
    return { verdict: "invalid", detail: "page toast" };
  }
  return { verdict: "unknown", detail: "no coupon signal captured" };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "PING") { sendResponse({ ok: true }); return true; }

  if (msg.type === "GET_COUPON_RESULT") {
    window.postMessage({ __elpc: "ask" }, "*");
    setTimeout(() => sendResponse(interpret(buffer)), 300);
    return true;
  }

  if (msg.type === "CLEAR_BUFFER") {
    buffer = [];
    window.postMessage({ __elpc: "clear" }, "*");
    sendResponse({ ok: true });
    return true;
  }
});