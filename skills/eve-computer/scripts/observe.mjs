#!/usr/bin/env node
// Observe helper: GET /v1/computer/:sessionId/observe and print the percept.
// Percept shape per apps/api/openapi.json: {frameId, width, height,
// pngBase64, regions[] ({regionId, bbox, label, confidence}), cursor,
// windows, dialogs, loading, provenance}. Prints the raw JSON (pipe-friendly)
// plus a one-line summary on stderr.
const base = (process.env.EVEX_API_URL ?? process.env.EVEX_CONTROL_PLANE_URL ?? "http://localhost:8080").replace(/\/$/, "");
const token = process.env.EVEX_AUTH_TOKEN ?? "";

const raw = process.argv.slice(2);
if (raw.length === 0 || raw.includes("--help") || raw.includes("-h")) {
  console.error("usage: observe.mjs <sessionId>");
  process.exit(2);
}
const sessionId = raw[0];

const res = await fetch(`${base}/v1/computer/${encodeURIComponent(sessionId)}/observe`, {
  headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
});
const text = await res.text();
if (!res.ok) {
  console.error(`observe failed: ${res.status} ${text.slice(0, 500)}`);
  process.exit(1);
}
try {
  const percept = JSON.parse(text);
  const n = Array.isArray(percept.regions) ? percept.regions.length : 0;
  process.stderr.write(`frame ${percept.frameId ?? "?"} ${percept.width ?? "?"}x${percept.height ?? "?"} regions=${n}\n`);
} catch {
  process.stderr.write("observe: non-JSON percept body\n");
}
console.log(text);
