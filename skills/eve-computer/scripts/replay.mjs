#!/usr/bin/env node
// Replay helper: POST /v1/replay/:sessionId (body {seed} is accepted and
// ignored by the deterministic checker) → {sessionId, replayed, verdict, issues}.
const base = (process.env.EVEX_API_URL ?? process.env.EVEX_CONTROL_PLANE_URL ?? "http://localhost:8080").replace(/\/$/, "");
const token = process.env.EVEX_AUTH_TOKEN ?? "";

const raw = process.argv.slice(2);
if (raw.length === 0 || raw.includes("--help") || raw.includes("-h")) {
  console.error("usage: replay.mjs <sessionId> [seed]");
  process.exit(2);
}
const sessionId = raw[0];
const seed = Number(raw[1] ?? 42);
if (!Number.isInteger(seed)) {
  console.error("replay.mjs: seed must be an integer");
  process.exit(2);
}
const res = await fetch(`${base}/v1/replay/${encodeURIComponent(sessionId)}`, {
  method: "POST",
  headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify({ seed }),
});
const out = await res.text();
if (!res.ok) {
  console.error(`replay failed: ${res.status} ${out.slice(0, 500)}`);
  process.exit(1);
}
console.log(out);
