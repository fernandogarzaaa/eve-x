"use strict";
/* EVE-X console app: ws stream via /v1/stream/:sessionId, canvas viewer, overlays, timeline, replay, blind review. */
const $ = (id) => document.getElementById(id);
const logEl = $("log");
let ws = null;
let steps = [];
let curIdx = -1;

function log(msg) {
  // textContent only: log lines echo server/model-controlled text (action
  // types, labels, error detail) and must never become live HTML (XSS).
  const t = new Date().toLocaleTimeString();
  const div = document.createElement("div");
  div.textContent = `[${t}] ${msg}`;
  logEl.appendChild(div);
  logEl.scrollTop = logEl.scrollHeight;
}
function apiBase() { return $("apiBase").value.replace(/\/$/, ""); }
function headers() {
  const t = $("token").value.trim();
  return { "Content-Type": "application/json", ...(t ? { Authorization: `Bearer ${t}` } : {}) };
}
async function call(path, opts = {}) {
  const r = await fetch(apiBase() + path, { ...opts, headers: { ...headers(), ...(opts.headers || {}) } });
  const text = await r.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { _raw: text }; }
  if (!r.ok) throw new Error(`${r.status} ${path}: ${text.slice(0, 300)}`);
  return body;
}
function setConn(live) {
  const c = $("conn");
  c.textContent = live ? "live" : "disconnected";
  c.classList.toggle("live", !!live);
}
function drawFrame(frame) {
  const cv = $("screen");
  const g = cv.getContext("2d");
  g.fillStyle = "#10151d";
  g.fillRect(0, 0, cv.width, cv.height);
  g.fillStyle = "#1b2432";
  g.fillRect(0, 0, cv.width, 28);
  g.fillStyle = "#8fa2bb";
  g.font = "12px system-ui";
  g.fillText(`EVE-X · ${frame.sessionId || ""} · ${frame.frameId || ""} · ${frame.status || ""}`, 10, 18);
  // synthetic desktop: taskbar + cursor
  g.fillStyle = "#232f44";
  g.fillRect(0, cv.height - 26, cv.width, 26);
  const cx = ((frame.seq || 0) * 37) % 400;
  g.fillStyle = "#fff";
  g.beginPath();
  g.moveTo(320 + cx / 2, 200); g.lineTo(332 + cx / 2, 228); g.lineTo(324 + cx / 2, 228);
  g.closePath(); g.fill();
  if (frame.pngBase64) {
    const img = new Image();
    img.onload = () => g.drawImage(img, 0, 0, cv.width, cv.height);
    img.src = "data:image/png;base64," + frame.pngBase64;
  }
  $("kFrame").textContent = frame.frameId || "—";
}
function drawOverlays(overlays, W = 1920, H = 1080) {
  const ov = $("overlay");
  ov.innerHTML = "";
  const stage = $("stage").getBoundingClientRect();
  (overlays || []).forEach((o) => {
    // Canonical bbox is corners [x0, y0, x1, y1] (protocol-wide).
    const b = o.bbox || [0, 0, 100, 40];
    const x = b[0], y = b[1], w = Math.max(1, b[2] - b[0]), h = Math.max(1, b[3] - b[1]);
    const d = document.createElement("div");
    d.className = "bbox";
    d.style.left = `${(x / W) * stage.width}px`;
    d.style.top = `${(y / H) * stage.height}px`;
    d.style.width = `${Math.max(8, (w / W) * stage.width)}px`;
    d.style.height = `${Math.max(8, (h / H) * stage.height)}px`;
    const conf = o.confidence !== undefined ? ` ${(Math.round(o.confidence * 100))}%` : "";
    // textContent only: labels/regionIds are perception/model-controlled.
    const span = document.createElement("span");
    span.textContent = `${o.label || o.regionId || "target"}${conf}`;
    d.appendChild(span);
    ov.appendChild(d);
  });
}
function renderTimeline() {
  const tl = $("timeline");
  tl.innerHTML = "";
  steps.forEach((s, i) => {
    const b = document.createElement("div");
    b.className = "tick" + (i === curIdx ? " cur" : "") + (s.human_intervention ? " human" : "");
    b.textContent = `#${s.seq ?? i}`;
    b.title = `${s.step_id || ""} · ${s.actor || ""} · ${((s.selected_action || {}).type) || ""}`;
    b.onclick = () => { curIdx = i; renderTimeline(); renderStep(s); };
    tl.appendChild(b);
  });
  $("kSteps").textContent = String(steps.length);
}
function renderStep(s) {
  const sel = s.selected_action || {};
  log(`step #${s.seq} · ${s.actor} · ${sel.type || "?"} · ${s.outcome || ""}`);
  drawOverlays(sel.target && sel.target.bbox ? [{ ...sel.target, confidence: sel.confidence }] : []);
  if (s.step_id) $("jStep").value = s.step_id;
}
function connect() {
  const sid = $("sessionId").value.trim();
  if (!sid) { log("set a session id first"); return; }
  const base = apiBase().replace(/^http/, "ws");
  const token = $("token").value.trim();
  const url = `${base}/v1/stream/${encodeURIComponent(sid)}${token ? `?token=${encodeURIComponent(token)}` : ""}`;
  if (ws) { try { ws.close(); } catch {} }
  ws = new WebSocket(url);
  ws.onopen = () => { setConn(true); $("sessPill").textContent = sid; log(`stream open ${sid}`); };
  ws.onclose = () => { setConn(false); log("stream closed"); };
  ws.onerror = () => log("stream error");
  ws.onmessage = (ev) => {
    try {
      const m = JSON.parse(ev.data);
      if (m.kind === "frame") { drawFrame(m); drawOverlays(m.overlays || []); }
      else if (m.kind === "step" && m.step) {
        steps.push(m.step); curIdx = steps.length - 1;
        renderTimeline(); renderStep(m.step);
        drawFrame({ sessionId: sid, frameId: m.step.screen_after || "", seq: m.step.seq, status: "" });
      } else if (m.kind === "status") { $("kStatus").textContent = m.status; }
      else if (m.kind === "takeover") { $("kHuman").textContent = "YES"; log("human takeover active"); }
      else if (m.kind === "release") { $("kHuman").textContent = "no"; log("human released"); }
      else if (m.kind === "hello") { $("clock").textContent = m.at || ""; }
    } catch { /* ignore */ }
  };
}

$("btnConnect").onclick = connect;
$("btnObserve").onclick = async () => {
  const sid = $("sessionId").value.trim();
  const p = await call(`/v1/computer/${encodeURIComponent(sid)}/observe`).catch((e) => { log(String(e.message || e)); return null; });
  if (p) { log(`observed ${p.frameId} · ${p.regions.length} regions`); drawOverlays(p.regions); }
};
$("btnPause").onclick = async () => {
  const sid = $("sessionId").value.trim();
  await call(`/v1/sessions/${encodeURIComponent(sid)}/pause`, { method: "POST", body: "{}" }).catch((e) => log(String(e.message || e)));
  $("kStatus").textContent = "PAUSED"; log("paused");
};
$("btnStep").onclick = async () => {
  const sid = $("sessionId").value.trim();
  const r = await call(`/v1/sessions/${encodeURIComponent(sid)}/step`, { method: "POST", body: "{}" }).catch((e) => { log(String(e.message || e)); return null; });
  if (r) log(`stepped to seq=${r.seq}`);
};
$("btnTakeover").onclick = async () => {
  const sid = $("sessionId").value.trim();
  await call(`/v1/human/takeover`, { method: "POST", body: JSON.stringify({ sessionId: sid }) }).catch((e) => log(String(e.message || e)));
};
$("btnRelease").onclick = async () => {
  const sid = $("sessionId").value.trim();
  await call(`/v1/human/release`, { method: "POST", body: JSON.stringify({ sessionId: sid }) }).catch((e) => log(String(e.message || e)));
};
$("btnStop").onclick = async () => {
  const sid = $("sessionId").value.trim();
  await call(`/v1/sessions/${encodeURIComponent(sid)}/stop`, { method: "POST", body: "{}" }).catch((e) => log(String(e.message || e)));
  $("kStatus").textContent = "STOPPED"; log("stopped");
};
$("btnCreate").onclick = async () => {
  const r = await call(`/v1/sessions`, { method: "POST", body: JSON.stringify({ goal: $("goal").value || "open the browser" }) }).catch((e) => { log(String(e.message || e)); return null; });
  if (r) { $("sessionId").value = r.id; $("kStatus").textContent = r.status; $("sessPill").textContent = r.id; log(`created ${r.id}`); connect(); }
};
$("btnAct").onclick = async () => {
  const sid = $("sessionId").value.trim();
  const body = { type: $("actType").value, x: Number($("actX").value), y: Number($("actY").value), text: $("actText").value || undefined };
  const r = await call(`/v1/computer/${encodeURIComponent(sid)}/act`, { method: "POST", body: JSON.stringify(body) }).catch((e) => { log(String(e.message || e)); return null; });
  if (r) log(`acted seq=${r.seq}`);
};
$("btnReplay").onclick = async () => {
  const sid = $("sessionId").value.trim();
  const r = await call(`/v1/replay/${encodeURIComponent(sid)}`, { method: "POST", body: "{}" }).catch((e) => { log(String(e.message || e)); return null; });
  if (r) log(`replay: ${r.replayed} steps · ${r.verdict}`);
};
$("btnTrace").onclick = async () => {
  const sid = $("sessionId").value.trim();
  const r = await call(`/v1/trace/${encodeURIComponent(sid)}`).catch((e) => { log(String(e.message || e)); return null; });
  if (r) { steps = r.steps || []; curIdx = steps.length - 1; renderTimeline(); if (steps[curIdx]) renderStep(steps[curIdx]); log(`trace: ${steps.length} steps`); }
};
$("btnReport").onclick = async () => {
  const sid = $("sessionId").value.trim();
  const r = await call(`/v1/report/${encodeURIComponent(sid)}`).catch((e) => { log(String(e.message || e)); return null; });
  if (r) log(`report: status=${r.status} steps=${r.steps} success=${r.success}`);
};
$("btnSnap").onclick = async () => {
  const r = await call(`/v1/vms`, { method: "POST", body: JSON.stringify({}) }).catch((e) => { log(String(e.message || e)); return null; });
  if (r) log(`vm ready: ${r.id}`);
};
$("btnJudge").onclick = async () => {
  const body = {
    stepId: $("jStep").value.trim(), reviewer: ($("jReviewer") ? $("jReviewer").value.trim() : "") || "console",
    reasonable: $("jReasonable").value === "true",
    targetCorrect: $("jTarget").value === "true",
    understandable: true, expected: true, recoveryOk: true,
    note: $("jNote").value || undefined,
  };
  // Blind-mode: when a blind review was enqueued, submit against its reviewId.
  // The server 409s a double-submit and returns the FULL step (unlock) on success.
  if (pendingReviewId) body.reviewId = pendingReviewId;
  const r = await call(`/v1/judgments`, { method: "POST", body: JSON.stringify(body) }).catch((e) => { log(String(e.message || e)); return null; });
  if (r) {
    log(`judgment recorded ${r.id}${r.reviewId ? ` (review ${r.reviewId} complete — full step unlocked)` : " (direct submit, was NOT blinded)"}`);
    if (r.full) {
      const sel = r.full.selected_action || {};
      log(`unlocked: type=${sel.type || "?"} confidence=${sel.confidence ?? "?"} outcome=${r.full.outcome || ""}`);
    }
    pendingReviewId = null;
    $("kReview").textContent = "none";
  }
};
// Server-side blind review: enqueue first (blind artifact has no confidence),
// judge second. Never judge from a raw trace read — that is not blind.
let pendingReviewId = null;
$("btnBlind").onclick = async () => {
  const sid = $("sessionId").value.trim();
  const stepId = $("jStep").value.trim();
  const r = await call(`/v1/reviews`, { method: "POST", body: JSON.stringify({ sessionId: sid, ...(stepId ? { stepId } : {}) }) }).catch((e) => { log(String(e.message || e)); return null; });
  if (r) {
    pendingReviewId = r.reviewId;
    $("kReview").textContent = r.reviewId;
    const b = r.blind || {};
    const leaked = ["confidence", "rationale", "prediction", "verification", "score"].filter((k) => JSON.stringify(b).includes(`"${k}"`));
    $("blindBox").textContent = `Blind ${r.reviewId} · step ${b.stepId || "?"} · ` +
      (leaked.length === 0 ? "clean (no model-revealing fields)" : `LEAKED FIELDS: ${leaked.join(",")}`);
    log(`blind review ${r.reviewId} enqueued — judge what you see, then Submit judgment`);
  }
};
setInterval(() => { $("clock").textContent = new Date().toLocaleTimeString(); }, 1000);
log("console ready — create a session, then Connect stream.");
