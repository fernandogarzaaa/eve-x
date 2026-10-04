#!/usr/bin/env node
// Destroy ALL sessions + VMs (clean slate for canonical run).
const API = "http://127.0.0.1:8080";
const H = { "Content-Type": "application/json", Authorization: "Bearer " + (process.env.EVEX_AUTH_TOKEN ?? "") };
async function call(method, path, body) {
  const r = await fetch(API + path, { method, headers: H, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, json: j };
}
const sessions = await call("GET", "/v1/sessions");
for (const s of sessions.json.sessions ?? []) {
  await call("POST", `/v1/sessions/${s.id}/stop`, {});
  const d = await call("DELETE", `/v1/vms/${s.vmId}`);
  console.log(`session ${s.id} stopped, vm ${s.vmId} destroy=${d.status}`);
}
const vms = await call("GET", "/v1/vms");
for (const v of vms.json.vms ?? []) {
  const d = await call("DELETE", `/v1/vms/${v.id}`);
  console.log(`orphan vm ${v.id} destroy=${d.status}`);
}
process.exit(0);
