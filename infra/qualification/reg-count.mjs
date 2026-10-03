import { readFileSync } from "node:fs";
const reg = JSON.parse(readFileSync("/root/evex-prod/data/vm-registry.json", "utf8"));
for (const [id, e] of Object.entries(reg.entries ?? {})) {
  console.log(id, "owner=" + e.owner, "backend=" + e.backend, "lease-exp=" + new Date(e.lease?.expiresAtMs).toISOString());
}
