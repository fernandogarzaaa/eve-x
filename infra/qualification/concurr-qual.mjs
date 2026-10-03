#!/usr/bin/env node
// EVE-X KVM concurrency/capacity probe: two graphical desktop sessions live
// at once on the qual host. Each boots, observes, acts; traces must stay
// isolated (no cross-session steps/frames). Evidence: concurrency-qual.json.
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
  if (!ok) { flush(); process.exitCode = 1; throw new Error("concurrency abort: " + name); }
};
const flush = () => {
  mkdirSync(ART, { recursive: true });
  writeFileSync(join(ART, "concurrency-qual.json"), JSON.stringify(out, null, 2));
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
  return { status: r.status, json: await r.json().catch(() => ({})) };
}

// Hermetic start: remove our own leftovers from aborted runs so stale
// guests cannot starve this run of RAM (matches canonical-e2e §hermetic).
{
  const ss = await call("GET", "/v1/sessions");
  for (const s of ss.json.sessions ?? []) {
    if (typeof s.goal === "string" && s.goal.startsWith("concurrency probe")) {
      await call("POST", `/v1/sessions/${s.id}/stop`, {});
      if (s.vmId) await call("DELETE", `/v1/vms/${s.vmId}`);
    }
  }
}

// Two lean desktops (2GB each) fit the 9.6GB WSL2 qual host side by side.
const spec = (n) => ({ goal: `concurrency probe ${n}`, persona: "first-time-user", vm: { image: "eve-desktop-xorg", cpu: 2, memoryMb: 2048, width: 1280, height: 800, network: "allowlisted" } });
const [a, b] = await Promise.all([call("POST", "/v1/sessions", spec("A")), call("POST", "/v1/sessions", spec("B"))]);
rec("dual-create", a.status === 201 && b.status === 201, `A=${a.json.id} B=${b.json.id}`);
const [A, B] = [a.json.id, b.json.id];
out.sessionA = A; out.sessionB = B;

// Observe both until frames flow (concurrent boots).
let fa = null, fb = null;
for (let i = 0; i < 40; i++) {
  const [oa, ob] = await Promise.all([call("GET", `/v1/computer/${A}/observe`), call("GET", `/v1/computer/${B}/observe`)]);
  if (oa.status === 200 && oa.json.width === 1280) fa = oa.json;
  if (ob.status === 200 && ob.json.width === 1280) fb = ob.json;
  if (fa && fb) break;
  await sleep(15000);
}
rec("dual-observe", !!(fa && fb), `A=${fa?.frameId?.slice(0, 18)} B=${fb?.frameId?.slice(0, 18)}`);

// Act on both concurrently with distinct points (flat act body, §canonical).
const [aa, ab] = await Promise.all([
  call("POST", `/v1/computer/${A}/act`, { type: "click", x: 200, y: 200, confidence: 0.9, frameId: fa.frameId }),
  call("POST", `/v1/computer/${B}/act`, { type: "click", x: 1000, y: 600, confidence: 0.9, frameId: fb.frameId }),
]);
rec("dual-act", aa.status === 200 && ab.status === 200, `Aseq=${aa.json.seq} Bseq=${ab.json.seq}`);

// Trace isolation: each session's trace mentions only its own id/frames.
const [ta, tb] = await Promise.all([call("GET", `/v1/trace/${A}`), call("GET", `/v1/trace/${B}`)]);
const sa = JSON.stringify(ta.json), sb = JSON.stringify(tb.json);
rec("trace-isolation",
  ta.status === 200 && tb.status === 200 && !sa.includes(B) && !sb.includes(A) && !sa.includes(fb.frameId) && !sb.includes(fa.frameId),
  `Alen=${sa.length} Blen=${sb.length}`);

// Teardown both; host must return to no running guests of ours.
const [ga, gb] = await Promise.all([call("GET", `/v1/sessions/${A}`), call("GET", `/v1/sessions/${B}`)]);
await call("POST", `/v1/sessions/${A}/stop`, {});
await call("POST", `/v1/sessions/${B}/stop`, {});
const da = await call("DELETE", `/v1/vms/${ga.json.vmId}`);
const db = await call("DELETE", `/v1/vms/${gb.json.vmId}`);
rec("dual-destroy", da.status === 200 && db.status === 200, "both VMs destroyed");
flush();
console.log("CONCURRENCY QUAL COMPLETE");
setTimeout(() => process.exit(0), 500);
