#!/usr/bin/env node
// Canonical E2E continuation from acts phase on a live session.
// Usage: SID=... node canonical-cont.mjs
const API = process.env.EVE_API ?? "http://127.0.0.1:8080";
const TOKEN = process.env.EVEX_AUTH_TOKEN ?? "";
const ART = process.env.ARTDIR ?? "/root/evex-prod/artifacts/qualification";
const SID = process.env.SID;
if (!SID) throw new Error("SID required");
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const H = { "Content-Type": "application/json", ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}) };
const out = { at: new Date().toISOString(), api: API, sessionId: SID, phases: [] };
const rec = (name, ok, detail) => {
  out.phases.push({ name, ok, detail: String(detail).slice(0, 300) });
  console.log(`${ok ? "PASS" : "FAIL"} ${name} :: ${String(detail).slice(0, 160)}`);
  if (!ok) { flush(); process.exitCode = 1; throw new Error("canonical abort: " + name); }
};
const flush = () => {
  mkdirSync(ART, { recursive: true });
  writeFileSync(join(ART, "canonical-e2e.json"), JSON.stringify(out, null, 2));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function call(method, path, body) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 300000);
  let r;
  try {
    r = await fetch(API + path, { method, headers: H, body: body === undefined ? undefined : JSON.stringify(body), signal: ctrl.signal });
  } catch (e) {
    clearTimeout(t);
    return { status: 0, json: { error: "fetch_failed", message: String(e?.message ?? e).slice(0, 200) } };
  }
  clearTimeout(t);
  const j = await r.json().catch(() => ({}));
  return { status: r.status, json: j };
}

const GOAL = "Open the terminal, inspect the desktop, and confirm the environment is usable";
// Baseline observe (desktop already up on this session).
const obs = await call("GET", `/v1/computer/${SID}/observe`);
rec("observe-graphical", obs.status === 200 && obs.json.width >= 800, `${obs.json.width}x${obs.json.height} regions=${(obs.json.regions ?? []).length} synthetic=${obs.json.synthetic}`);
writeFileSync(join(ART, "canonical-desktop.png"), Buffer.from(obs.json.pngBase64, "base64"));
let frame = obs.json.frameId;

// Click, hotkey (terminal), terminal command, scroll — each re-observed.
let r = await call("POST", `/v1/computer/${SID}/act`, { type: "click", x: 640, y: 400, confidence: 0.9, frameId: frame });
rec("act-click", r.status === 200 && r.json.synthetic === false, `seq=${r.json.seq}`);
frame = r.json.frameId;
r = await call("POST", `/v1/computer/${SID}/act`, { type: "hotkey", keys: ["Control_L", "Alt_L", "t"], confidence: 0.85, frameId: frame });
rec("act-hotkey", r.status === 200, `seq=${r.json.seq}`);
frame = r.json.frameId;
r = await call("POST", `/v1/computer/${SID}/act`, { type: "terminal", text: "echo EVE-CANONICAL-PROBE > /tmp/eve-canonical && cat /tmp/eve-canonical", confidence: 0.9, frameId: frame });
rec("act-terminal", r.status === 200, `seq=${r.json.seq}`);
frame = r.json.frameId;
r = await call("POST", `/v1/computer/${SID}/act`, { type: "scroll", x: 640, y: 400, confidence: 0.8, frameId: frame });
rec("act-scroll", r.status === 200, `seq=${r.json.seq}`);
frame = r.json.frameId;

// Stale rejection on the real path.
const stale = await call("POST", `/v1/computer/${SID}/act`, { type: "click", x: 1, y: 1, frameId: "frame-stale-000" });
rec("stale-rejected", stale.status === 409 && stale.json.error === "stale_perception", JSON.stringify(stale.json).slice(0, 120));

// Human loop.
const tk = await call("POST", "/v1/human/takeover", { sessionId: SID, reason: "canonical human check" });
rec("takeover", tk.status === 200 && tk.json.humanControl === true, "human holds control");
const denied = await call("POST", `/v1/computer/${SID}/act`, { type: "click", x: 5, y: 5 });
rec("act-denied-during-takeover", denied.status === 409, `error=${denied.json.error}`);
const rel = await call("POST", "/v1/human/release", { sessionId: SID });
rec("release", rel.status === 200 && rel.json.humanControl === false, "control returned");
const reobs = await call("GET", `/v1/computer/${SID}/observe`);
rec("re-observe", reobs.status === 200, `frame=${String(reobs.json.frameId).slice(0, 20)}`);

// Blind review on a real step.
const trace0 = await call("GET", `/v1/trace/${SID}`);
const steps0 = trace0.json.steps ?? [];
rec("trace-has-steps", steps0.length >= 5, `steps=${steps0.length}`);
const rv = await call("POST", "/v1/reviews", { sessionId: SID });
rec("blind-enqueue", rv.status === 200 || rv.status === 201, `review=${rv.json.reviewId ?? JSON.stringify(rv.json).slice(0, 80)}`);
const reviewId = rv.json.reviewId;
if (reviewId) {
  const blindText = JSON.stringify(rv.json.blind ?? rv.json);
  rec("blind-hides-model", !/confidence/.test(blindText), "no confidence in blind artifact");
  const jud = await call("POST", "/v1/judgments", {
    stepId: rv.json.blind?.step_id ?? steps0[1]?.step_id, reviewer: "canonical-reviewer",
    reasonable: true, targetCorrect: true, understandable: true, expected: true, recoveryOk: true, reviewId,
  });
  rec("judgment-unlocks", jud.status === 200 || jud.status === 201, `status=${jud.status}`);
}

// Snapshot/mutate/restore + fork on the graphical guest.
const sessInfo = await call("GET", `/v1/sessions/${SID}`);
const vmId = sessInfo.json.vmId;
const snap = await call("POST", `/v1/vms/${vmId}/snapshot`, { label: "canon1" });
rec("snapshot", snap.status === 200, JSON.stringify(snap.json.snapshots ?? snap.json).slice(0, 100));
await call("POST", `/v1/computer/${SID}/act`, { type: "terminal", text: "echo MUTATED > /tmp/eve-canonical", frameId: reobs.json.frameId });
const rst = await call("POST", `/v1/vms/${vmId}/restore`, { snapshot: "canon1" });
rec("restore", rst.status === 200, `restored=${rst.json.restored}`);
const fork = await call("POST", `/v1/vms/${vmId}/fork`, {});
rec("fork", fork.status === 201, `child=${fork.json.id}`);

// Report + replay + benchmark + task validate.
const rep = await call("GET", `/v1/report/${SID}`);
rec("report", rep.status === 200 && (rep.json.steps ?? 0) >= 5, `steps=${rep.json.steps}`);
const rep2 = await call("POST", `/v1/replay/${SID}`, {});
rec("replay", rep2.json.verdict === "deterministic-replay-ok", `replayed=${rep2.json.replayed}`);
const bench = await call("POST", "/v1/benchmarks", { name: "canonical-smoke", cases: ["login"], size: 2 });
rec("benchmark-run", bench.status === 201 || bench.status === 200, `status=${bench.status} artifact=${Boolean(bench.json.digest ?? bench.json.results)}`);
const task = await call("POST", "/v1/tasks/start", { goal: GOAL });
const valid = task.status === 201
  ? await call("POST", `/v1/tasks/${task.json.id}/validate`, { verdict: "pass", evidence: { sessionId: SID } })
  : { status: 0, json: {} };
rec("task-validate", valid.status === 200, `status=${valid.status}`);

out.vmId = vmId;
flush();
console.log(`\nCANONICAL COMPLETE session=${SID}`);
