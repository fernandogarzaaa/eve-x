#!/usr/bin/env node
// Act helper: sends one flat-form action to POST /v1/computer/:sessionId/act.
// Flat body per apps/api/openapi.json: {type, x?, y?, text?, keys?, ms?,
// confidence?, frameId?, idempotencyKey?}.
const base = (process.env.EVEX_API_URL ?? process.env.EVEX_CONTROL_PLANE_URL ?? "http://localhost:8080").replace(/\/$/, "");
const token = process.env.EVEX_AUTH_TOKEN ?? "";

function usage() {
  console.error(
    "usage: act.mjs <sessionId> <type> [x y] [--text ...] [--keys a,b] [--ms N]\n" +
    "              [--confidence 0.9] [--frame <frameId>] [--idempotency-key <key>]\n" +
    "examples:\n" +
    "  act.mjs sess-abc click 640 400\n" +
    "  act.mjs sess-abc type --text \"hello\" --frame f-3 --idempotency-key k1",
  );
}

const raw = process.argv.slice(2);
if (raw.length === 0 || raw.includes("--help") || raw.includes("-h")) {
  usage();
  process.exit(2);
}
const [sessionId, type, xs, ys] = raw;
if (!sessionId || !type) {
  usage();
  process.exit(2);
}

function flag(name) {
  const i = raw.indexOf(name);
  if (i >= 0 && i + 1 < raw.length) return raw[i + 1];
  const pref = raw.find((a) => a.startsWith(name + "="));
  if (pref) return pref.slice(name.length + 1);
  return undefined;
}

const text = flag("--text");
const keysRaw = flag("--keys");
const msRaw = flag("--ms");
const confRaw = flag("--confidence");
const frameId = flag("--frame") ?? flag("--frameId");
const idemKey = flag("--idempotency-key") ?? flag("--idempotencyKey");

const body = { type };
const x = Number(xs);
const y = Number(ys);
if (Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0) {
  body.x = x;
  body.y = y;
}
if (text !== undefined) body.text = text;
if (keysRaw !== undefined) body.keys = String(keysRaw).split(",").map((k) => k.trim()).filter(Boolean);
if (msRaw !== undefined) {
  const ms = Number(msRaw);
  if (!Number.isInteger(ms) || ms < 0) {
    console.error("act.mjs: --ms must be a non-negative integer");
    process.exit(2);
  }
  body.ms = ms;
}
body.confidence = confRaw !== undefined ? Number(confRaw) : 0.9;
if (!Number.isFinite(body.confidence) || body.confidence < 0 || body.confidence > 1) {
  console.error("act.mjs: --confidence must be a number in [0, 1]");
  process.exit(2);
}
if (frameId !== undefined) body.frameId = frameId;
if (idemKey !== undefined) body.idempotencyKey = idemKey;

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
