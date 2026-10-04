#!/usr/bin/env node
// Capture two API frames 60s apart; compare bytes to tell frozen vs alive.
const API = "http://127.0.0.1:8080";
const H = { Authorization: "Bearer " + (process.env.EVEX_AUTH_TOKEN ?? "") };
const SID = "sess-d054467c";
import { createHash } from "node:crypto";
async function frame() {
  const r = await fetch(`${API}/v1/computer/${SID}/observe`, { headers: H });
  const j = await r.json();
  const b = Buffer.from(j.pngBase64, "base64");
  return { w: j.width, h: j.height, sha: createHash("sha256").update(b).digest("hex").slice(0, 16), len: b.length };
}
const a = await frame();
console.log("A:", JSON.stringify(a));
await new Promise((r) => setTimeout(r, 60000));
const b = await frame();
console.log("B:", JSON.stringify(b));
console.log(a.sha === b.sha ? "FROZEN" : "ALIVE");
process.exit(0);
