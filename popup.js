const $ = (id) => document.getElementById(id);
let state = null;

const send = (msg) => new Promise((res) => chrome.runtime.sendMessage(msg, (r) => res(r || { ok: false })));

async function refresh() {
  const r = await send({ type: "GET_STATE" });
  if (!r.ok) return;
  state = r.state;

  $("keyStatus").textContent = state.pk ? "key ok" : "key missing";
  $("keyStatus").className = "pill " + (state.pk ? "ok" : "bad");
  if (document.activeElement !== $("pkInput")) $("pkInput").value = state.pk || "";

  $("deepToggle").checked = !!state.settings.deepCheck;
  $("autoToggle").checked = !!state.settings.autoScan;

  const scan = state.scan;
  const total = scan.queue.length || 1;
  $("barFill").style.width = Math.round((scan.index / total) * 100) + "%";
  $("log").textContent =
    `running: ${scan.running}\nchecked: ${scan.checked}\nvalid:   ${scan.valid}\nqueue:   ${scan.queue.length}` +
    (state.lastMessage ? `\n\n${state.lastMessage}` : "");

  renderValid();
}

function renderValid() {
  const rows = Object.entries(state.codes || {})
    .filter(([, v]) => v.status === "valid")
    .sort((a, b) => (b[1].checked || 0) - (a[1].checked || 0));

  if (!rows.length) {
    $("validList").innerHTML = `<p class="muted">Nothing valid yet. Run a scan.</p>`;
    return;
  }
  $("validList").innerHTML = rows.map(([code, v]) =>
    `<div class="codeRow">
       <span class="code">${code}</span>
       <span class="disc">${v.discount || "discount"}</span>
       <span class="method">${v.method || ""}</span>
     </div>`).join("");
}

document.querySelectorAll("nav button").forEach((b) => {
  b.onclick = () => {
    document.querySelectorAll("nav button").forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
    ["check", "scan", "valid", "settings"].forEach((t) => { $("tab-" + t).hidden = t !== b.dataset.tab; });
  };
});

$("checkBtn").onclick = async () => {
  const code = $("codeInput").value.trim().toUpperCase();
  if (!code) return;
  $("checkResult").innerHTML = `<span class="muted">checking…</span>`;
  const r = await send({ type: "CHECK_ONE", code });
  const res = r.result || {};
  const cls = res.status === "valid" ? "ok" : res.status === "invalid" ? "bad" : "warn";
  $("checkResult").innerHTML =
    `<div class="${cls}"><b>${code}</b> → ${res.status}${res.discount ? " · " + res.discount : ""}
     <br><small class="muted">${res.detail || ""}</small></div>`;
  refresh();
};

$("deepBtn").onclick = async () => {
  const code = $("codeInput").value.trim().toUpperCase();
  if (!code) return;
  $("checkResult").innerHTML = `<span class="muted">deep checking — a tab will open…</span>`;
  await send({ type: "DEEP_CHECK_ONE", code });
  $("checkResult").innerHTML = `<span class="muted">done — see the Valid tab</span>`;
  refresh();
};

$("scanBtn").onclick = async () => { await send({ type: "START_SCAN" }); refresh(); };
$("stopBtn").onclick = async () => { await send({ type: "STOP_SCAN" }); refresh(); };
$("savePk").onclick = async () => { await send({ type: "SET_PK", pk: $("pkInput").value.trim() }); refresh(); };
$("rediscover").onclick = async () => { await send({ type: "REDISCOVER" }); refresh(); };
$("clearBtn").onclick = async () => { if (confirm("Clear all stored codes?")) { await send({ type: "CLEAR" }); refresh(); } };
$("deepToggle").onchange = (e) => send({ type: "SET_SETTINGS", settings: { deepCheck: e.target.checked } });
$("autoToggle").onchange = (e) => send({ type: "SET_SETTINGS", settings: { autoScan: e.target.checked } });

refresh();
setInterval(refresh, 2000);