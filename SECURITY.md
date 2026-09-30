# SECURITY

## Authentication

- Every `/v1` route except `GET /v1/health` requires
  `Authorization: Bearer <EVEX_AUTH_TOKEN>`.
- The MCP surface reuses the same token: `ControlPlaneClient` always sends
  the Bearer header and `createClientFromEnv` refuses to construct a client
  when `EVEX_AUTH_TOKEN` is unset.
- Inference (`:8090`) binds to loopback by default in compose and trusts only
  the control plane network; it holds no credentials and never sees the
  control-plane token.
- Human reviewers authenticate to the console with individual accounts; all
  judgments record the reviewer id for blind-audit trails.

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

- `ml/datasets/build.py` redacts API keys, GitHub/Slack tokens, bearer
  credentials, password assignments, AWS key assignments, and home-directory
  user names before any row reaches a dataset file; per-row redaction counts
  are preserved in `_redactions`.
- Traces may contain screenshots with visible secrets; trace export requires
  the `trace:export` capability and exports are stored in the allowlisted
  object bucket only.
- `.env` (tokens, DB passwords) is git-ignored; `.env.example` documents
  required variables with inert defaults.

## Network isolation

- Default VM network mode is `allowlisted`; `full` requires
  `allowExternalComms` in the task policy and is denied otherwise.
- Guests never reach the control plane DB, object storage credentials, or
  the inference admin surface; the only guest channel is the VNC/agent socket
  owned by the worker.

## Supply chain

- `infra/vm-images/build.sh` pins the base cloud image URL and records
  base + output sha256 digests in `<image>.build.json`.
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
