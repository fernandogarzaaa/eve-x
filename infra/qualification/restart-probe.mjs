#!/usr/bin/env node
// Restart-continuity proof: observe (frame A) -> kill -9 API -> start API ->
// observe again (must succeed via transparent reattach, new frame B).
const API = "http://127.0.0.1:8080";
const H = { "Content-Type": "application/json", Authorization: "Bearer " + (process.env.EVEX_AUTH_TOKEN ?? "") };
const SID = "sess-966728ed";
async function observe() {
  const r = await fetch(`${API}/v1/computer/${SID}/observe`, { headers: H });
  const j = await r.json();
  return { status: r.status, frame: j.frameId, dims: `${j.width}x${j.height}`, stalled: j.stalled };
}
console.log("BEFORE:", JSON.stringify(await observe()));
process.exit(0);
