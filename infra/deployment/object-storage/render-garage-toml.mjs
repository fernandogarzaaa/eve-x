#!/usr/bin/env node
// Render a fresh garage.toml for virgin deployments (never commit output).
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const dir = dirname(fileURLToPath(import.meta.url));
const hex = (n) => execSync(`python -c "import secrets; print(secrets.token_hex(${n}))"`, { encoding: "utf8" }).trim();
const tpl = readFileSync(join(dir, "garage.toml.template"), "utf8");
const out = tpl
  .replaceAll("${GARAGE_RPC_SECRET}", process.env.GARAGE_RPC_SECRET ?? hex(32))
  .replaceAll("${GARAGE_ADMIN_TOKEN}", process.env.GARAGE_ADMIN_TOKEN ?? hex(32));
const dst = join(dir, "garage.toml");
writeFileSync(dst, out);
chmodSync(dst, 0o600);
console.log(`rendered ${dst} (600, gitignored)`);
