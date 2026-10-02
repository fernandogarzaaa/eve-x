import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "evex-load-"));
const { buildApp } = await import("../../dist/apps/api/src/index.js");
import { createServer } from "node:http";
const app = buildApp();
const srv = createServer(app);
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${srv.address().port}`;
const tenants = ["t1", "t2", "t3", "t4", "t5"];
// NOTE: dev-mode operator context is single-tenant; rate limiter keys on
// tenant, so this measures single-bucket throughput honestly.
const H = { "Content-Type": "application/json" };
const t0 = Date.now();
let ok = 0, limited = 0, other = 0;
const lat = [];
const jobs = [];
for (let i = 0; i < 50; i++) {
  jobs.push((async () => {
    const s = Date.now();
    try {
      const r = await fetch(`${base}/v1/sessions`, { method: "POST", headers: H, body: JSON.stringify({ goal: `load probe ${i}` }) });
      lat.push(Date.now() - s);
      if (r.status === 201) {
        ok++;
        const j = await r.json();
        const o = await fetch(`${base}/v1/computer/${j.id}/observe`, { headers: H });
        if (o.status !== 200) other++;
      } else if (r.status === 429) limited++;
      else other++;
    } catch { other++; }
  })());
}
await Promise.all(jobs);
lat.sort((a, b) => a - b);
const mem = process.memoryUsage();
console.log(JSON.stringify({
  sessions_ok: ok, rate_limited_429: limited, other_errors: other,
  ms_total: Date.now() - t0,
  latency_ms: { p50: lat[Math.floor(lat.length / 2)], p95: lat[Math.floor(lat.length * 0.95)], max: lat[lat.length - 1] },
  rss_mb: Math.round(mem.rss / 1048576), heap_mb: Math.round(mem.heapUsed / 1048576),
}, null, 1));
srv.close();
process.exit(0);
