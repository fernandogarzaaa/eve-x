#!/usr/bin/env node
const API = "http://127.0.0.1:8080";
const H = { "Content-Type": "application/json", Authorization: "Bearer qual-canonical-token-0123456789abcdef" };
const r = await fetch(API + "/v1/sessions", {
  method: "POST", headers: H,
  body: JSON.stringify({ goal: "manual probe", vm: { image: "eve-desktop-xorg", cpu: 2, memoryMb: 4096, width: 1280, height: 800, network: "allowlisted" } }),
  signal: AbortSignal.timeout(120000),
});
console.log("STATUS:", r.status);
console.log("BODY:", (await r.text()).slice(0, 500));
process.exit(0);
