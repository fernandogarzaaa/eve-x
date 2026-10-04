#!/usr/bin/env node
const API = "http://127.0.0.1:8080";
const H = { Authorization: "Bearer " + (process.env.EVEX_AUTH_TOKEN ?? "") };
const SID = process.argv[2];
for (let i = 0; i < 3; i++) {
  const r = await fetch(`${API}/v1/computer/${SID}/observe`, { headers: H });
  const j = await r.json();
  console.log(`${j.width}x${j.height} regions=${(j.regions ?? []).length} synthetic=${j.synthetic}`);
  await new Promise((r2) => setTimeout(r2, 45000));
}
