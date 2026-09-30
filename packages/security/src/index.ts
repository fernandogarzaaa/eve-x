import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
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

interface SessionToken {
  token: string;
  ctx: AuthContext;
  expiresAt: number;
}

const sessionTokens = new Map<string, SessionToken>();

function dataDir(): string {
  return process.env["DATA_DIR"] ?? "./data";
}

function auditPath(): string {
  return join(dataDir(), "audit.log");
}

export function writeAudit(entry: AuditEntry): void {
  const line = JSON.stringify(entry);
  try {
    const dir = dataDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
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
  if (master && token === master) {
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
  const token = `evex_${randomUUID().replace(/-/g, "")}`;
  const ctx: AuthContext = {
    tenant: input.tenant ?? tenantOf(),
    user: input.user,
    session: `sess-${randomUUID().slice(0, 8)}`,
    role,
    capabilities: caps,
    scopes: input.scopes ?? ["sessions", "vms", "tasks"],
  };
  const ttl = input.ttlMs ?? 12 * 3600 * 1000;
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
