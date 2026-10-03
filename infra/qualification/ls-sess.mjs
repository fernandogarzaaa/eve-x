#!/usr/bin/env node
const API = "http://127.0.0.1:8080";
const H = { Authorization: "Bearer qual-canonical-token-0123456789abcdef" };
const r = await fetch(API + "/v1/sessions", { headers: H });
const j = await r.json();
for (const s of j.sessions ?? []) {
  console.log(s.id, s.vmId, s.status, s.createdAt);
}
process.exit(0);
