import { readFileSync } from "node:fs";
const ca = readFileSync("E:/eve-x/infra/deployment/tls/certs/evex.crt");
process.env.NODE_EXTRA_CA_CERTS = "E:/eve-x/infra/deployment/tls/certs/evex.crt";
const h = await fetch("https://localhost:8443/health", { dispatcher: undefined });
console.log("HTTPS-HEALTH:", h.status, JSON.stringify(await h.json()).slice(0, 80));
const { default: Ws } = await import("ws").catch(() => ({ default: null }));
if (Ws) {
  const ws = new Ws("wss://localhost:8443/v1/stream/sess-qual-tls", { ca, handshakeTimeout: 8000 });
  const t = setTimeout(() => { console.log("WSS-TIMEOUT"); process.exit(2); }, 12000);
  ws.on("message", (m) => { console.log("WSS-MSG:", String(m).slice(0, 120)); clearTimeout(t); ws.close(); });
  ws.on("error", (e) => { console.log("WSS-ERR:", e.message); clearTimeout(t); process.exit(1); });
  ws.on("close", () => { console.log("WSS-CLOSED"); process.exit(0); });
} else {
  console.log("WSS-SKIPPED (ws module path)");
}
