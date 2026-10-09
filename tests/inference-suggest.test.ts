import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { buildApp, ensureOptionals, hydrateFromDisk, __clearMemory } from "../apps/api/src/index.js";
import { createSessionToken } from "../packages/security/src/index.js";

// Inference suggestion endpoint: advisory action proposals from the
// inference plane with honest degraded/model reporting and explicit
// fallbacks. A stub inference server stands in for ml/inference/server.py.

let base = "";
let srv: Server | null = null;
let inferSrv: Server | null = null;
let inferBase = "";
let inferBehavior: "ok" | "http500" | "noaction" | "slow" | "auth" | "degraded" = "ok";
let lastInferHeaders: Record<string, string | string[] | undefined> = {};
let lastInferBody: Record<string, unknown> | null = null;
const MASTER = "test-suggest-master-xyz";
const SECRET = "test-suggest-hmac-abc";

async function api(method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { Authorization: `Bearer ${MASTER}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), "evex-suggest-"));
  process.env["DATA_DIR"] = dir;
  process.env["EVEX_AUTH_TOKEN"] = MASTER;
  process.env["EVEX_TOKEN_SECRET"] = SECRET;
  process.env["VM_BACKEND"] = "dev-framebuffer";
  process.env["EVEX_MAX_VMS_PER_TENANT"] = "64";
  process.env["EVEX_MAX_TOTAL_VMS"] = "512";
  process.env["EVEX_MAX_CPU_PER_TENANT"] = "256";
  process.env["EVEX_MAX_MEM_MB_PER_TENANT"] = "524288";
  // Stub inference plane: behavior scripted per test.
  inferSrv = createServer((req, res) => {
    if (req.url === "/ready" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ready: true, degraded: false, detail: "stub" }));
      return;
    }
    if (req.url === "/model-info" && req.method === "GET") {      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        model_id: "stub-weights-1", model_version: "7",
        model_sha256: "ab".repeat(32), architecture: "stub-arch",
        device: "cpu", degraded: false,
      }));
      return;
    }
    if (req.url !== "/infer" || req.method !== "POST") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end("{}");
      return;
    }
    lastInferHeaders = { ...(req.headers as Record<string, string | string[] | undefined>) };
    let text = "";
    req.on("data", (c) => { text += String(c); });
    req.on("end", () => {
      lastInferBody = JSON.parse(text) as Record<string, unknown>;
      const send = (code: number, obj: unknown) => {
        res.writeHead(code, { "Content-Type": "application/json" });
        res.end(JSON.stringify(obj));
      };
      if (inferBehavior === "http500") { send(500, { error: "boom" }); return; }
      if (inferBehavior === "auth") { send(401, { error: "unauthorized" }); return; }
      if (inferBehavior === "noaction") { send(200, { model_id: "x" }); return; }
      if (inferBehavior === "slow") return; // never reply: client must time out
      if (inferBehavior === "degraded") {
        send(200, {
          action: { type: "move", to: { x: 640, y: 400 }, confidence: 0.2, intent: "recenter" },
          action_source: "heuristic-v1", model_id: "heuristic-v1", model_version: "0",
          model_sha256: null, architecture: null, device: "cpu",
          latency_ms: 1.1, degraded: true, weights_verified: false,
        });
        return;
      }
      send(200, {
        action: { type: "click", to: { x: 960, y: 540 }, confidence: 0.77, intent: "click taskbar" },
        model_id: "stub-weights-1", latency_ms: 3.5, degraded: false, frame_id: lastInferBody?.["frame_id"],
      });
    });
  });
  await new Promise<void>((r) => inferSrv!.listen(0, "127.0.0.1", r));
  inferBase = `http://127.0.0.1:${(inferSrv.address() as AddressInfo).port}`;
  process.env["INFERENCE_URL"] = inferBase;
  process.env["EVEX_INFERENCE_TIMEOUT_MS"] = "400";

  await ensureOptionals();
  __clearMemory();
  const app = buildApp();
  hydrateFromDisk();
  srv = createServer(app);
  await new Promise<void>((r) => srv!.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  void createSessionToken;
});

after(async () => {
  await new Promise<void>((r) => srv?.close(() => r()));
  await new Promise<void>((r) => inferSrv?.close(() => r()));
  delete process.env["INFERENCE_URL"];
  delete process.env["EVEX_INFERENCE_TIMEOUT_MS"];
});

async function createSession(): Promise<string> {
  const r = await api("POST", "/v1/sessions", { goal: "open the browser" });
  assert.equal(r.status, 201);
  return String(r.json["id"]);
}

describe("inference suggest", () => {
  it("returns the plane suggestion with model identity", async () => {
    inferBehavior = "ok";
    const sid = await createSession();
    const r = await api("POST", `/v1/computer/${sid}/suggest`);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const sug = r.json["suggestion"] as Record<string, unknown>;
    assert.equal(sug["type"], "click");
    assert.equal(r.json["model_id"], "stub-weights-1");
    assert.equal(r.json["degraded"], false);
    // The plane received goal + frame + regions (not blind).
    assert.ok(String(lastInferBody?.["goal"] ?? "").includes("browser"));
    assert.ok(typeof lastInferBody?.["frame_id"] === "string");
    assert.ok(Array.isArray(lastInferBody?.["regions"]));
  });

  it("404 on unknown session", async () => {
    const r = await api("POST", "/v1/computer/sess-nope/suggest");
    assert.equal(r.status, 404);
  });

  it("502 when inference errors, answers empty, times out, is down, or refuses auth", async () => {
    const sid = await createSession();
    inferBehavior = "http500";
    assert.equal((await api("POST", `/v1/computer/${sid}/suggest`)).status, 502);
    inferBehavior = "noaction";
    assert.equal((await api("POST", `/v1/computer/${sid}/suggest`)).status, 502);
    inferBehavior = "auth";
    assert.equal((await api("POST", `/v1/computer/${sid}/suggest`)).status, 502);
    inferBehavior = "slow";
    assert.equal((await api("POST", `/v1/computer/${sid}/suggest`)).status, 502);
    inferBehavior = "ok";
    process.env["INFERENCE_URL"] = "http://127.0.0.1:9";
    assert.equal((await api("POST", `/v1/computer/${sid}/suggest`)).status, 502);
    process.env["INFERENCE_URL"] = inferBase;
  });

  it("degraded heuristic answers pass through labeled (never upgraded)", async () => {
    inferBehavior = "degraded";
    const sid = await createSession();
    const r = await api("POST", `/v1/computer/${sid}/suggest`);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json["model_id"], "heuristic-v1");
    assert.equal(r.json["degraded"], true);
    assert.equal(r.json["model_sha256"], null);
  });

  it("forwards the inference bearer token when configured", async () => {
    inferBehavior = "ok";
    process.env["EVEX_INFERENCE_TOKEN"] = "plane-secret-xyz";
    try {
      const sid = await createSession();
      const r = await api("POST", `/v1/computer/${sid}/suggest`);
      assert.equal(r.status, 200, JSON.stringify(r.json));
      assert.equal(lastInferHeaders["authorization"], "Bearer plane-secret-xyz");
    } finally {
      delete process.env["EVEX_INFERENCE_TOKEN"];
    }
  });

  it("suggestion never advances the trajectory", async () => {
    inferBehavior = "ok";
    const sid = await createSession();
    const before = await api("GET", `/v1/trace/${sid}`);
    await api("POST", `/v1/computer/${sid}/suggest`);
    const after = await api("GET", `/v1/trace/${sid}`);
    assert.deepEqual((after.json["steps"] as unknown[]).length, (before.json["steps"] as unknown[]).length);
  });

  it("model pin mismatch treats plane identity as unknown", async () => {
    const prev = process.env["EVEX_EXPECTED_MODEL_SHA256"];
    try {
      process.env["EVEX_EXPECTED_MODEL_SHA256"] = "ff".repeat(32);
      const r = await api("GET", "/v1/models/status");
      assert.equal(r.status, 200);
      assert.equal(r.json["modelIdentity"], null, "mismatched pin must not flow into provenance");
      process.env["EVEX_EXPECTED_MODEL_SHA256"] = "ab".repeat(32);
      const r2 = await api("GET", "/v1/models/status");
      assert.equal((r2.json["modelIdentity"] as Record<string, unknown> | null)?.["model_id"], "stub-weights-1");
    } finally {
      if (prev === undefined) delete process.env["EVEX_EXPECTED_MODEL_SHA256"];
      else process.env["EVEX_EXPECTED_MODEL_SHA256"] = prev;
    }
  });
});
