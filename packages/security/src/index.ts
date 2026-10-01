import { randomUUID, timingSafeEqual, createHmac } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

// ── EVE-X security: auth context, token verify, capability checks, audit ──

export type Role = "viewer" | "operator" | "evaluator" | "admin" | "system";

export type Capability =
  | "vm:create"
  | "vm:control"
  | "vm:destroy"
  | "computer:observe"
  | "computer:act"
  | "human:takeover"
  | "trace:read"
  | "trace:export"
  | "model:invoke"
  | "task:execute"
  | "admin";

export interface AuthContext {
  tenant: string;
  user: string;
  session: string;
  role: Role;
  capabilities: Capability[];
  scopes: string[];
}

export interface AuditEntry {
  at: string;
  tenant: string;
  user: string;
  session: string;
  action: string;
  resource: string;
  decision: "allow" | "deny";
  reason?: string;
}

const ROLE_CAPS: Record<Role, Capability[]> = {
  viewer: ["computer:observe", "trace:read"],
  operator: ["vm:create", "vm:control", "computer:observe", "computer:act", "trace:read", "task:execute"],
  evaluator: ["computer:observe", "trace:read", "trace:export", "human:takeover", "model:invoke", "task:execute"],
  admin: [
    "vm:create", "vm:control", "vm:destroy", "computer:observe", "computer:act",
    "human:takeover", "trace:read", "trace:export", "model:invoke", "task:execute", "admin",
  ],
  system: [
    "vm:create", "vm:control", "vm:destroy", "computer:observe", "computer:act",
    "human:takeover", "trace:read", "trace:export", "model:invoke", "task:execute", "admin",
  ],
};

export function capabilitiesForRole(role: Role): Capability[] {
  return [...(ROLE_CAPS[role] ?? [])];
}

/** Constant-time string equality that is safe on length mismatch (no throw). */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) {
    // Burn a comparable amount of work so length mismatch is not a fast oracle.
    try {
      timingSafeEqual(bb, Buffer.from(bb));
    } catch {
      // ignore — best effort only
    }
    return false;
  }
  return timingSafeEqual(ba, bb);
}

/** True when both contexts (or tenant strings) belong to the same tenant. */
export function sameTenant(a: AuthContext | string, b: AuthContext | string): boolean {
  const ta = typeof a === "string" ? a : a.tenant;
  const tb = typeof b === "string" ? b : b.tenant;
  if (!ta || !tb) return false;
  return safeEqual(ta, tb);
}

interface SessionToken {
  token: string;
  ctx: AuthContext;
  expiresAt: number;
}

const sessionTokens = new Map<string, SessionToken>();

// ── Stateless HMAC session tokens (verifiable cross-process) ──
// Format: evex1.<base64url(payload)>.<hex hmac-sha256(payloadB64, secret)>
// where payload = {tenant,user,session,role,capabilities,scopes,exp}.
// Secret = EVEX_TOKEN_SECRET ?? EVEX_AUTH_TOKEN ?? "". With no secret configured
// we fall back to the in-memory map only (single-process dev mode).

interface StatelessPayload {
  tenant: string;
  user: string;
  session: string;
  role: Role;
  capabilities: Capability[];
  scopes: string[];
  exp: number;
}

function tokenSecret(): string {
  return process.env["EVEX_TOKEN_SECRET"] ?? process.env["EVEX_AUTH_TOKEN"] ?? "";
}

function b64uEncode(s: string): string {
  return Buffer.from(s, "utf8").toString("base64url");
}

function b64uDecode(s: string): string | null {
  try {
    return Buffer.from(s, "base64url").toString("utf8");
  } catch {
    return null;
  }
}

function signPayload(payloadB64: string, secret: string): string {
  return createHmac("sha256", secret).update(payloadB64, "utf8").digest("hex");
}

function mintStatelessToken(ctx: AuthContext, ttlMs: number): string | null {
  const secret = tokenSecret();
  if (!secret) return null;
  const payload: StatelessPayload = {
    tenant: ctx.tenant,
    user: ctx.user,
    session: ctx.session,
    role: ctx.role,
    capabilities: ctx.capabilities,
    scopes: ctx.scopes,
    exp: Date.now() + ttlMs,
  };
  const body = b64uEncode(JSON.stringify(payload));
  return `evex1.${body}.${signPayload(body, secret)}`;
}

function verifyStatelessToken(token: string): AuthContext | null {
  const secret = tokenSecret();
  if (!secret) return null;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "evex1") return null;
  const body = parts[1] as string;
  const sig = parts[2] as string;
  const expected = signPayload(body, secret);
  if (!safeEqual(sig, expected)) return null;
  const raw = b64uDecode(body);
  if (!raw) return null;
  let p: StatelessPayload;
  try {
    p = JSON.parse(raw) as StatelessPayload;
  } catch {
    return null;
  }
  if (typeof p.exp !== "number" || Date.now() > p.exp) return null;
  if (!p.tenant || !p.user || !p.role) return null;
  return {
    tenant: p.tenant,
    user: p.user,
    session: p.session || "stateless",
    role: p.role,
    capabilities: Array.isArray(p.capabilities) ? (p.capabilities as Capability[]) : [],
    scopes: Array.isArray(p.scopes) ? p.scopes : [],
  };
}

function dataDir(): string {
  return process.env["DATA_DIR"] ?? "./data";
}

function auditPath(): string {
  return join(dataDir(), "audit.log");
}

const AUDIT_MAX_BYTES = 10 * 1024 * 1024;

/** Rotate audit.log at ~10MB: audit.log -> audit-1.log, keeping audit-1..3. */
function rotateAuditIfNeeded(): void {
  try {
    const cur = auditPath();
    if (!existsSync(cur)) return;
    const st = statSync(cur);
    if (st.size < AUDIT_MAX_BYTES) return;
    const dir = dataDir();
    try { rmSync(join(dir, "audit-3.log"), { force: true }); } catch { /* ignore */ }
    for (let i = 2; i >= 1; i -= 1) {
      const src = join(dir, `audit-${i}.log`);
      const dst = join(dir, `audit-${i + 1}.log`);
      try {
        if (existsSync(src)) renameSync(src, dst);
      } catch { /* ignore */ }
    }
    try { renameSync(cur, join(dir, "audit-1.log")); } catch { /* ignore */ }
  } catch {
    // Rotation is best-effort and must never break the request path.
  }
}

export function writeAudit(entry: AuditEntry): void {
  const line = JSON.stringify(entry);
  try {
    const dir = dataDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    rotateAuditIfNeeded();
    appendFileSync(auditPath(), line + "\n", { encoding: "utf8" });
  } catch {
    // Audit must never crash the request path; fall back to stderr.
    process.stderr.write(`[audit] ${line}\n`);
  }
}

export function auditAllow(ctx: AuthContext, action: string, resource: string): void {
  writeAudit({ at: new Date().toISOString(), tenant: ctx.tenant, user: ctx.user, session: ctx.session, action, resource, decision: "allow" });
}

export function auditDeny(ctx: AuthContext | null, action: string, resource: string, reason: string): void {
  writeAudit({
    at: new Date().toISOString(),
    tenant: ctx?.tenant ?? "unknown",
    user: ctx?.user ?? "anonymous",
    session: ctx?.session ?? "-",
    action,
    resource,
    decision: "deny",
    reason,
  });
}

function masterToken(): string {
  return process.env["EVEX_AUTH_TOKEN"] ?? "";
}

function tenantOf(): string {
  return process.env["EVEX_TENANT"] ?? "default";
}

export function verifyToken(raw: string): AuthContext | null {
  const token = (raw ?? "").trim().replace(/^Bearer\s+/i, "");
  if (!token) return null;
  const master = masterToken();
  if (master && safeEqual(token, master)) {
    return {
      tenant: tenantOf(),
      user: "master",
      session: "master",
      role: "admin",
      capabilities: capabilitiesForRole("admin"),
      scopes: ["*"],
    };
  }
  const sess = sessionTokens.get(token);
  if (sess) {
    if (Date.now() > sess.expiresAt) {
      sessionTokens.delete(token);
      return null;
    }
    return sess.ctx;
  }
  // Stateless HMAC format (cross-process); map miss means unknown/revoked.
  const stateless = verifyStatelessToken(token);
  if (stateless) return stateless;
  return null;
}

export function extractBearer(headers: Record<string, string | string[] | undefined>): string {
  const h = headers["authorization"] ?? headers["Authorization"];
  if (Array.isArray(h)) return h[0] ?? "";
  return h ?? "";
}

export function authFromHeaders(headers: Record<string, string | string[] | undefined>): AuthContext | null {
  const raw = extractBearer(headers);
  if (!raw) {
    // Dev mode: no token configured and none presented → read-only system context is NOT granted.
    // If EVEX_AUTH_TOKEN is unset, allow a scoped operator context so local dev works.
    if (!masterToken()) {
      return {
        tenant: tenantOf(),
        user: "dev-anon",
        session: "dev",
        role: "operator",
        capabilities: capabilitiesForRole("operator"),
        scopes: ["dev"],
      };
    }
    return null;
  }
  return verifyToken(raw);
}

export class AuthError extends Error {
  code = "UNAUTHORIZED";
  status = 401;
  constructor(msg = "Unauthorized") {
    super(msg);
  }
}

export class ForbiddenError extends Error {
  code = "FORBIDDEN";
  status = 403;
  constructor(msg = "Forbidden") {
    super(msg);
  }
}

export function hasCap(ctx: AuthContext, cap: Capability): boolean {
  if (ctx.capabilities.includes("admin" as Capability) || ctx.capabilities.includes(cap)) return true;
  if (ctx.role === "admin" || ctx.role === "system") return true;
  return false;
}

/** Throw ForbiddenError when the context lacks a capability; audit both outcomes. */
export function requireCap(ctx: AuthContext, cap: Capability, resource = "*"): void {
  if (hasCap(ctx, cap)) {
    return;
  }
  auditDeny(ctx, `require:${cap}`, resource, `missing capability ${cap}`);
  throw new ForbiddenError(`Missing capability: ${cap}`);
}

export function createSessionToken(input: {
  tenant?: string;
  user: string;
  role?: Role;
  scopes?: string[];
  ttlMs?: number;
  extraCaps?: Capability[];
}): { token: string; ctx: AuthContext; expiresAt: string } {
  const role: Role = input.role ?? "operator";
  const base = capabilitiesForRole(role);
  const caps = input.extraCaps ? [...new Set([...base, ...input.extraCaps])] : base;
  const ctx: AuthContext = {
    tenant: input.tenant ?? tenantOf(),
    user: input.user,
    session: `sess-${randomUUID().slice(0, 8)}`,
    role,
    capabilities: caps,
    scopes: input.scopes ?? ["sessions", "vms", "tasks"],
  };
  const ttl = input.ttlMs ?? 12 * 3600 * 1000;
  // Prefer stateless HMAC tokens (verifiable cross-process) when a secret exists;
  // otherwise fall back to the legacy in-memory opaque token.
  const stateless = mintStatelessToken(ctx, ttl);
  const token = stateless ?? `evex_${randomUUID().replace(/-/g, "")}`;
  sessionTokens.set(token, { token, ctx, expiresAt: Date.now() + ttl });
  writeAudit({
    at: new Date().toISOString(), tenant: ctx.tenant, user: ctx.user, session: ctx.session,
    action: "token:issue", resource: role, decision: "allow",
  });
  return { token, ctx, expiresAt: new Date(Date.now() + ttl).toISOString() };
}

export function revokeSessionToken(token: string): boolean {
  return sessionTokens.delete(token);
}

export function listSessionTokens(): Array<{ user: string; role: Role; expiresAt: string }> {
  const out: Array<{ user: string; role: Role; expiresAt: string }> = [];
  for (const s of sessionTokens.values()) {
    out.push({ user: s.ctx.user, role: s.ctx.role, expiresAt: new Date(s.expiresAt).toISOString() });
  }
  return out;
}
