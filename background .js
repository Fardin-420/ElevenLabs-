/* Service worker: harvesting, validation, deep check, scheduling. */

const STRIPE_API = "https://api.stripe.com/v1/promotion_codes";
const HOME = "https://elevenlabs.io/";
const PK_RE = /pk_live_[A-Za-z0-9]{20,}/;

const SOURCES = [
  "https://www.wethrift.com/elevenlabs",
  "https://elevenlabs.startupworld.com/",
  "https://devopscube.com/elevenlabs-discount/",
  "https://techjury.net/ai-coupons/elevenlabs/",
  "https://grabon.com/elevenlabs-coupons/",
  "https://simplycodes.com/store/elevenlabs.io"
];

const SEED = [
  "OFF80","VOICE85","INSIDE00","ELEVENLAB","2024","2025","2026","FEIWU",
  "ADAM5OFF","KMOB10","CAITLYN","GLOW","AGR25","CREATOR50","CREATOR30",
  "SCALE40","STARTER50","SAVE20","SAVE30","BLACKFRIDAY","BF50","BF80",
  "CYBERMONDAY","WELCOME10","WELCOME20","STUDENT","EDU50","LAUNCH","BETA",
  "FOUNDER","AGENTS25","25DAYSOFAGENTS","VOICE25","VOICE50","PODCAST50","YOUTUBE50"
];

const STOP = new Set(("THE AND FOR YOU GET OFF ALL NEW USE CODE PROMO DEAL DEALS FREE PLAN PLANS TIER APP API " +
  "AI USA UK EU USD EUR GBP FAQ TOS PDF HTML HTTP HTTPS WWW COM ORG NET IO JS CSS ID MONTH MONTHS YEAR YEARLY " +
  "ANNUAL MONTHLY FIRST MORE LESS WITH FROM YOUR OUR THIS THAT WAS HAS HAVE CAN NOT ARE BUT ONLY OVER THAN " +
  "ELEVEN LABS ELEVENLABS VOICE AUDIO TEXT SPEECH CLONE CLONING AGENTS CREATOR STARTER ULTRA PRO ENTERPRISE " +
  "BUSINESS PRICING SUBSCRIPTION CREDITS CHARACTERS LINK CLICK HERE VERIFIED WORKING TODAY TOTAL SAVE DISCOUNT " +
  "COUPON COUPONS REVIEW READ SHOW VIEW SIGN LOG ADD REDEEM APPLY VALID EXPIRED LIMITED TIME EXCLUSIVE STUDENTS " +
  "TEACHERS NONPROFIT STARTUP GRANT STUDIO MUSIC DUBBING MODEL MODELS V3 V4 TTS STT SDK CPU GPU").split(" "));

const DEFAULTS = {
  pk: "",
  codes: {},
  scan: { running: false, queue: [], index: 0, checked: 0, valid: 0 },
  settings: { deepCheck: true, autoScan: true },
  lastScan: 0,
  lastMessage: ""
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getState() {
  const s = await chrome.storage.local.get(null);
  return {
    ...DEFAULTS,
    ...s,
    settings: { ...DEFAULTS.settings, ...(s.settings || {}) },
    scan: { ...DEFAULTS.scan, ...(s.scan || {}) }
  };
}
const setState = (patch) => chrome.storage.local.set(patch);

async function upsertCode(code, patch) {
  const { codes } = await getState();
  codes[code] = { ...(codes[code] || {}), ...patch, checked: Date.now() };
  await setState({ codes });
}

/* ---------------- publishable key discovery ---------------- */
async function discoverPk(force = false) {
  const st = await getState();
  if (st.pk && !force) return st.pk;
  try {
    const html = await (await fetch(HOME, { cache: "no-store" })).text();
    let m = html.match(PK_RE);
    if (m) { await setState({ pk: m[0] }); return m[0]; }

    const urls = [...html.matchAll(/src="([^"]+\.js)"/g)].map((x) => x[1]).slice(0, 40);
    for (const u of urls) {
      const full = u.startsWith("http") ? u : HOME.replace(/\/$/, "") + u;
      try {
        const body = await (await fetch(full, { cache: "no-store" })).text();
        m = body.match(PK_RE);
        if (m) { await setState({ pk: m[0] }); return m[0]; }
      } catch (e) {}
    }
  } catch (e) {}
  return "";
}

/* ---------------- level 1: Stripe existence ---------------- */
async function validateStripe(code, pk) {
  if (!pk) return { status: "error", detail: "no publishable key" };
  const variants = [...new Set([code, code.toUpperCase(), code.toLowerCase()])];
  for (const v of variants) {
    let r;
    try {
      r = await fetch(
        `${STRIPE_API}?code=${encodeURIComponent(v)}&active=true&limit=1`,
        { headers: { Authorization: `Bearer ${pk}` } }
      );
    } catch (e) {
      return { status: "error", detail: String(e).slice(0, 120) };
    }
    if (r.status === 401) return { status: "error", detail: "publishable key rejected" };
    if (!r.ok) continue;
    const j = await r.json().catch(() => ({}));
    const d = j.data || [];
    if (d.length) {
      const c = d[0].coupon || {};
      const discount = c.percent_off
        ? `${c.percent_off}% off`
        : c.amount_off
          ? `${(c.amount_off / 100).toFixed(2)} ${(c.currency || "").toUpperCase()} off`
          : "discount";
      return { status: "valid", discount, detail: "exists on Stripe account" };
    }
  }
  return { status: "invalid", detail: "not an active promotion code" };
}

/* ---------------- harvesting ---------------- */
function extract(html) {
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");

  const explicit = new Set();
  let m;
  const re1 = /(?:code|coupon|promo|voucher)\s*[:=\-]?\s*[`"']?([A-Za-z0-9_\-]{3,24})[`"']?/gi;
  while ((m = re1.exec(text))) explicit.add(m[1].toUpperCase());
  const re2 = /(?:code|coupon|promo)[^A-Za-z0-9]{0,12}([A-Z][A-Z0-9_\-]{2,23})/g;
  while ((m = re2.exec(html))) explicit.add(m[1].toUpperCase());

  const heuristic = new Set();
  const tok = /\b[A-Z][A-Z0-9][A-Z0-9_\-]{1,23}\b/g;
  while ((m = tok.exec(text))) {
    const t = m[0];
    if (STOP.has(t) || t.length < 3) continue;
    if (/\d/.test(t) || t.length >= 4) heuristic.add(t);
  }
  const yr = /\b20[2-9]\d\b/g;
  while ((m = yr.exec(text))) heuristic.add(m[0]);

  const clean = (s) => [...s]
    .map((x) => x.replace(/^[-_]+|[-_]+$/g, ""))
    .filter((x) => x.length >= 3 && x.length <= 24 && !STOP.has(x));

  return { explicit: clean(explicit), heuristic: clean(heuristic) };
}

async function harvest() {
  const found = {};
  for (const src of SOURCES) {
    let html = "";
    try { html = await (await fetch(src, { cache: "no-store" })).text(); } catch (e) { continue; }
    const { explicit, heuristic } = extract(html);
    for (const c of [...explicit, ...heuristic]) if (!found[c]) found[c] = src;
  }
  for (const c of SEED) if (!found[c]) found[c] = "seed";
  return found;
}

function generate() {
  const out = [];
  const pre = ["OFF", "SAVE", "VOICE", "CREATOR", "STARTER", "SCALE", "GET", "TRY"];
  const num = ["10","15","20","25","30","40","50","60","70","80","85","90","100"];
  for (const p of pre) for (const n of num) out.push(p + n);
  for (const y of ["2024", "2025", "2026", "2027"]) out.push(y);
  return out;
}

/* ---------------- scan pipeline ---------------- */
async function startScan() {
  const st0 = await getState();
  if (st0.scan.running) return;

  const found = await harvest();
  for (const c of generate()) if (!found[c]) found[c] = "generated";

  const st = await getState();
  const codes = { ...st.codes };
  for (const [code, src] of Object.entries(found)) {
    if (!codes[code]) codes[code] = { status: "unknown", source: src };
  }
  const queue = Object.keys(codes).filter((c) => codes[c].status === "unknown" || codes[c].status === "error");

  await setState({
    codes,
    scan: { running: true, queue, index: 0, checked: 0, valid: 0 },
    lastMessage: `queued ${queue.length} candidates`
  });
  chrome.alarms.create("tick", { when: Date.now() + 200 });
}

async function tick() {
  const st = await getState();
  const scan = st.scan;
  if (!scan.running || !scan.queue.length) return;

  const pk = await discoverPk();
  const codes = { ...st.codes };
  const CHUNK = 25;
  let { index, checked, valid } = scan;
  const end = Math.min(index + CHUNK, scan.queue.length);

  for (let i = index; i < end; i++) {
    const code = scan.queue[i];
    const res = await validateStripe(code, pk);
    codes[code] = { ...(codes[code] || {}), ...res, method: "stripe", checked: Date.now() };
    checked++;
    if (res.status === "valid") valid++;
    await sleep(60);
  }

  const done = end >= scan.queue.length;
  await setState({
    codes,
    scan: { ...scan, index: end, checked, valid, running: !done },
    lastScan: done ? Date.now() : st.lastScan,
    lastMessage: done
      ? `scan finished — ${checked} checked, ${valid} candidates`
      : `scanning… ${end}/${scan.queue.length}`
  });

  if (!done) { chrome.alarms.create("tick", { when: Date.now() + 300 }); return; }

  const stt = await getState();
  if (stt.settings.deepCheck) {
    const survivors = Object.entries(stt.codes)
      .filter(([, v]) => v.status === "valid")
      .map(([k]) => k)
      .slice(0, 60);
    if (survivors.length) await deepCheck(survivors);
  }
}

/* ---------------- level 2: real deep check ---------------- */
function waitComplete(tabId, timeout = 30000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      resolve();
    };
    const listener = (id, info) => { if (id === tabId && info.status === "complete") finish(); };
    chrome.tabs.onUpdated.addListener(listener);
    const timer = setTimeout(finish, timeout);
  });
}

async function deepCheck(codes) {
  let tab;
  try {
    tab = await chrome.tabs.create({ url: "about:blank", active: false });
    for (const code of codes) {
      const url = `https://elevenlabs.io/?coupon=${encodeURIComponent(code)}`;
      try { await chrome.tabs.update(tab.id, { url }); } catch (e) { break; }
      await waitComplete(tab.id);
      await sleep(2600);

      let res = { verdict: "unknown", detail: "no response" };
      try { res = await chrome.tabs.sendMessage(tab.id, { type: "GET_COUPON_RESULT" }); } catch (e) {}

      if (res.verdict === "valid") await upsertCode(code, { status: "valid", method: "deep", detail: res.detail });
      else if (res.verdict === "invalid") await upsertCode(code, { status: "invalid", method: "deep", detail: res.detail });
      else await upsertCode(code, { method: "deep?", detail: res.detail });

      await sleep(400);
    }
    await setState({ lastMessage: `deep check finished (${codes.length} codes)` });
  } finally {
    if (tab && tab.id) { try { await chrome.tabs.remove(tab.id); } catch (e) {} }
  }
}

/* ---------------- messaging ---------------- */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg.type) {
        case "GET_STATE": {
          const st = await getState();
          sendResponse({ ok: true, state: st });
          break;
        }
        case "CHECK_ONE": {
          const pk = await discoverPk();
          const res = await validateStripe((msg.code || "").toUpperCase(), pk);
          await upsertCode(msg.code.toUpperCase(), { ...res, method: "stripe", source: "manual" });
          sendResponse({ ok: true, result: res });
          break;
        }
        case "DEEP_CHECK_ONE":
          await deepCheck([msg.code.toUpperCase()]);
          sendResponse({ ok: true });
          break;
        case "START_SCAN": await startScan(); sendResponse({ ok: true }); break;
        case "STOP_SCAN": {
          const st = await getState();
          await setState({ scan: { ...st.scan, running: false } });
          sendResponse({ ok: true });
          break;
        }
        case "CLEAR": await setState({ codes: {} }); sendResponse({ ok: true }); break;
        case "SET_PK": await setState({ pk: msg.pk || "" }); sendResponse({ ok: true }); break;
        case "REDISCOVER": sendResponse({ ok: true, pk: await discoverPk(true) }); break;
        case "SET_SETTINGS": {
          const st = await getState();
          await setState({ settings: { ...st.settings, ...msg.settings } });
          sendResponse({ ok: true });
          break;
        }
        default: sendResponse({ ok: false, error: "unknown message" });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String(e) });
    }
  })();
  return true;
});

/* ---------------- scheduler ---------------- */
chrome.alarms.create("autoscan", { periodInMinutes: 360 });

chrome.alarms.onAlarm.addListener(async (a) => {
  if (a.name === "tick") return tick();
  if (a.name === "autoscan") {
    const st = await getState();
    if (st.settings.autoScan && !st.scan.running) startScan();
  }
});