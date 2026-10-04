#!/usr/bin/env node
const API = "http://127.0.0.1:8080";
const H = { Authorization: "Bearer " + (process.env.EVEX_AUTH_TOKEN ?? "") };
const SID = process.argv[2];
const r = await fetch(`${API}/v1/computer/${SID}/observe`, { headers: H });
console.log("STATUS:", r.status);
const j = await r.json();
console.log(JSON.stringify(j).slice(0, 400));
process.exit(0);
