#!/usr/bin/env node
// Replay helper: replay.mjs <sessionId> [seed].
const base = (process.env.EVEX_API_URL ?? "http://localhost:8080").replace(/\/$/, "");
const token = process.env.EVEX_AUTH_TOKEN ?? "";
const sessionId = process.argv[2];
const seed = Number(process.argv[3] ?? 42);
if (!sessionId) {
  console.error("usage: replay.mjs <sessionId> [seed]");
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
