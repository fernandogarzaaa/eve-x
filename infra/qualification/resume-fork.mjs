#!/usr/bin/env node
const API = "http://127.0.0.1:8080";
const H = { "Content-Type": "application/json", Authorization: "Bearer " + (process.env.EVEX_AUTH_TOKEN ?? "") };
const ID = "vm-5d02909a";
async function call(method, path, body) {
  const r = await fetch(API + path, { method, headers: H, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, json: j };
}
console.log("resume:", JSON.stringify(await call("POST", `/v1/vms/${ID}/resume`)));
console.log("status:", JSON.stringify(await call("GET", `/v1/vms/${ID}/status`)));
const f = await call("POST", `/v1/vms/${ID}/fork`, {});
console.log("fork:", f.status, JSON.stringify(f.json).slice(0, 160));
process.exit(0);
