import { spawn, type ChildProcess } from "node:child_process";
import { z } from "zod";
import { EveError, nowIso, uid } from "../../core/src/index.js";

// ── Network policy ───────────────────────────────────────────────────────────

export const NetworkPolicy = z.enum(["none", "allowlisted", "full"]);
export type NetworkPolicy = z.infer<typeof NetworkPolicy>;

export const IptablesRule = z.object({
  argv: z.array(z.string()),
  describe: z.string(),
});
export type IptablesRule = z.infer<typeof IptablesRule>;

export const NetworkPolicyInput = z.object({
  policy: NetworkPolicy,
  ownerUid: z.string().max(64).optional(),
  allowedHosts: z.array(z.string().min(1).max(253)).max(256).default([]),
  allowedTcpPorts: z.array(z.number().int().min(1).max(65535)).max(128).default([80, 443]),
  dnsServers: z.array(z.string().min(1).max(64)).max(8).default(["8.8.8.8"]),
});
export type NetworkPolicyInput = z.infer<typeof NetworkPolicyInput>;

/** DNS allowlist: exact or subdomain-suffix match, case-insensitive. */
export class DnsAllowlist {
  private readonly roots: string[];

  constructor(domainsInput: unknown) {
    const domains = z.array(z.string().min(1).max(253)).max(1024).parse(domainsInput);
    this.roots = domains.map((d) => d.toLowerCase().replace(/\.$/, ""));
  }

  isAllowed(hostInput: unknown): boolean {
    const host = z.string().min(1).max(253).parse(hostInput).toLowerCase().replace(/\.$/, "");
    return this.roots.some((r) => host === r || host.endsWith(`.${r}`));
  }

  assertAllowed(hostInput: unknown): void {
    if (!this.isAllowed(hostInput)) {
      throw new EveError("EGRESS_DENIED", `DNS host not allowlisted: ${String(hostInput)}`);
    }
  }

  list(): string[] {
    return [...this.roots];
  }
}

/**
 * Render iptables rules for a policy. Uses the iptables `owner` match so
 * rules bind to the guest UID, plus explicit DNS and destination allowlists.
 */
export function buildIptablesRules(input: unknown): IptablesRule[] {
  const cfg = NetworkPolicyInput.parse(input);
  const ownerMatch: string[] = cfg.ownerUid ? ["-m", "owner", "--uid-owner", cfg.ownerUid] : [];
  const rules: IptablesRule[] = [];
  if (cfg.policy === "full") {
    rules.push({
      argv: ["-A", "OUTPUT", ...ownerMatch, "-j", "ACCEPT"],
      describe: `full egress for ${cfg.ownerUid ?? "all"}`,
    });
    return rules;
  }
  if (cfg.policy === "none") {
    rules.push({
      argv: ["-A", "OUTPUT", ...ownerMatch, "-j", "DROP"],
      describe: `no egress for ${cfg.ownerUid ?? "all"}`,
    });
    return rules;
  }
  // allowlisted
  rules.push({
    argv: ["-A", "OUTPUT", ...ownerMatch, "-m", "conntrack", "--ctstate", "ESTABLISHED,RELATED", "-j", "ACCEPT"],
    describe: "allow return traffic",
  });
  for (const dns of cfg.dnsServers) {
    rules.push({
      argv: ["-A", "OUTPUT", ...ownerMatch, "-p", "udp", "-d", dns, "--dport", "53", "-j", "ACCEPT"],
      describe: `allow DNS udp to ${dns}`,
    });
    rules.push({
      argv: ["-A", "OUTPUT", ...ownerMatch, "-p", "tcp", "-d", dns, "--dport", "53", "-j", "ACCEPT"],
      describe: `allow DNS tcp to ${dns}`,
    });
  }
  for (const host of cfg.allowedHosts) {
    for (const port of cfg.allowedTcpPorts) {
      rules.push({
        argv: ["-A", "OUTPUT", ...ownerMatch, "-p", "tcp", "-d", host, "--dport", String(port), "-j", "ACCEPT"],
        describe: `allow tcp ${host}:${port}`,
      });
    }
  }
  rules.push({
    argv: ["-A", "OUTPUT", ...ownerMatch, "-j", "DROP"],
    describe: "drop everything else",
  });
  return rules;
}

function runIptables(argv: readonly string[]): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child: ChildProcess = spawn("iptables", [...argv], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (d: Buffer) => { stderr += d.toString("utf8"); });
    child.stdout?.on("data", () => undefined);
    child.on("error", (err: Error) => reject(err));
    child.on("close", (code: number | null) => resolve({ code: code ?? -1, stderr }));
  });
}

export interface ApplyReport {
  applied: number;
  failed: Array<{ rule: string; reason: string }>;
}

/** Apply rendered rules with the real iptables binary. */
export async function applyNetworkPolicy(rulesInput: unknown): Promise<ApplyReport> {
  const rules = z.array(IptablesRule).parse(rulesInput);
  const report: ApplyReport = { applied: 0, failed: [] };
  for (const rule of rules) {
    try {
      const r = await runIptables(rule.argv);
      if (r.code === 0) report.applied++;
      else report.failed.push({ rule: rule.describe, reason: r.stderr || `exit ${r.code}` });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      if (reason.includes("ENOENT")) {
        throw new EveError("IPTABLES_UNAVAILABLE", "iptables binary not present; cannot enforce network policy");
      }
      report.failed.push({ rule: rule.describe, reason });
    }
  }
  return report;
}

// ── Capability gates (clipboard / file transfer) ─────────────────────────────

export const GateDirection = z.enum(["in", "out"]);
export type GateDirection = z.infer<typeof GateDirection>;

export const GateAuditEntry = z.object({
  id: z.string(),
  at: z.string(),
  gate: z.string(),
  actor: z.string(),
  capability: z.string(),
  direction: GateDirection,
  bytes: z.number().int(),
  allowed: z.boolean(),
  reason: z.string(),
});
export type GateAuditEntry = z.infer<typeof GateAuditEntry>;

export interface GateCheck {
  capability: string;
  direction: GateDirection;
  bytes: number;
  actor: string;
}

/**
 * Capability gate with byte limits and a full audit trail. Every check —
 * allowed or denied — appends an entry, so exfiltration attempts stay visible.
 */
export class CapabilityGate {
  readonly audit: GateAuditEntry[] = [];

  constructor(
    readonly name: string,
    readonly maxBytes: number,
    private readonly granted: ReadonlySet<string>,
  ) {}

  check(input: unknown): void {
    const c = z.object({
      capability: z.string().min(1),
      direction: GateDirection,
      bytes: z.number().int().min(0),
      actor: z.string().min(1),
    }).parse(input) as GateCheck;
    let allowed = true;
    let reason = "ok";
    if (!this.granted.has(c.capability)) {
      allowed = false;
      reason = `capability ${c.capability} not granted on gate ${this.name}`;
    } else if (c.bytes > this.maxBytes) {
      allowed = false;
      reason = `payload ${c.bytes}B exceeds ${this.maxBytes}B limit on gate ${this.name}`;
    }
    this.audit.push({
      id: uid("gate"),
      at: nowIso(),
      gate: this.name,
      actor: c.actor,
      capability: c.capability,
      direction: c.direction,
      bytes: c.bytes,
      allowed,
      reason,
    });
    if (!allowed) throw new EveError("GATE_DENIED", reason);
  }

  grantedList(): string[] {
    return [...this.granted];
  }
}

export function clipboardGate(granted: ReadonlySet<string>, maxBytes = 65536): CapabilityGate {
  return new CapabilityGate("clipboard", z.number().int().min(1).parse(maxBytes), granted);
}

export function fileTransferGate(granted: ReadonlySet<string>, maxBytes = 10485760): CapabilityGate {
  return new CapabilityGate("file-transfer", z.number().int().min(1).parse(maxBytes), granted);
}

// ── Secret isolation ─────────────────────────────────────────────────────────

const SECRET_PATTERNS: RegExp[] = [
  /api[_-]?key/i,
  /secret/i,
  /token/i,
  /password/i,
  /passwd/i,
  /private[_-]?key/i,
  /connection[_-]?string/i,
  /^aws_/i,
  /^azure_/i,
  /bearer/i,
  /credentials?/i,
];

export interface ScrubReport {
  clean: Record<string, string>;
  redacted: string[];
}

const REDACTED = "***REDACTED***";

/** Strip secret-bearing vars before they cross into the guest environment. */
export function scrubEnv(envInput: unknown): ScrubReport {
  const env = z.record(z.string(), z.string()).parse(envInput);
  const clean: Record<string, string> = {};
  const redacted: string[] = [];
  for (const [k, v] of Object.entries(env)) {
    if (SECRET_PATTERNS.some((p) => p.test(k))) {
      clean[k] = REDACTED;
      redacted.push(k);
    } else {
      clean[k] = v;
    }
  }
  return { clean, redacted };
}

export const HostMount = z.object({
  source: z.string().min(1),
  target: z.string().min(1),
});
export type HostMount = z.infer<typeof HostMount>;

/**
 * Host mounts are denied by default. Only sources under an explicit
 * allowlist prefix pass; everything else throws HOST_MOUNT_DENIED.
 */
export function assertNoHostMounts(mountsInput: unknown, allowedPrefixes: readonly string[] = []): void {
  const mounts = z.array(HostMount).parse(mountsInput);
  const prefixes = z.array(z.string().min(1)).parse([...allowedPrefixes]);
  for (const m of mounts) {
    const ok = prefixes.some((p) => m.source === p || m.source.startsWith(p.endsWith("/") ? p : `${p}/`));
    if (!ok) {
      throw new EveError("HOST_MOUNT_DENIED", `Host mount denied by default: ${m.source} -> ${m.target}`);
    }
  }
}

// ── Sandbox audit log ────────────────────────────────────────────────────────

export const SandboxAuditEntry = z.object({
  id: z.string(),
  at: z.string(),
  actor: z.string(),
  action: z.string(),
  detail: z.string(),
});
export type SandboxAuditEntry = z.infer<typeof SandboxAuditEntry>;

export class SandboxAuditLog {
  private readonly entries: SandboxAuditEntry[] = [];

  append(actorInput: unknown, actionInput: unknown, detailInput: unknown): SandboxAuditEntry {
    const entry = SandboxAuditEntry.parse({
      id: uid("audit"),
      at: nowIso(),
      actor: z.string().min(1).parse(actorInput),
      action: z.string().min(1).parse(actionInput),
      detail: z.string().max(4096).parse(detailInput),
    });
    this.entries.push(entry);
    return entry;
  }

  list(): SandboxAuditEntry[] {
    return [...this.entries];
  }

  exportJson(): string {
    return JSON.stringify(this.entries);
  }
}
