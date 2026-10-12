#!/usr/bin/env node
// EVE-X load harness (Phase 29): bounded session-create floods measuring
// control-plane behavior under pressure. Separates control-plane latency
// from VM boot cost by reporting per-create latency distribution alongside
// quota/429/5xx counts. Cleans up every session it creates (stop + VM
// destroy) so the host returns to baseline.
// Usage:
//   EVEX_API=... EVEX_AUTH_TOKEN=... node infra/qualification/load.mjs [--sessions 10] [--concurrency 4] [--out ...]
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const API = (process.env["EVEX_API"] ?? "http://127.0.0.1:8080").replace(/\/$/, "");
const TOKEN = process.env["EVEX_AUTH_TOKEN"] ?? "";
const OUT = process.env["LOAD_OUT"] ?? join(ROOT, "artifacts", "load");
const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? Number(hit.slice(name.length + 3)) : dflt;
};
const N = Math.max(1, Math.min(500, arg("sessions", 10)));
const CONC = Math.max(1, Math.min(32, arg("concurrency", 4)));
mkdirSync(OUT, { recursive: true });

const H = { "content-type": "application/json", ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}) };
async function post(path, body) {
  const t0 = Date.now();
  try {
    const r = await fetch(`${API}${path}`, { method: "POST", headers: H, body: JSON.stringify(body ?? {}) });
    const ms = Date.now() - t0;
    let j = null;
    try { j = await r.json(); } catch { j = null; }
    return { status: r.status, ms, json: j };
  } catch (err) {
    return { status: -1, ms: Date.now() - t0, error: String(err).slice(0, 200) };
  }
}

const lat = [];
let ok = 0;
const errors = {};
const created = [];
const queue = Array.from({ length: N }, (_, i) => i);
async function worker() {
  while (queue.length > 0) {
    const i = queue.shift();
    const r = await post("/v1/sessions", { goal: `load probe ${i}` });
    lat.push(r.ms);
    if (r.status === 201 && r.json?.id) {
      ok += 1;
      created.push({ sid: r.json.id, vmId: r.json.vmId });
    } else {
      const k = `http-${r.status}`;
      errors[k] = (errors[k] ?? 0) + 1;
    }
  }
}
const t0 = Date.now();
await Promise.all(Array.from({ length: Math.min(CONC, N) }, () => worker()));
const wallMs = Date.now() - t0;

// Cleanup: stop sessions + destroy their VMs (best effort, bounded).
let cleaned = 0;
for (const c of created) {
  try {
    await post(`/v1/sessions/${c.sid}/stop`, {});
    if (c.vmId) {
      const r = await fetch(`${API}/v1/vms/${c.vmId}`, { method: "DELETE", headers: H });
      await r.text().catch(() => "");
      if (r.status === 200) cleaned += 1;
    }
  } catch { /* best effort */ }
}

lat.sort((a, b) => a - b);
const pct = (p) => (lat.length > 0 ? lat[Math.min(lat.length - 1, Math.floor(p * lat.length))] : 0);
const summary = {
  api: API, sessions: N, concurrency: CONC, wallMs,
  created: ok, cleanedVms: cleaned, errors,
  latencyMs: { min: pct(0), p50: pct(0.5), p95: pct(0.95), max: pct(0.999) },
  ranAt: new Date().toISOString(),
};
writeFileSync(join(OUT, "load-summary.json"), JSON.stringify(summary, null, 2) + "\n");
console.log(`load complete: created=${ok}/${N} errors=${JSON.stringify(errors)} p50=${summary.latencyMs.p50}ms p95=${summary.latencyMs.p95}ms cleaned=${cleaned} -> ${OUT}`);
