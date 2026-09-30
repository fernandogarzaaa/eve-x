#!/usr/bin/env node
// Act helper: act.mjs <sessionId> <type> [x y] [--text "..."].
const base = (process.env.EVEX_API_URL ?? "http://localhost:8080").replace(/\/$/, "");
const token = process.env.EVEX_AUTH_TOKEN ?? "";
const [sessionId, type, xs, ys] = process.argv.slice(2);
if (!sessionId || !type) {
  console.error("usage: act.mjs <sessionId> <type> [x y] [--text ...]");
  process.exit(2);
}
const ti = process.argv.indexOf("--text");
const text = ti >= 0 ? process.argv[ti + 1] ?? "" : undefined;
const body = { type, confidence: 0.9 };
const x = Number(xs);
const y = Number(ys);
if (Number.isFinite(x) && Number.isFinite(y)) {
  body.x = x;
  body.y = y;
}
if (text) body.text = text;
const res = await fetch(`${base}/v1/computer/${encodeURIComponent(sessionId)}/act`, {
  method: "POST",
  headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify(body),
});
const out = await res.text();
if (!res.ok) {
  console.error(`act failed: ${res.status} ${out.slice(0, 500)}`);
  process.exit(1);
}
console.log(out);
