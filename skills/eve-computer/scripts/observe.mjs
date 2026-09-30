#!/usr/bin/env node
// Observe helper: prints the latest percept for a session.
const base = (process.env.EVEX_API_URL ?? "http://localhost:8080").replace(/\/$/, "");
const token = process.env.EVEX_AUTH_TOKEN ?? "";
const sessionId = process.argv[2];
if (!sessionId) {
  console.error("usage: observe.mjs <sessionId>");
  process.exit(2);
}
const res = await fetch(`${base}/v1/computer/${encodeURIComponent(sessionId)}/observe`, {
  headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
});
const text = await res.text();
if (!res.ok) {
  console.error(`observe failed: ${res.status} ${text.slice(0, 500)}`);
  process.exit(1);
}
console.log(text);
