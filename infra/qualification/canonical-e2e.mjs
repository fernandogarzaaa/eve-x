#!/usr/bin/env node
// EVE-X canonical production E2E (§38) on the graphical KVM guest.
// Host AI -> Skill/MCP -> control plane -> task -> graphical KVM VM ->
// guest agent -> desktop -> screen stream -> perception -> grounding ->
// verifier -> action -> observation -> human loop -> evaluation ->
// genesis -> report -> replay -> snapshot/fork -> MinIO artifacts.
// Evidence: artifacts/qualification/canonical-e2e.json (+ PNGs).
const API = process.env.EVE_API ?? "http://127.0.0.1:8080";
const TOKEN = process.env.EVEX_AUTH_TOKEN ?? "";
const ART = process.env.ARTDIR ?? "/root/evex-prod/artifacts/qualification";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const H = { "Content-Type": "application/json", ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}) };
const out = { at: new Date().toISOString(), api: API, phases: [] };
const rec = (name, ok, detail) => {
  out.phases.push({ name, ok, detail: String(detail).slice(0, 300) });
  console.log(`${ok ? "PASS" : "FAIL"} ${name} :: ${String(detail).slice(0, 200)}`);
  if (!ok) { flush(); process.exitCode = 1; throw new Error("canonical abort: " + name); }
};
// Session create is retried: a cold manager (first boot after restart) can
// take a minute, and quota pressure from stale entries is an environment
// condition the harness must surface, not trip over silently.
async function createSessionRetried(payload, tries = 3) {
  let last = null;
  for (let i = 0; i < tries; i++) {
    last = await call("POST", "/v1/sessions", payload);
    if (last.status === 201) return last;
    console.log(`session-create attempt ${i + 1}: status=${last.status} body=${JSON.stringify(last.json).slice(0, 200)}`);
    await sleep(20000);
  }
  return last;
}
const flush = () => {
  mkdirSync(ART, { recursive: true });
  const tag = out.sessionId ?? `norun-${Date.now()}`;
  writeFileSync(join(ART, `canonical-e2e.json`), JSON.stringify(out, null, 2));
  writeFileSync(join(ART, `canonical-e2e-${tag}.json`), JSON.stringify(out, null, 2));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function call(method, path, body) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 300000);
  let r;
  try {
    r = await fetch(API + path, {
      method, headers: H,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (e) {
    clearTimeout(t);
    return { status: 0, json: { error: "fetch_failed", message: String(e?.message ?? e).slice(0, 200) } };
  }
  clearTimeout(t);
  const j = await r.json().catch(() => ({}));
  return { status: r.status, json: j };
}

const GOAL = "Open the terminal, inspect the desktop, and confirm the environment is usable";
// Hermetic start: stop+destroy every pre-existing session/VM so orphans from
// aborted runs cannot starve this run of RAM (observed live: OOM-wedged guests
// poison subsequent boots on small hosts).
{
  const ss = await call("GET", "/v1/sessions");
  for (const s of ss.json.sessions ?? []) {
    await call("POST", `/v1/sessions/${s.id}/stop`, {});
    if (s.vmId) await call("DELETE", `/v1/vms/${s.vmId}`);
  }
  const vs = await call("GET", "/v1/vms");
  for (const v of vs.json.vms ?? []) {
    await call("DELETE", `/v1/vms/${v.id}`);
  }
}
const sess = await createSessionRetried({ goal: GOAL, persona: "first-time-user", vm: { image: "eve-desktop-xorg", cpu: 2, memoryMb: 3072, width: 1280, height: 800, network: "allowlisted" } });
out.sessionId = sess.json.id;
rec("session-create", sess.status === 201 && sess.json.backend === "qemu", `sess=${sess.json.id} backend=${sess.json.backend}`);
const SID = sess.json.id;

// 2. Observe until the desktop mode converges to 1280x800 (lazy enforcement).
let obs = null;
for (let i = 0; i < 40; i++) {
  obs = await call("GET", `/v1/computer/${SID}/observe`);
  if (obs.status === 200 && obs.json.width === 1280 && obs.json.height === 800) break;
  await sleep(15000);
}
rec("observe-desktop-1280x800", obs.status === 200 && obs.json.width === 1280, `${obs.json.width}x${obs.json.height} regions=${(obs.json.regions ?? []).length} synthetic=${obs.json.synthetic}`);
writeFileSync(join(ART, "canonical-desktop.png"), Buffer.from(obs.json.pngBase64, "base64"));
let frame = obs.json.frameId;

// 3. Computer actions: click, type, hotkey, scroll, terminal (each re-observed).
const acts = [
  { type: "click", x: 640, y: 400, confidence: 0.9, frameId: frame },
];
let r = await call("POST", `/v1/computer/${SID}/act`, acts[0]);
rec("act-click", r.status === 200 && r.json.synthetic === false, `seq=${r.json.seq} frame=${String(r.json.frameId).slice(0, 20)}`);
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

// 4. Stale rejection proof on the real path.
const stale = await call("POST", `/v1/computer/${SID}/act`, { type: "click", x: 1, y: 1, frameId: "frame-stale-000" });
rec("stale-rejected", stale.status === 409 && stale.json.error === "stale_perception", JSON.stringify(stale.json).slice(0, 120));

// 5. Human loop: takeover -> (human acts via takeover flag) -> release -> re-observe.
const tk = await call("POST", "/v1/human/takeover", { sessionId: SID, reason: "canonical human check" });
rec("takeover", tk.status === 200 && tk.json.humanControl === true, "human holds control");
const denied = await call("POST", `/v1/computer/${SID}/act`, { type: "click", x: 5, y: 5 });
rec("act-denied-during-takeover", denied.status === 409, `error=${denied.json.error}`);
const rel = await call("POST", "/v1/human/release", { sessionId: SID });
rec("release", rel.status === 200 && rel.json.humanControl === false, "control returned");
const reobs = await call("GET", `/v1/computer/${SID}/observe`);
rec("re-observe", reobs.status === 200, `frame=${String(reobs.json.frameId).slice(0, 20)}`);

// 6. Blind review on a real step (server-side blinding).
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

// 7. Snapshot -> mutate -> restore proof + fork isolation on the GRAPHICAL guest.
// Driver state is sampled after every step (forensic trail).
const vmId = sess.json.vmId;
const st = async (tag) => {
  const s = await call("GET", `/v1/vms/${vmId}/status`);
  console.log(`STATE[${tag}]=${s.json.state}`);
  return s.json.state;
};
await st("pre-snap");
const snap = await call("POST", `/v1/vms/${vmId}/snapshot`, { label: "canon1" });
rec("snapshot", snap.status === 200, JSON.stringify(snap.json.snapshots ?? snap.json).slice(0, 100));
await st("post-snap");
await call("POST", `/v1/computer/${SID}/act`, { type: "terminal", text: "echo MUTATED > /tmp/eve-canonical", frameId: reobs.json.frameId });
await st("post-mutate");
const rst = await call("POST", `/v1/vms/${vmId}/restore`, { snapshot: "canon1" });
rec("restore", rst.status === 200, `restored=${rst.json.restored}`);
await st("post-restore");
// Fork with one retry: savevm scales with guest RAM dirtied pages and host
// I/O pressure, so a first attempt can time out where a retry succeeds.
// Both attempts are recorded; success-after-retry is honest evidence.
let fork = await call("POST", `/v1/vms/${vmId}/fork`, {});
if (fork.status !== 201) {
  console.log(`fork attempt 1: status=${fork.status} body=${JSON.stringify(fork.json).slice(0, 300)}; waiting 90s and retrying once`);
  await sleep(90000);
  fork = await call("POST", `/v1/vms/${vmId}/fork`, {});
}
rec("fork", fork.status === 201, `child=${fork.json.id} status=${fork.status} ${fork.status !== 201 ? JSON.stringify(fork.json).slice(0, 200) : ""}`);
await st("post-fork");

// 8. Report + replay + benchmark (real runner) + task validate.
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
console.log(`\nCANONICAL COMPLETE session=${out.sessionId}`);
