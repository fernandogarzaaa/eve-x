#!/usr/bin/env node
// Fetch the canonical session frame + decode + crude content analysis.
const API = "http://127.0.0.1:8080";
const H = { Authorization: "Bearer " + (process.env.EVEX_AUTH_TOKEN ?? "") };
const { analyzePng } = await import("/root/evex-prod/dist/packages/perception/src/index.js");
const r = await fetch(`${API}/v1/computer/sess-5bb0e520/observe`, { headers: H });
const j = await r.json();
const png = Buffer.from(j.pngBase64, "base64");
console.log(`frame ${j.width}x${j.height} bytes=${png.length} regions=${(j.regions ?? []).length}`);
console.log("region sample:", JSON.stringify((j.regions ?? []).slice(0, 3)).slice(0, 300));
try {
  const a = analyzePng(png, "qual");
  console.log("percept regions:", a.regions.length, "dialogs:", JSON.stringify(a.dialogs).slice(0, 120), "loading:", a.loading);
} catch (e) {
  console.log("analyze failed:", e.message);
}
const { writeFileSync } = await import("node:fs");
writeFileSync("/tmp/frozen-frame.png", png);
console.log("saved /tmp/frozen-frame.png");
process.exit(0);
