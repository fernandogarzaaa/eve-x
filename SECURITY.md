# SECURITY

## Execution modes (fail closed)

`EVEX_MODE` selects the posture: `development` (default), `test`,
`production`. Outside development there is no anonymous/dev-anon context:
missing or invalid credentials are 401, and `startApi` refuses production
boot unless the posture evaluates production-safe (strong token, required
services reachable, quotas, safe backend, sane TLS). The security package
is mandatory in production — its absence refuses startup, never dev auth.

## Authentication

- Every `/v1` route requires `Authorization: Bearer <EVEX_AUTH_TOKEN>`
  (only `GET /health`, `/ready`, `/version`, `/metrics` are public probes).
- WebSocket upgrades carry the same auth (header or `?token=`); unknown
  sessions 404, cross-tenant 403, floods 429. The `?token=` query form
  exists because browser WebSocket clients cannot set headers — it is not
  preferred, and the server never logs request URLs (honesty-gate
  enforced), so tokens do not land in access logs.
- The MCP surface reuses the same token: `ControlPlaneClient` always sends
  the Bearer header and `createClientFromEnv` refuses to construct a client
  when `EVEX_AUTH_TOKEN` is unset. `/mcp` additionally requires
  `EVEX_MCP_TOKEN` when set, and is per-caller rate-limited.
- Inference (`:8090`, internal-only, no published port) requires bearer auth
  on `/infer` + `/model-info` when `EVEX_INFERENCE_TOKEN` is set; the
  control plane forwards it. `/health`, `/ready`, `/metrics` stay open.
- Human reviewers authenticate to the console with individual accounts; all
  judgments record the reviewer id and bind to an owned session/step
  (cross-tenant and phantom judgments are refused).

## Authorization

- Capabilities (`protocol` `Capability` enum): `vm:create`, `vm:control`,
  `vm:destroy`, `computer:observe`, `computer:act`, `human:takeover`,
  `trace:read`, `trace:export`, `model:invoke`, `task:execute`, `admin`.
- `admin` implies all; every other operation requires its exact capability.
  Denials return 403 and are appended to the governance audit log.
- Skill installation never grants capabilities: skills declare requested
  permissions in `skill.json`, and the runtime intersects them with the
  caller's grant.

## Secrets handling

- Production secrets are REQUIRED, never defaulted: compose refuses to
  start without `EVEX_AUTH_TOKEN`/`POSTGRES_PASSWORD`; `.env.example`
  carries `REPLACE_ME_...` markers the production gate rejects; `eve-x
  init` mints a fresh random token. The secret scanner (CI) flags weak
  literals with zero findings tolerated.
- `ml/datasets/build.py` redacts API keys, GitHub/Slack tokens, bearer
  credentials, password/secret assignments, AWS key assignments, and home-directory
  user names before any row reaches a dataset file; per-row redaction counts
  are preserved in `_redactions`.
- Traces may contain screenshots with visible secrets; trace export requires
  the `trace:export` capability, trace reads are owner-enforced (unknown
  sessions 404 even with file-backed steps), and bearer values are never
  logged (honesty-gate enforced).

## Network isolation

- Default VM network mode is `allowlisted`; `full` requires
  `allowExternalComms` in the task policy and is denied otherwise.
- Guests never reach the control plane DB, object storage credentials, or
  the inference admin surface; host channels are QMP (socket, never TCP),
  VNC on loopback with per-VM ports, and the HMAC-signed guest agent
  channel. Escape probes (metadata service, host loopback, VM sockets)
  are refused and covered by tests.
- The guest filesystem jail is canonical (symlink traversal refused,
  no-follow opens, post-open containment re-check); the executable
  allowlist is by canonical identity (trusted dirs + realpath), never
  basename; the agent account is unprivileged (`sudo: false` in all seeds).

## Supply chain

- `infra/vm-images/build.sh` pins the base cloud image URL and records
  base + output sha256 digests in `<image>.build.json`. Boot verifies the
  FULL base sha256 (size+mtime fast path, re-hash on change) and refuses
  drift; `EVEX_BASE_IMAGE_SHA256` pins the deploy-time base; production
  container images must be digest references (`requirePinnedDockerImage`),
  and compose pins postgres/redis/garage by digest (verified by
  `verify-release`).
- `train.py` writes `code_digest` (sha256 of the training script) into
  `lineage.json`; the registry stores it per model version.
- Dependencies install from lockfiles; `npm audit` runs in CI before images
  are built.

## Incident response

1. Revoke `EVEX_AUTH_TOKEN` and rotate DB/object credentials.
2. Freeze promotions (`model-registry` refuses without fresh approval tokens
   once the token seed rotates).
3. Export affected session traces for forensics; snapshots preserve
   pre-incident guest state.
4. File a postmortem and, if architecture changes, a new ADR.
