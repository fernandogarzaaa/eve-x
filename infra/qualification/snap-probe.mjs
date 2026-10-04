#!/usr/bin/env node
const API = "http://127.0.0.1:8080";
const H = { "Content-Type": "application/json", Authorization: "Bearer " + (process.env.EVEX_AUTH_TOKEN ?? "") };
const ID = "vm-5d02909a";
async function call(method, path, body) {
  const r = await fetch(API + path, { method, headers: H, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, json: j };
}
async function st(tag) {
  const s = await call("GET", `/v1/vms/${ID}/status`);
  console.log(`STATE[${tag}]=${s.json.state} (http ${s.status})`);
}
await st("start");
const s1 = await call("POST", `/v1/vms/${ID}/snapshot`, { label: "probe1" });
console.log("snap:", s1.status, JSON.stringify(s1.json).slice(0, 120));
await st("post-snap");
const r1 = await call("POST", `/v1/vms/${ID}/restore`, { snapshot: "probe1" });
console.log("restore:", r1.status, JSON.stringify(r1.json).slice(0, 120));
await st("post-restore");
process.exit(0);
