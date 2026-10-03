import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { evaluateProduction } from "../packages/security/src/index.js";

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
});
