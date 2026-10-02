import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hmacSign, verifyHmac } from "../packages/guest/src/index.js";
import { createSessionToken, verifyToken } from "../packages/security/src/index.js";

// §22 clock-skew qualification: simulated offsets (no real clock changes).
// Boundaries: HMAC ±60s window, worker lease TTL 20s, session-token TTL.

const SECRET = "test-clock-skew-secret-0123456789abcdef";

function signedAt(whenMs: number): { ts: string; sig: string } {
  const ts = String(whenMs);
  return { ts, sig: hmacSign(SECRET, "GET", "/screenshot", "", ts) };
}

describe("HMAC timestamp skew window (60s)", () => {
  for (const skew of [+10_000, +30_000, +59_000, -10_000, -30_000, -59_000]) {
    it(`accepts ${skew / 1000}s skew`, () => {
      const { ts, sig } = signedAt(Date.now() + skew);
      assert.equal(verifyHmac(SECRET, "GET", "/screenshot", "", ts, sig), true);
    });
  }
  for (const skew of [+61_000, +300_000, -61_000, -300_000]) {
    it(`rejects ${skew / 1000}s skew`, () => {
      const { ts, sig } = signedAt(Date.now() + skew);
      assert.equal(verifyHmac(SECRET, "GET", "/screenshot", "", ts, sig), false);
    });
  }
  it("rejects non-numeric timestamps", () => {
    assert.equal(verifyHmac(SECRET, "GET", "/screenshot", "", "not-a-time", "x".repeat(64)), false);
  });
  it("rejects wrong secret even with fresh timestamp", () => {
    const { ts } = signedAt(Date.now());
    assert.equal(verifyHmac("wrong-secret-00000000000000000000", "GET", "/screenshot", "", ts, hmacSign(SECRET, "GET", "/screenshot", "", ts)), false);
  });
});

describe("session token expiry boundaries", () => {
  it("rejects expired tokens and honors live ones", async () => {
    const dir = mkdtempSync(join(tmpdir(), "evex-clock-"));
    process.env["DATA_DIR"] = dir;
    const live = createSessionToken({ user: "u1", role: "viewer", ttlMs: 60_000 });
    assert.ok(verifyToken(live.token), "fresh token must verify");
    const dead = createSessionToken({ user: "u2", role: "viewer", ttlMs: 1 });
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(verifyToken(dead.token), null, "expired token must not verify");
  });
});

describe("lease TTL boundaries (20s worker lease)", () => {
  it("models live vs stale leases at the boundary", () => {
    // Mirrors the worker lease-liveness predicate with simulated clocks.
    const live = (atMs: number, ttlMs: number, nowMs: number): boolean => nowMs - atMs < ttlMs;
    const now = Date.now();
    assert.equal(live(now - 19_000, 20_000, now), true);
    assert.equal(live(now - 20_001, 20_000, now), false);
  });

  it("epoch fencing survives clock disagreement (split-brain abort)", async () => {
    const worker = await import("../apps/worker/src/index.js");
    const dir = mkdtempSync(join(tmpdir(), "evex-epoch-"));
    process.env["DATA_DIR"] = dir;
    const sid = "sess-epoch-1";
    assert.equal(worker.tryAcquire(sid), true);
    const mine = worker.heldEpoch(sid);
    assert.ok(typeof mine === "number");
    // Rival takeover bumps the epoch even though OUR clock still calls the
    // original lease live: simulate by rewriting the file as a rival would.
    const { readFileSync, writeFileSync } = await import("node:fs");
    const cur = JSON.parse(readFileSync(worker.leasePath(sid), "utf8"));
    writeFileSync(
      worker.leasePath(sid),
      JSON.stringify({ ...cur, worker: "worker-RIVAL", at: new Date().toISOString(), epoch: mine + 1 }),
    );
    assert.equal(worker.heldEpoch(sid), null, "rival epoch must void our hold");
    // A run started under the old epoch aborts instead of double-writing.
    const r = worker.runSessionToCompletion({ id: sid, goal: "g", status: "RUNNING", maxSteps: 3 });
    assert.equal(r.outcome, "LEASE_LOST");
    assert.equal(r.steps, 0);
  });
});

describe("trace ordering is skew-independent", () => {
  it("replay verification keys on seq, not wall-clock", async () => {
    const { verifyReplay } = await import("../apps/api/src/index.js");
    const steps = [2, 1, 0].map((seq) => ({
      session_id: "s", task_id: "t", step_id: `step-${seq}`, seq,
      // Wildly out-of-order wall-clock timestamps must not matter.
      timestamp: new Date(Date.now() + (seq === 0 ? 3600_000 : -3600_000)).toISOString(),
      actor: "eve-agent", vm_state_before: "RUNNING", screen_before: `f-${seq}`,
      goal: "g", candidate_actions: [],
      provenance: { source: "system", channel: "t", at: new Date().toISOString() },
      model_version: "evex-1", environment_version: "ubuntu-desktop-v1",
    }));
    const r = verifyReplay(steps);
    assert.equal(r.verdict, "replay-divergent", "out-of-order seq must diverge regardless of timestamps");
  });
});
