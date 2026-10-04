#!/usr/bin/env node
const API = "http://127.0.0.1:8080";
const H = { "Content-Type": "application/json", Authorization: "Bearer " + (process.env.EVEX_AUTH_TOKEN ?? "") };
const SID = "sess-4c2bb7b1";
const o = await fetch(`${API}/v1/computer/${SID}/observe`, { headers: H });
const oj = await o.json();
console.log("OBS:", o.status, oj.width, "x", oj.height, String(oj.frameId).slice(0, 20));
const r = await fetch(`${API}/v1/computer/${SID}/act`, {
  method: "POST", headers: H,
  body: JSON.stringify({ type: "hotkey", keys: ["Control_L", "Alt_L", "t"], confidence: 0.85, frameId: oj.frameId }),
});
console.log("ACT:", r.status, (await r.text()).slice(0, 300));
process.exit(0);
