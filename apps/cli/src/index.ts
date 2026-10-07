#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync, readFileSync, accessSync, constants as fsConstants } from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createConnection } from "node:net";
import { totalmem } from "node:os";

// ── eve-x CLI: init/doctor/vm/session/benchmark/report/model/dataset/server ──
// Deps: node builtins only (+ fetch global). Talks to the API over HTTP.

import { evaluateProduction } from "../../../packages/security/src/index.js";
import { releaseIdentity, assertReleaseCommit } from "../../../packages/core/src/index.js";

const VERSION = "1.1.0";
const ROOT = process.cwd();

function apiBase(): string {
  return (process.env["EVEX_API_URL"] ?? "http://localhost:8080").replace(/\/$/, "");
}
function token(): string {
  return process.env["EVEX_AUTH_TOKEN"] ?? "";
}
function headers(): Record<string, string> {
  return { "Content-Type": "application/json", ...(token() ? { Authorization: `Bearer ${token()}` } : {}) };
}

async function api<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const res = await fetch(apiBase() + path, {
    method,
    headers: headers(),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 500)}`);
  return (text ? JSON.parse(text) : {}) as T;
}

function out(msg: string): void {
  process.stdout.write(msg + "\n");
}
function usage(): void {
  out(`eve-x ${VERSION} — isolated-VM computer-use experience validation
Usage: eve-x <command> [args]

  init [--dir <path>]              scaffold data dirs + .env
  doctor                           check node/qemu/docker/images/storage/network/ports/permissions
  doctor --production              hard production-safety gate (auth/services/quotas/TLS)
  vm create [--image N] [--cpu N]   create a VM
  vm status <id> | rm <id>          vm status / destroy
  session create --goal "..."       create session
  session status <id> | stop <id>   session ops
  benchmark run [--size N]          run benchmark suite
  report <sessionId>                print session report
  model status                      inference backend status
  dataset ls | trace <sessionId>    dataset / trace helpers
  server [--port N]                 start API (delegates to dist/apps/api)
  console [--port N]                start console (delegates to dist/apps/console)
  worker                            start worker (delegates to dist/apps/worker)
  mcp [http]                        start MCP server (stdio default)
`);
}

function flag(args: string[], name: string, dflt = ""): string {
  const i = args.indexOf(name);
  if (i >= 0 && i + 1 < args.length) return args[i + 1] as string;
  const pref = args.find((a) => a.startsWith(name + "="));
  if (pref) return pref.slice(name.length + 1);
  return dflt;
}

// ── doctor ──
interface Check { name: string; ok: boolean; detail: string; fix: string }

function which(bin: string): string {
  try {
    const r = spawnSync(process.platform === "win32" ? "where" : "which", [bin], { encoding: "utf8" });
    return r.status === 0 ? String(r.stdout).split("\n")[0]?.trim() ?? "" : "";
  } catch {
    return "";
  }
}

function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createConnection({ host: "127.0.0.1", port }, () => {
      s.destroy();
      resolve(false);
    });
    s.on("error", () => resolve(true));
    s.setTimeout(800, () => {
      s.destroy();
      resolve(true);
    });
  });
}

async function doctor(): Promise<number> {
  const id = releaseIdentity();
  out(`eve-x ${id.release} · built ${id.buildTime} · digest ${String(id.sourceDigest).slice(0, 16)}${id.dirty ? " · DIRTY (dev build, not releasable)" : ""}`);
  const checks: Check[] = [];
  const major = Number(process.versions.node.split(".")[0] ?? 0);
  checks.push({
    name: "node>=20", ok: major >= 20, detail: `node ${process.version}`,
    fix: major >= 20 ? "" : "Install Node.js 20+ from https://nodejs.org",
  });
  const qemu = which(process.env["QEMU_BIN"] ?? "qemu-system-x86_64") || which("qemu-system-x86_64") || which("qemu-img");
  checks.push({
    name: "qemu", ok: qemu !== "", detail: qemu || "qemu binary not on PATH",
    fix: qemu ? "" : "Install QEMU (apt: sudo apt install qemu-kvm / brew: brew install qemu / win: choco install qemu) or set QEMU_BIN",
  });
  const docker = which("docker");
  let dockerOk = false;
  let dockerDetail = docker || "docker not on PATH";
  if (docker) {
    try {
      execFileSync("docker", ["info"], { stdio: "ignore", timeout: 5000 });
      dockerOk = true;
      dockerDetail = "docker daemon reachable";
    } catch {
      dockerDetail = "docker present but daemon unreachable (start Docker Desktop)";
    }
  }
  checks.push({ name: "docker", ok: dockerOk, detail: dockerDetail, fix: dockerOk ? "" : "Install/start Docker Desktop; VM backend falls back to process isolation without it" });
  const dataDir = resolve(process.env["DATA_DIR"] ?? "./data");
  let storeOk = false;
  let storeDetail = dataDir;
  try {
    mkdirSync(dataDir, { recursive: true });
    const probe = join(dataDir, ".writetest");
    writeFileSync(probe, "ok");
    accessSync(probe, fsConstants.R_OK | fsConstants.W_OK);
    storeDetail = `writable (${dataDir})`;
    storeOk = true;
  } catch (err) {
    storeDetail = `not writable: ${err instanceof Error ? err.message : String(err)}`;
  }
  checks.push({ name: "storage", ok: storeOk, detail: storeDetail, fix: storeOk ? "" : `mkdir -p ${dataDir} && chmod u+rw ${dataDir}` });
  // network: API reachability (non-fatal)
  let netOk = true;
  let netDetail = "loopback ok";
  try {
    const res = await fetch(apiBase() + "/health", { signal: AbortSignal.timeout(2500) });
    netDetail = res.ok ? `API reachable at ${apiBase()}` : `API responded ${res.status} at ${apiBase()}`;
    netOk = res.ok;
  } catch {
    netDetail = `API not reachable at ${apiBase()} (start with: eve-x server)`;
    netOk = false;
  }
  checks.push({ name: "network/api", ok: netOk, detail: netDetail, fix: netOk ? "" : "Run `eve-x server` or set EVEX_API_URL" });
  for (const p of [8080, 8091, 3000]) {
    const free = await portFree(p);
    checks.push({
      name: `port :${p}`, ok: free, detail: free ? "free" : "in use",
      fix: free ? "" : `Port ${p} busy — set PORT/MCP_PORT/CONSOLE_PORT or stop the holder`,
    });
  }
  const canWrite = (() => {
    try {
      accessSync(ROOT, fsConstants.W_OK);
      return true;
    } catch {
      return false;
    }
  })();
  checks.push({ name: "permissions", ok: canWrite, detail: canWrite ? `cwd writable (${ROOT})` : `cwd not writable (${ROOT})`, fix: canWrite ? "" : "Run from a writable directory" });
  // images
  const imgDir = resolve(process.env["EVEX_IMAGES"] ?? "./images");
  const hasImg = existsSync(imgDir) && existsSync(join(imgDir, "ubuntu-desktop-v1.qcow2"));
  checks.push({
    name: "images", ok: hasImg,
    detail: hasImg ? `base image present (${imgDir})` : `no base image staged (${imgDir}/ubuntu-desktop-v1.qcow2) — real guests cannot boot; only the synthetic backend serves`,
    fix: hasImg ? "" : "Stage a sealed base image (infra/vm-images/build.sh) or set EVEX_IMAGES",
  });

  let fail = 0;
  for (const c of checks) {
    const mark = c.name.startsWith("port") || c.name === "images" || c.name === "network/api"
      ? (c.ok ? "PASS" : "WARN")
      : (c.ok ? "PASS" : "FAIL");
    if (mark === "FAIL") fail += 1;
    out(`[${mark}] ${c.name}: ${c.detail}${c.fix ? ` → fix: ${c.fix}` : ""}`);
  }
  if (process.env["EVEX_AUTH_TOKEN"]) out("[PASS] auth: EVEX_AUTH_TOKEN set");
  else out("[WARN] auth: EVEX_AUTH_TOKEN unset (dev mode; set it for any shared host)");
  if (fail > 0) {
    out(`doctor: ${fail} hard failure(s)`);
    return 1;
  }
  out("doctor: ok (warnings are non-blocking)");
  return 0;
}

// ── doctor --production: hard production-safety gate (§21) ──

function probeTcp(host: string, port: number, timeoutMs = 2500): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let done = false;
    const finish = (ok: boolean): void => {
      if (done) return;
      done = true;
      resolve(ok);
    };
    const timer = setTimeout(() => {
      try { s.destroy(); } catch { /* ignore */ }
      finish(false);
    }, timeoutMs);
    let s: { destroy: () => void; on: (ev: string, fn: () => void) => void };
    try {
      s = createConnection({ host, port });
    } catch {
      clearTimeout(timer);
      finish(false);
      return;
    }
    s.on("connect", () => {
      clearTimeout(timer);
      try { s.destroy(); } catch { /* ignore */ }
      finish(true);
    });
    s.on("error", () => {
      clearTimeout(timer);
      finish(false);
    });
  });
}

function hostPort(url: string, dflt: number): { host: string; port: number } | null {
  try {
    const u = new URL(url.includes("://") ? url : `tcp://${url}`);
    const port = u.port ? Number(u.port) : dflt;
    if (!u.hostname || !Number.isInteger(port)) return null;
    return { host: u.hostname, port };
  } catch {
    return null;
  }
}

async function doctorProduction(): Promise<number> {
  const id = releaseIdentity();
  out(`eve-x ${id.release} · built ${id.buildTime} · digest ${String(id.sourceDigest).slice(0, 16)}${id.dirty ? " · DIRTY (dev build, not releasable)" : ""}`);
  // Release/commit gate: a production doctor against the wrong build fails
  // closed instead of blessing a mismatched deployment (§21).
  try {
    assertReleaseCommit();
  } catch (err) {
    out(`[FAIL] release-commit: ${err instanceof Error ? err.message : String(err)}`);
    out("production: blocked");
    return 1;
  }
  if (id.dirty) {
    out("[FAIL] release-cleanliness: dirty build must never gate production");
    out("production: blocked");
    return 1;
  }
  const requireServices = (process.env["EVEX_REQUIRE_SERVICES"] ?? "")
    .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)
    .map((s) => (s === "minio" || s === "s3" || s === "garage" ? "object" : s));
  const serviceStatus: Record<string, { reachable: boolean; detail: string }> = {};
  const dbUrl = process.env["DATABASE_URL"] ?? "";
  if (dbUrl) {
    const hp = hostPort(dbUrl, 5432);
    const ok = hp ? await probeTcp(hp.host, hp.port) : false;
    serviceStatus["postgres"] = { reachable: ok, detail: ok ? `tcp-reachable ${dbUrl.split("@")[1] ?? dbUrl}` : "unreachable" };
  }
  const redisUrl = process.env["REDIS_URL"] ?? "";
  if (redisUrl) {
    const hp = hostPort(redisUrl, 6379);
    const ok = hp ? await probeTcp(hp.host, hp.port) : false;
    serviceStatus["redis"] = { reachable: ok, detail: ok ? "tcp-reachable" : "unreachable" };
  }
  const objUrl = process.env["OBJECT_ENDPOINT"] ?? "";
  if (objUrl) {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 4000);
      const res = await fetch(objUrl, { method: "HEAD", signal: ctl.signal });
      clearTimeout(t);
      void res;
      serviceStatus["object"] = { reachable: true, detail: `http-reachable ${objUrl}` };
    } catch (err) {
      serviceStatus["object"] = { reachable: false, detail: `unreachable: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
  const maxSessions = process.env["EVEX_MAX_SESSIONS"] !== undefined ? Number(process.env["EVEX_MAX_SESSIONS"]) : undefined;
  const { verdict, findings } = evaluateProduction({
    authToken: process.env["EVEX_AUTH_TOKEN"] ?? "",
    corsOrigins: process.env["EVEX_CORS_ORIGINS"] ?? "",
    requireServices,
    serviceStatus,
    maxSessions,
    vmBackend: process.env["VM_BACKEND"],
    publicUrl: process.env["EVEX_PUBLIC_URL"],
    objectEndpoint: objUrl,
    mode: "production",
    filePrimaryAck: (process.env["EVEX_FILE_PRIMARY_ACK"] ?? "") === "1",
  });
  for (const f of findings) {
    out(`[${f.status.toUpperCase()}] ${f.name}: ${f.detail}`);
  }
  // Host capacity sanity: quotas that exceed physical RAM guarantee OOM
  // wedges (observed live: two 4 GB desktop guests on a 9.6 GB host froze
  // boot with no error surfaced). This is advisory; the scheduler owns quota.
  const ramMb = Math.floor(totalmem() / 1048576);
  const perTenantMb = process.env["EVEX_MAX_MEM_MB_PER_TENANT"] !== undefined ? Number(process.env["EVEX_MAX_MEM_MB_PER_TENANT"]) : 32768;
  const totalVms = process.env["EVEX_MAX_TOTAL_VMS"] !== undefined ? Number(process.env["EVEX_MAX_TOTAL_VMS"]) : 32;
  out(`[INFO] host RAM: ${ramMb} MB`);
  if (Number.isFinite(perTenantMb) && Number.isFinite(totalVms) && totalVms * 2048 > ramMb) {
    out(`[WARN] capacity: EVEX_MAX_TOTAL_VMS=${totalVms} at ~2 GB/guest oversubscribes ${ramMb} MB RAM — size quotas to the host or expect OOM wedges`);
  }
  if (ramMb < 16384) {
    out(`[WARN] capacity: ${ramMb} MB RAM is below the 16 GB recommended workstation profile for graphical KVM guests`);
  }
  out(`production: ${verdict}`);
  return verdict === "production-safe" ? 0 : 1;
}

async function main(): Promise<number> {
  const [, , cmd, sub, ...rest] = process.argv;
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    usage();
    return 0;
  }
  if (cmd === "--version" || cmd === "-V") {
    out(VERSION);
    return 0;
  }
  if (cmd === "version") {
    // Full release identity: never just "1.0.0" when commit is knowable (§3).
    out(JSON.stringify(releaseIdentity(), null, 2));
    return 0;
  }
  try {
    switch (cmd) {
      case "init": {
        const dir = resolve(flag(rest, "--dir", "."));
        mkdirSync(join(dir, "data", "objects"), { recursive: true });
        mkdirSync(join(dir, "images"), { recursive: true });
        const envPath = join(dir, ".env");
        if (!existsSync(envPath)) {
          // Generated credentials, never weak stand-ins: a fresh random
          // bearer token is minted per init. Production still requires
          // explicit review (see doctor --production).
          const fresh = randomBytes(32).toString("hex");
          let tpl = `PORT=8080\nEVEX_AUTH_TOKEN=${fresh}\nDATA_DIR=./data\n`;
          try {
            const example = readFileSync(join(ROOT, ".env.example"), "utf8");
            tpl = example.replace(/^EVEX_AUTH_TOKEN=.*$/m, `EVEX_AUTH_TOKEN=${fresh}`);
          } catch { /* keep generated template */ }
          writeFileSync(envPath, tpl, "utf8");
        }
        out(`initialized at ${dir}`);
        return 0;
      }
      case "doctor":
        if (sub === "--production" || rest.includes("--production")) return await doctorProduction();
        return await doctor();
      case "vm": {
        if (sub === "create") {
          const r = await api<Record<string, unknown>>("/v1/vms", "POST", {
            image: flag(rest, "--image", "ubuntu-desktop-v1"),
            cpu: Number(flag(rest, "--cpu", "4")),
          });
          out(JSON.stringify(r, null, 2));
          return 0;
        }
        if (sub === "status") {
          const r = await api(`/v1/vms/${rest[0]}/status`);
          out(JSON.stringify(r, null, 2));
          return 0;
        }
        if (sub === "rm" || sub === "destroy") {
          const r = await api(`/v1/vms/${rest[0]}`, "DELETE");
          out(JSON.stringify(r, null, 2));
          return 0;
        }
        usage();
        return 2;
      }
      case "session": {
        if (sub === "create") {
          const goal = flag(rest, "--goal", rest.join(" ") || "open the browser");
          const r = await api<Record<string, unknown>>("/v1/sessions", "POST", { goal });
          out(JSON.stringify(r, null, 2));
          return 0;
        }
        if (sub === "status") {
          out(JSON.stringify(await api(`/v1/sessions/${rest[0]}`), null, 2));
          return 0;
        }
        if (sub === "stop") {
          out(JSON.stringify(await api(`/v1/sessions/${rest[0]}/stop`, "POST", {}), null, 2));
          return 0;
        }
        usage();
        return 2;
      }
      case "benchmark": {
        const size = Number(flag(rest, "--size", "6"));
        const r = await api<Record<string, unknown>>("/v1/benchmarks", "POST", { size });
        out(JSON.stringify(r, null, 2));
        return 0;
      }
      case "report": {
        out(JSON.stringify(await api(`/v1/report/${sub}`), null, 2));
        return 0;
      }
      case "model": {
        out(JSON.stringify(await api("/v1/models/status"), null, 2));
        return 0;
      }
      case "dataset": {
        if (sub === "ls") {
          out(JSON.stringify(await api("/v1/sessions"), null, 2));
          return 0;
        }
        if (sub === "trace") {
          out(JSON.stringify(await api(`/v1/trace/${rest[0]}`), null, 2));
          return 0;
        }
        usage();
        return 2;
      }
      case "server":
      case "console":
      case "worker":
      case "mcp": {
        out(`use: npm run ${cmd} (dist bundle) — see package.json scripts`);
        return 0;
      }
      default:
        usage();
        return 2;
    }
  } catch (err) {
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

main().then((code) => process.exit(code));
