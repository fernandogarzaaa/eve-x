import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";
import {
  createGuestAgent,
  HostGuestChannel,
  resolveExecutable,
  lexicalInsideRoot,
  canonicalInsideRoot,
  type GuestAgent,
} from "../packages/guest/src/index.js";

// Guest jail + executable identity: symlink traversal and basename
// spoofing must fail closed. Symlink-creation tests classify precisely
// when the OS refuses links (Windows without Developer Mode): they pass
// only on proven EPERM/EACCES, and the same properties run on Linux CI.

const SECRET = "test-guest-jail-secret-0123456789abcdef";

let ROOT = "";
let agent: GuestAgent | null = null;
let chan: HostGuestChannel | null = null;
let fsRoot = "";

async function trySymlink(target: string, path: string): Promise<boolean> {
  try {
    await fs.symlink(target, path);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "EPERM" || code === "EACCES" || code === "EROFS") return false;
    throw err;
  }
}

before(async () => {
  ROOT = mkdtempSync(join(tmpdir(), "evex-jail-"));
  fsRoot = join(ROOT, "jail");
  agent = await createGuestAgent({
    port: 0, host: "127.0.0.1", secret: SECRET, fsRoot,
    execAllowlist: [basename(process.execPath)],
    execAllowDirs: [dirname(process.execPath)],
  });
  chan = new HostGuestChannel({ baseUrl: (agent as GuestAgent).url, secret: SECRET });
});

after(async () => {
  await agent?.close();
  rmSync(ROOT, { recursive: true, force: true });
});

function C(): HostGuestChannel {
  if (!chan) throw new Error("guest channel not started");
  return chan;
}

/** Assert a rejection carrying an EveError code (server replies surface the
 *  code in the message body; direct calls surface it on .code). */
async function assertRejectsCode(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
  } catch (err) {
    const text = `${String((err as { code?: unknown })?.code ?? "")} ${err instanceof Error ? err.message : String(err)}`;
    assert.match(text, new RegExp(code), `expected ${code}, got: ${text.slice(0, 300)}`);
    return;
  }
  assert.fail(`expected rejection with ${code}`);
}

describe("lexical + canonical jail", () => {
  it("rejects .. traversal lexically", () => {
    for (const p of ["../escape", "a/../../escape"]) {
      try {
        lexicalInsideRoot(fsRoot, p);
        assert.fail(`expected FS_ESCAPE for ${p}`);
      } catch (err) {
        assert.equal((err as { code?: string })?.code, "FS_ESCAPE");
      }
    }
  });

  it("accepts a benign nested path", async () => {
    const full = await canonicalInsideRoot(fsRoot, "a/b/c.txt");
    assert.ok(full.endsWith(join("a", "b", "c.txt")));
  });

  it("refuses reads through a symlink pointing outside", async () => {
    const outside = join(ROOT, "outside.txt");
    await fs.writeFile(outside, "TOP-SECRET-OUTSIDE", "utf8");
    const link = join(fsRoot, "link.txt");
    if (!(await trySymlink(outside, link))) {
      assert.ok(true, "classified: symlink creation unavailable on this host");
      return;
    }
    await assertRejectsCode(C().readFile("link.txt"), "FS_ESCAPE");
    // The outside file is untouched and its content never returned.
    assert.equal(await fs.readFile(outside, "utf8"), "TOP-SECRET-OUTSIDE");
  });

  it("refuses writes through a directory symlink pointing outside", async () => {
    const outsideDir = join(ROOT, "outside-dir");
    await fs.mkdir(outsideDir, { recursive: true });
    const linkDir = join(fsRoot, "linkdir");
    if (!(await trySymlink(outsideDir, linkDir))) {
      assert.ok(true, "classified: symlink creation unavailable on this host");
      return;
    }
    await assertRejectsCode(C().writeFile("linkdir/evil.txt", Buffer.from("x")), "FS_ESCAPE");
    assert.equal((await fs.readdir(outsideDir)).length, 0);
  });

  it("refuses writes that escape via ..", async () => {
    const dest = join(ROOT, "escaped.txt");
    await assertRejectsCode(C().writeFile("../escaped.txt", Buffer.from("x")), "FS_ESCAPE");
    let exists = false;
    try { await fs.stat(dest); exists = true; } catch { exists = false; }
    assert.equal(exists, false);
  });

  it("round-trips a legitimate file", async () => {
    const n = await C().writeFile("legit/note.txt", Buffer.from("hello-jail"));
    assert.equal(n, Buffer.byteLength("hello-jail"));
    const back = await C().readFile("legit/note.txt");
    assert.equal(back.toString("utf8"), "hello-jail");
  });
});

describe("executable identity (not basename)", () => {
  it("executes the allowlisted binary by canonical path", async () => {
    const r = await C().exec([process.execPath, "--version"]);
    assert.equal(r.ok, true);
    assert.match(String(r.stdout ?? ""), /v\d+\.\d+/);
  });

  it("refuses an attacker-controlled binary with an allowed basename", async () => {
    const evilDir = join(ROOT, "evil");
    await fs.mkdir(evilDir, { recursive: true });
    const bin = basename(process.execPath);
    await fs.copyFile(process.execPath, join(evilDir, bin));
    await assertRejectsCode(
      C().exec([join(evilDir, bin), "--version"]),
      "NOT_ALLOWLISTED",
    );
  });

  it("resolveExecutable: bare names resolve to trusted dirs even with attacker PATH", async () => {
    const evilDir = join(ROOT, "evil-path");
    await fs.mkdir(evilDir, { recursive: true });
    const bin = basename(process.execPath);
    await fs.copyFile(process.execPath, join(evilDir, bin));
    // The evil copy is on the (simulated) PATH, but resolution prefers the
    // trusted dir and returns the canonical trusted binary — never the evil
    // copy.
    const got = await resolveExecutable(bin, new Set([bin]), [dirname(process.execPath)], [evilDir]);
    const trustedReal = await fs.realpath(join(dirname(process.execPath), bin));
    assert.equal(got, trustedReal);
  });

  it("resolveExecutable: binary present only on attacker PATH is refused", async () => {
    const evilDir = join(ROOT, "evil-path-only");
    await fs.mkdir(evilDir, { recursive: true });
    const bin = basename(process.execPath);
    await fs.copyFile(process.execPath, join(evilDir, bin));
    await assertRejectsCode(
      resolveExecutable(bin, new Set([bin]), [join(ROOT, "empty-trust")], [evilDir]),
      "NOT_ALLOWLISTED",
    );
  });

  it("resolveExecutable: symlink inside trusted dirs that escapes is refused", async () => {
    const trustDir = join(ROOT, "trust");
    await fs.mkdir(trustDir, { recursive: true });
    const bin = basename(process.execPath);
    const evilCopy = join(ROOT, "evil-shim-target", bin);
    await fs.mkdir(dirname(evilCopy), { recursive: true });
    await fs.copyFile(process.execPath, evilCopy);
    const link = join(trustDir, `shim-${bin}`);
    if (!(await trySymlink(evilCopy, link))) {
      assert.ok(true, "classified: symlink creation unavailable on this host");
      return;
    }
    // Link target is outside the trusted dir -> canonical identity is
    // attacker-controlled -> refuse even though the link itself is trusted.
    // (The link basename is allowlisted so only the escape can refuse.)
    await assertRejectsCode(
      resolveExecutable(link, new Set([basename(link)]), [trustDir]),
      "NOT_ALLOWLISTED",
    );
  });

  it("resolveExecutable: non-allowlisted basename is refused", async () => {
    await assertRejectsCode(
      resolveExecutable(process.execPath, new Set(["definitely-not-it"]), [dirname(process.execPath)]),
      "NOT_ALLOWLISTED",
    );
  });
});
