#!/usr/bin/env node
// Watch a session boot: observe every 20s, print dims + stalled flag.
const API = "http://127.0.0.1:8080";
const H = { Authorization: "Bearer qual-canonical-token-0123456789abcdef" };
const SID = process.argv[2];
const N = Number(process.argv[3] ?? 25);
for (let i = 0; i < N; i++) {
  try {
    const r = await fetch(`${API}/v1/computer/${SID}/observe`, { headers: H });
    const j = await r.json();
    console.log(`t=${i * 20}s status=${r.status} ${j.width}x${j.height} stalled=${j.stalled} frame=${String(j.frameId).slice(0, 18)}`);
    if (j.width === 1280 && j.height === 800) {
      console.log("DESKTOP-READY");
      break;
    }
  } catch (e) {
    console.log(`t=${i * 20}s ERR ${String(e?.message ?? e).slice(0, 80)}`);
  }
  await new Promise((r2) => setTimeout(r2, 20000));
}
process.exit(0);
