import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  backingDigest,
  requirePinnedDockerImage,
  defaultSeedUserData,
  DockerDesktopDriver,
} from "../packages/vm/src/index.js";

// VM image integrity: full SHA-256 pins (not partial fingerprints),
// deploy-time pin enforcement, and production refusal of mutable tags.
// Tamper bytes in head, middle, AND tail must all be detected.

let DIR = "";
before(() => {
  DIR = mkdtempSync(join(tmpdir(), "evex-vminteg-"));
});

async function assertThrowsCode(fn: () => unknown, code: string): Promise<void> {
  try {
    await fn();
  } catch (err) {
    assert.equal((err as { code?: string })?.code, code);
    return;
  }
  assert.fail(`expected throw with code ${code}`);
}

async function makeBase(size: number, fill = 0x41): Promise<string> {
  const p = join(DIR, `base-${Date.now()}-${Math.floor(Math.random() * 1e6)}.img`);
  await fs.writeFile(p, Buffer.alloc(size, fill));
  return p;
}

describe("backingDigest is a full-file SHA-256", () => {
  it("matches a straight sha256 of the file", async () => {
    const p = await makeBase(300000);
    const expected = createHash("sha256").update(await fs.readFile(p)).digest("hex");
    const got = await backingDigest(p);
    assert.equal(got.digest, expected);
    assert.equal(got.size, 300000);
    assert.ok(Number.isFinite(got.mtimeMs));
  });

  for (const where of ["head", "middle", "tail"] as const) {
    it(`detects a single-byte mutation in the ${where} (multi-region tamper)`, async () => {
      const p = await makeBase(300000);
      const before = await backingDigest(p);
      const fh = await fs.open(p, "r+");
      try {
        const off = where === "head" ? 10 : where === "middle" ? 150000 : 299990;
        const buf = Buffer.alloc(1);
        await fh.read(buf, 0, 1, off);
        buf[0] = (buf[0] as number) ^ 0xff;
        await fh.write(buf, 0, 1, off);
      } finally {
        await fh.close();
      }
      const after = await backingDigest(p);
      assert.notEqual(after.digest, before.digest, `${where} mutation must change the digest`);
    });
  }
});

describe("deploy-time base pin (EVEX_BASE_IMAGE_SHA256)", () => {
  it("refuses creation on digest mismatch", async () => {
    const prev = process.env["EVEX_BASE_IMAGE_SHA256"];
    process.env["EVEX_BASE_IMAGE_SHA256"] = "0".repeat(64);
    try {
      const { QemuDriver } = await import("../packages/vm/src/index.js");
      // The pin check runs before qemu-img, so no hypervisor is needed.
      const imagesDir = join(DIR, "images-pin");
      await fs.mkdir(imagesDir, { recursive: true });
      const d = new QemuDriver({ imagesDir });
      const base = await makeBase(1024 * 1024);
      // Register the base where resolveBaseImage can find it via imagesDir.
      await fs.copyFile(base, join(imagesDir, "pinned.img"));
      try {
        await d.create({ image: "x", cpu: 1, memoryMb: 512, diskGb: 8 } as never, "t", { baseImage: "pinned.img" } as never);
        assert.fail("expected BASE_MISMATCH");
      } catch (err) {
        assert.equal((err as { code?: string })?.code, "BASE_MISMATCH");
      }
    } finally {
      if (prev === undefined) delete process.env["EVEX_BASE_IMAGE_SHA256"];
      else process.env["EVEX_BASE_IMAGE_SHA256"] = prev;
    }
  });
});

describe("production docker image policy", () => {
  it("requirePinnedDockerImage accepts digest refs and refuses tags", () => {
    const pinned = "example.com/desktop@sha256:" + "a".repeat(64);
    assert.equal(requirePinnedDockerImage(pinned), pinned);
    assert.throws(() => requirePinnedDockerImage("dorowu/ubuntu-desktop-lxde-vnc:latest"), /refusing mutable tag/);
    assert.throws(() => requirePinnedDockerImage("repo/img:1.0"), /refusing mutable tag/);
  });

  it("production create refuses :latest; dev allows it", async () => {
    const prev = process.env["EVEX_MODE"];
    try {
      process.env["EVEX_MODE"] = "production";
      const prod = new DockerDesktopDriver({ workdirBase: join(DIR, "dock-prod") });
      await assertThrowsCode(
        () => prod.create({ image: "ubuntu-desktop-v1", cpu: 1, memoryMb: 512, diskGb: 8 } as never, "t"),
        "UNPINNED_IMAGE",
      );
      const pinned = new DockerDesktopDriver({ workdirBase: join(DIR, "dock-prod2"), defaultImage: `img@sha256:${"b".repeat(64)}` });
      const rec = await pinned.create({ image: "ubuntu-desktop-v1", cpu: 1, memoryMb: 512, diskGb: 8 } as never, "t");
      assert.ok(rec.vmId.length > 0);
    } finally {
      if (prev === undefined) delete process.env["EVEX_MODE"];
      else process.env["EVEX_MODE"] = prev;
    }
    const dev = new DockerDesktopDriver({ workdirBase: join(DIR, "dock-dev") });
    const rec = await dev.create({ image: "ubuntu-desktop-v1", cpu: 1, memoryMb: 512, diskGb: 8 } as never, "t");
    assert.ok(rec.vmId.length > 0);
  });
});

describe("agent account privilege separation", () => {
  it("seed grants no passwordless sudo to the agent account", () => {
    const seed = defaultSeedUserData({ hostname: "h", guestSecret: "test-fixture-guest-secret-0123456789" });
    assert.ok(!seed.includes("NOPASSWD:ALL"), "blanket passwordless sudo must be gone");
    assert.ok(seed.includes("sudo: false"), "agent account must be explicitly unprivileged");
  });
});
