#!/usr/bin/env node
// Free memory pressure: stop the manual probe session + destroy its VM.
const API = "http://127.0.0.1:8080";
const H = { "Content-Type": "application/json", Authorization: "Bearer " + (process.env.EVEX_AUTH_TOKEN ?? "") };
async function call(method, path, body) {
  const r = await fetch(API + path, { method, headers: H, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, json: j };
}
const s = await call("GET", "/v1/sessions/sess-efdb2b13");
console.log("manual session vm:", s.json.vmId);
await call("POST", "/v1/sessions/sess-efdb2b13/stop", {});
const vms = await call("GET", "/v1/vms");
console.log("vms:", JSON.stringify(vms.json.vms.map((v) => v.id)));
const d = await call("DELETE", `/v1/vms/${s.json.vmId}`);
console.log("destroy:", d.status, JSON.stringify(d.json).slice(0, 120));
process.exit(0);
