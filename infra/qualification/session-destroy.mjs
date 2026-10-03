#!/usr/bin/env node
// Destroy a dead session + its driver VM through the API (cleanup for retry).
const API = "http://127.0.0.1:8080";
const H = { "Content-Type": "application/json", Authorization: "Bearer qual-canonical-token-0123456789abcdef" };
async function call(method, path, body) {
  const r = await fetch(API + path, { method, headers: H, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, json: j };
}
const sid = process.argv[2];
const s = await call("GET", `/v1/sessions/${sid}`);
console.log("session vm:", s.json.vmId, "status:", s.json.status);
await call("POST", `/v1/sessions/${sid}/stop`, {});
const d = await call("DELETE", `/v1/vms/${s.json.vmId}`);
console.log("destroy:", d.status, JSON.stringify(d.json).slice(0, 160));
process.exit(0);
