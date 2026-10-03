#!/usr/bin/env node
const API = "http://127.0.0.1:8080";
const H = { Authorization: "Bearer qual-canonical-token-0123456789abcdef" };
const r = await fetch(`${API}/v1/vms/vm-5d02909a/audit`, { headers: H });
console.log("STATUS:", r.status);
const j = await r.json();
if (!j.audit) console.log("BODY:", JSON.stringify(j).slice(0, 300));
for (const e of j.audit ?? []) console.log(e.at, e.op, "::", String(e.detail).slice(0, 110));
process.exit(0);
