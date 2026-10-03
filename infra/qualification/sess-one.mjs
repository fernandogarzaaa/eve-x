#!/usr/bin/env node
const API = "http://127.0.0.1:8080";
const H = { Authorization: "Bearer qual-canonical-token-0123456789abcdef" };
const r = await fetch(API + "/v1/sessions/sess-6fe097b4", { headers: H });
const j = await r.json();
console.log(JSON.stringify({ id: j.id, vmId: j.vmId, status: j.status, seq: j.seq, steps: j.steps }));
process.exit(0);
