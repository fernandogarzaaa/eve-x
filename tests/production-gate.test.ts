import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { evaluateProduction, authFromHeaders, executionMode } from "../packages/security/src/index.js";
import { startApi } from "../apps/api/src/index.js";

const reachable = (detail = "ok"): { reachable: boolean; detail: string } => ({ reachable: true, detail });
const down = (detail = "refused"): { reachable: boolean; detail: string } => ({ reachable: false, detail });

describe("production configuration gate", () => {
  it("fails dev auth (unset, default, short)", () => {
    for (const t of ["", "change-me", "test", "short"]) {
      const r = evaluateProduction({
        authToken: t, corsOrigins: "", requireServices: [], serviceStatus: {},
      });
      assert.equal(r.verdict, "development-only", `token ${JSON.stringify(t)} must fail`);
      assert.ok(r.findings.some((f) => f.name === "auth" && f.status === "fail"));
    }
  });

  it("fails unreachable required services, passes reachable ones", () => {
    const bad = evaluateProduction({
      authToken: "a-very-long-production-token-0123456789",
      corsOrigins: "https://console.example.com",
      requireServices: ["postgres", "redis", "object"],
      serviceStatus: { postgres: reachable(), redis: down(), object: reachable() },
      maxSessions: 64, publicUrl: "https://evex.example.com",
    });
    assert.equal(bad.verdict, "development-only");
    assert.ok(bad.findings.some((f) => f.name === "service:redis" && f.status === "fail"));

    const good = evaluateProduction({
      authToken: "a-very-long-production-token-0123456789",
      corsOrigins: "https://console.example.com",
      requireServices: ["postgres", "redis", "object"],
      serviceStatus: { postgres: reachable(), redis: reachable(), object: reachable() },
      maxSessions: 64, publicUrl: "https://evex.example.com",
    });
    assert.equal(good.verdict, "production-safe");
  });

  it("flags wildcard CORS and unbounded sessions without failing safe configs", () => {
    const r = evaluateProduction({
      authToken: "a-very-long-production-token-0123456789",
      corsOrigins: "https://a.example.com",
      requireServices: [], serviceStatus: {},
    });
    assert.equal(r.verdict, "production-safe", "warns must not fail the verdict");
    assert.ok(r.findings.some((f) => f.status === "warn"));

    const wild = evaluateProduction({
      authToken: "a-very-long-production-token-0123456789",
      corsOrigins: "*, https://a.example.com",
      requireServices: [], serviceStatus: {},
    });
    assert.ok(wild.findings.some((f) => f.name === "cors" && f.status === "warn"));
  });

  it("fails HTTP-only non-local public endpoints and bad quotas", () => {
    const r = evaluateProduction({
      authToken: "a-very-long-production-token-0123456789",
      corsOrigins: "", requireServices: [], serviceStatus: {},
      maxSessions: 0, publicUrl: "http://evex.example.com",
    });
    assert.equal(r.verdict, "development-only");
    assert.ok(r.findings.some((f) => f.name === "tls" && f.status === "fail"));
    assert.ok(r.findings.some((f) => f.name === "quotas" && f.status === "fail"));
  });

  it("accepts loopback public URLs without TLS", () => {
    const r = evaluateProduction({
      authToken: "a-very-long-production-token-0123456789",
      corsOrigins: "", requireServices: [], serviceStatus: {},
      maxSessions: 8, publicUrl: "http://localhost:8080",
    });
    assert.ok(r.findings.some((f) => f.name === "tls" && f.status === "pass"));
  });

  it("production mode refuses auto/dev backends", () => {
    for (const backend of ["auto", "dev", "dev-framebuffer"]) {
      const r = evaluateProduction({
        authToken: "a-very-long-production-token-0123456789",
        corsOrigins: "https://a.example.com",
        requireServices: ["object"],
        serviceStatus: { object: { reachable: true, detail: "ok" } },
        maxSessions: 8, vmBackend: backend, mode: "production",
        filePrimaryAck: true,
      });
      assert.equal(r.verdict, "development-only", `backend ${backend} must fail in production`);
      assert.ok(r.findings.some((f) => f.name === "vm-backend" && f.status === "fail"));
    }
    const pinned = evaluateProduction({
      authToken: "a-very-long-production-token-0123456789",
      corsOrigins: "https://a.example.com",
      requireServices: ["object"],
      serviceStatus: { object: { reachable: true, detail: "ok" } },
      maxSessions: 8, vmBackend: "qemu", mode: "production",
      filePrimaryAck: true, publicUrl: "https://evex.example.com",
    });
    assert.equal(pinned.verdict, "production-safe");
  });

  it("production mode requires services or explicit file-primary ack", () => {
    const base = {
      authToken: "a-very-long-production-token-0123456789",
      corsOrigins: "https://a.example.com",
      requireServices: [] as string[],
      serviceStatus: {},
      maxSessions: 8, vmBackend: "qemu",
      publicUrl: "https://evex.example.com",
    };
    const unacked = evaluateProduction({ ...base, mode: "production" });
    assert.equal(unacked.verdict, "development-only");
    assert.ok(unacked.findings.some((f) => f.name === "services" && f.status === "fail"));
    const acked = evaluateProduction({ ...base, mode: "production", filePrimaryAck: true });
    assert.equal(acked.verdict, "production-safe");
    // Non-production keeps the advisory warn (existing ergonomics unchanged).
    const dev = evaluateProduction({ ...base });
    assert.equal(dev.verdict, "production-safe");
    assert.ok(dev.findings.some((f) => f.name === "services" && f.status === "warn"));
  });
});

describe("execution modes fail closed", () => {
  it("parses EVEX_MODE explicitly (no silent production)", () => {
    const prev = process.env["EVEX_MODE"];
    try {
      delete process.env["EVEX_MODE"];
      assert.equal(executionMode(), "development");
      process.env["EVEX_MODE"] = "production";
      assert.equal(executionMode(), "production");
      process.env["EVEX_MODE"] = "prod";
      assert.equal(executionMode(), "production");
      process.env["EVEX_MODE"] = "test";
      assert.equal(executionMode(), "test");
      process.env["EVEX_MODE"] = "ci";
      assert.equal(executionMode(), "test");
      process.env["EVEX_MODE"] = "weird";
      assert.equal(executionMode(), "development");
    } finally {
      if (prev === undefined) delete process.env["EVEX_MODE"];
      else process.env["EVEX_MODE"] = prev;
    }
  });

  it("dev-anon fallback exists only in development", () => {
    const prevMode = process.env["EVEX_MODE"];
    const prevToken = process.env["EVEX_AUTH_TOKEN"];
    try {
      delete process.env["EVEX_AUTH_TOKEN"];
      delete process.env["EVEX_MODE"];
      const dev = authFromHeaders({});
      assert.ok(dev !== null && dev.user === "dev-anon", "development keeps zero-config local dev");
      process.env["EVEX_MODE"] = "test";
      assert.equal(authFromHeaders({}), null, "test mode must not mint dev-anon");
      process.env["EVEX_MODE"] = "production";
      assert.equal(authFromHeaders({}), null, "production must fail closed with no token");
    } finally {
      if (prevMode === undefined) delete process.env["EVEX_MODE"];
      else process.env["EVEX_MODE"] = prevMode;
      if (prevToken === undefined) delete process.env["EVEX_AUTH_TOKEN"];
      else process.env["EVEX_AUTH_TOKEN"] = prevToken;
    }
  });

  it("startApi refuses production boot with weak config", async () => {
    const prevMode = process.env["EVEX_MODE"];
    const prevToken = process.env["EVEX_AUTH_TOKEN"];
    const prevBackend = process.env["VM_BACKEND"];
    try {
      process.env["EVEX_MODE"] = "production";
      delete process.env["EVEX_AUTH_TOKEN"];
      process.env["VM_BACKEND"] = "dev-framebuffer";
      await assert.rejects(startApi(0), /production startup refused/);
    } finally {
      if (prevMode === undefined) delete process.env["EVEX_MODE"];
      else process.env["EVEX_MODE"] = prevMode;
      if (prevToken === undefined) delete process.env["EVEX_AUTH_TOKEN"];
      else process.env["EVEX_AUTH_TOKEN"] = prevToken;
      if (prevBackend === undefined) delete process.env["VM_BACKEND"];
      else process.env["VM_BACKEND"] = prevBackend;
    }
  });

  it("linux boot script never defaults secrets (refuses without env)", async () => {
    const { readFileSync } = await import("node:fs");
    const { join, dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const { execFileSync } = await import("node:child_process");
    const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
    const script = join(root, "infra", "qualification", "start-linux-api.sh");
    const src = readFileSync(script, "utf8");
    assert.ok(!src.includes("qual-canonical-token"), "no canonical fallback token may remain");
    assert.ok(!src.includes("evex:evex-qual"), "no weak default DB credentials may remain");
    assert.ok(src.includes("refusing: EVEX_AUTH_TOKEN"), "must refuse without a token");
    // Execute with scrubbed secret env where bash exists: refusal must come
    // before ANY side effect (exit 1, no defaults used). /root/.evex-qual-token
    // does not exist in CI, so the refusal branch is deterministic.
    let hasBash = true;
    try {
      execFileSync("bash", ["--version"], { stdio: "pipe" });
    } catch {
      hasBash = false;
    }
    if (!hasBash) {
      assert.ok(true, "classified: no bash on this host; static assertions above carry the gate");
      return;
    }
    const cleanEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined && k !== "EVEX_AUTH_TOKEN" && k !== "DATABASE_URL") cleanEnv[k] = v;
    }
    let refused = false;
    let out = "";
    try {
      execFileSync("bash", [script], { stdio: "pipe", env: cleanEnv, timeout: 30000 });
    } catch (err) {
      refused = true;
      const e = err as { stdout?: Buffer; stderr?: Buffer };
      out = String(e.stdout ?? "") + String(e.stderr ?? "");
    }
    assert.equal(refused, true, "boot script without secret env must refuse");
    assert.match(out, /refusing: EVEX_AUTH_TOKEN/);
    // With dummy secrets + selftest hook: env validation passes and the
    // script exits before any side effect — proving refusal is env-driven.
    const ok = execFileSync("bash", [script], {
      stdio: "pipe",
      env: { ...cleanEnv, EVEX_AUTH_TOKEN: "test-token-0123456789abcdef", DATABASE_URL: "postgres://u:p@h/db", EVEX_BOOT_SELFTEST: "1" },
      timeout: 30000,
    });
    assert.match(String(ok), /selftest-ok/);
  });
});
