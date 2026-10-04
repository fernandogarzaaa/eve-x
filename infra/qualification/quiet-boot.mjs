#!/usr/bin/env node
// Create an API session and TOUCH NOTHING after (no observe/VNC). Print ids.
const API = "http://127.0.0.1:8080";
const H = { "Content-Type": "application/json", Authorization: "Bearer " + (process.env.EVEX_AUTH_TOKEN ?? "") };
const r = await fetch(API + "/v1/sessions", {
  method: "POST", headers: H,
  body: JSON.stringify({ goal: "quiet boot probe", vm: { image: "eve-desktop-xorg", cpu: 2, memoryMb: 3072, width: 1280, height: 800, network: "allowlisted" } }),
});
const j = await r.json();
console.log("STATUS:", r.status, "sess:", j.id, "vm:", j.vmId);
process.exit(0);
