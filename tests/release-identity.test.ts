import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RELEASE, releaseIdentity, assertReleaseCommit } from "../packages/core/src/index.js";

describe("release identity (§3, §21)", () => {
  it("baked identity carries product, version, commit, digest", () => {
    assert.equal(RELEASE.product, "eve-x");
    assert.match(RELEASE.version, /^\d+\.\d+\.\d+$/);
    assert.ok(RELEASE.commit.length >= 12, "commit must be baked, never empty");
    assert.ok(String(RELEASE.sourceDigest).length === 64, "sourceDigest must be sha256 hex");
    assert.ok(String(RELEASE.buildTime).length > 0);
  });

  it("releaseIdentity() adds a human release string + runtime facts", () => {
    const id = releaseIdentity();
    assert.ok(String(id.release).startsWith("eve-x "), `release string: ${id.release}`);
    assert.ok(String(id.release).includes(String(RELEASE.commit).slice(0, 12)));
    assert.equal(id.nodeVersion, process.version);
  });

  it("assertReleaseCommit passes when unset or matching, throws on mismatch", () => {
    delete process.env["EVEX_EXPECT_COMMIT"];
    assertReleaseCommit(); // unset → no-op
    process.env["EVEX_EXPECT_COMMIT"] = String(RELEASE.commit);
    assertReleaseCommit(); // matching → no-op
    process.env["EVEX_EXPECT_COMMIT"] = "deadbeef".padEnd(40, "0");
    assert.throws(() => assertReleaseCommit(), /release mismatch/);
    delete process.env["EVEX_EXPECT_COMMIT"];
  });

  it("dirty dev builds are stamped dirty (never silently clean)", () => {
    // The generator stamps dirty:true whenever git status is non-empty.
    // Release builds must be clean; this asserts the flag exists and is boolean.
    assert.equal(typeof RELEASE.dirty, "boolean");
  });
});
