#!/usr/bin/env node
const API = "http://127.0.0.1:8080";
const H = { Authorization: "Bearer " + (process.env.EVEX_AUTH_TOKEN ?? "") };
const id = process.argv[2];
const kind = process.argv[3] ?? "status";
const r = await fetch(`${API}/v1/vms/${id}/${kind}`, { headers: H });
console.log("STATUS:", r.status, (await r.text()).slice(0, 300));
process.exit(0);
