#!/usr/bin/env node
const API = "http://127.0.0.1:8080";
const H = { Authorization: "Bearer qual-canonical-token-0123456789abcdef" };
const r = await fetch(`${API}/v1/vms/vm-397e84fd/audit`, { headers: H });
console.log("STATUS:", r.status);
const j = await r.json();
for (const e of (j.audit ?? []).slice(-14)) console.log(e.at.slice(11, 19), e.op, "::", String(e.detail).slice(0, 110));
process.exit(0);
