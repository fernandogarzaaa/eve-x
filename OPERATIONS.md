# OPERATIONS

## Execution modes

`EVEX_MODE` selects the posture: `development` (default, zero-config local
dev with a scoped dev-anon fallback), `test` (hermetic suites, no fallback),
`production` (fail closed). In production, `startApi` refuses to serve unless
the posture evaluates production-safe: strong `EVEX_AUTH_TOKEN` (≥32 chars,
no well-known or template values), required services reachable
(`EVEX_REQUIRE_SERVICES`), quotas set, non-dev VM backend, sane TLS posture.
Weak or missing secrets refuse startup — they are never defaulted.

## Daily rhythm

- Check `/health` on api + inference `/health`; confirm inference `/ready`
  is 200 with the expected `model_id`/`model_sha256` (503 = not serving;
  the plane answers 503, never heuristic-as-model — investigate).
  `/health` also reports the release identity; a commit that does not match
  the deployed release is an incident, not a curiosity.
- Review `/metrics` counters (stale rejections, actuation failures,
  takeovers, benchmark runs/failures, validation verdicts, vm losses);
  spikes get investigated, not muted.
- Review worker backlog and VM fleet states; any VM in
  `FAILED` longer than 15 min gets destroyed and reprovisioned.
- Scan the governance audit log for 403/409 spikes — a burst of policy
  denials usually means a misconfigured task policy, not an attack.

## Systemd (Linux prod, installed by `infra/deployment/linux-bootstrap.sh`)

Units (all `Restart=always`, `NoNewPrivileges=true`, `ProtectSystem=strict`,
read-write only on `/var/lib/evex`):

- `evex-api.service` — `node dist/apps/api/src/index.js` (`PORT=8080`)
- `evex-worker.service` — `node dist/apps/worker/src/index.js`
- `evex-mcp.service` — `node dist/apps/mcp/src/index.js` (stdio; `MCP_PORT=8091` for `http` mode)
- `evex-console.service` — `node dist/apps/console/src/index.js` (`CONSOLE_PORT=3000`)

```bash
systemctl status evex-api evex-worker evex-mcp evex-console
journalctl -u evex-api -f
systemctl restart evex-worker   # picks up a fresh dist bundle
```

The bootstrap script is idempotent — re-run it after pulling a new release,
then restart the units. Sysctl baseline lives in
`/etc/sysctl.d/99-evex.conf` (`fs.file-max`, `net.core.somaxconn`,
`vm.max_map_count`).

## Runbooks

**Inference not ready (`/ready` 503, `/health` 200).**
Reload verified weights (`--weights` + `--weights-sha256`) or restart the
inference container; dependents see explicit 502/503 (suggest →
`inference_unavailable`, benchmarks → inconclusive), never silent
heuristic output labeled as model output. No traffic shift needed.

**Queue full (429s on `/infer`).**
Scale inference replicas or lower population-study concurrency; the bounded
queue protects latency, so 429s are the signal working as designed.

**DB pressure.**
Trace reads are seq-paginated — cap `--limit`, add retention on screenshots
older than the configured window, and confirm `pgdata` volume growth.

**Stuck VM.**
`eve-x vm status <id>` to confirm state; stop the session
(`eve-x session stop <id>`), then `eve-x vm rm <id>` and reprovision from
the clean snapshot. Never delete overlays by hand.

**Restart recovery (nothing auto-runs).**
On boot, sessions persisted as RUNNING demote to PAUSED (`recoveryNote`
recorded, worker control flags set) — VM, runtime, and lease state are
unproven after a restart. Re-arm explicitly per session:
`POST /v1/sessions/{id}/resume` (409 unless PAUSED). FAILED stays FAILED
with its reason; judgments, dedupe keys, and pending blind reviews
rehydrate from disk, so validation evidence survives restarts.

**Orphaned QEMU after a control-plane crash.**
`VmManager.recover()` (runs at worker/API start) SIGKILLs recorded live PIDs
best-effort and reports `{recovered, orphansKilled, stale}`. The KVM
qualification harness additionally reaps with `pkill -9 -f
qemu-system-x86_64` pre-flight and refuses to start if orphans survive (a
stale QMP/display/port claim otherwise surfaces as a misleading handshake
failure). Port claims additionally TCP-probe before use, so an orphan is
skipped, never collided with.

**Clock discipline (leases depend on it).**
Worker leases (20 s TTL) and HMAC timestamps (±60 s window) assume
synchronized clocks. `linux-bootstrap.sh` enables chrony; alert if
`chronyc tracking` shows offset > 5 s. Lease *takeover* is additionally
protected by epoch fencing (a new holder bumps the epoch; the old holder
aborts on mismatch regardless of clocks), and trace seqs are allocated from
the file tail per step, so a skew split-brain can duplicate at most one
in-flight batch before fencing trips — and replay flags any gap/dupe.

**Storage failure (DATA_DIR).**
The filesystem is the system of record: stop the plane, restore `DATA_DIR`
from the latest `data-backup.tar`, restart, confirm session count via
`/v1/sessions` and release identity via `/version` (rehearsed: 32→0→32).
Never hand-edit JSON collections; use the API or replay tooling.

**Garage / object failure.**
Blobs stay local (`OBJECT_DIR`); Garage is the publish/backup target.
Re-run `bring-up.sh` (idempotent on restored data dirs) and re-run
`object-qual.py` with a throwaway key to re-verify CRUD + checksums.

**Postgres / Redis failure.**
Both are optional with file fallback: the plane keeps serving. Restore the
container/volume, then confirm `/ready` persistence mode flips back to
`production` when `EVEX_REQUIRE_SERVICES` is set.

**Model / inference failure.**
`/v1/models/status` reports live reachability plus the model identity; when
the plane is down, dependents see explicit 502/503 and benchmarks go
inconclusive. Roll back via the registry (`retire` the bad checkpoint; the
previous production record remains authoritative). Heuristic output is only
ever served labeled `degraded: true` under the explicit `--allow-heuristic`
deployment flag — never as a trained model.

**TLS failure.**
Qual/prod certs live in `infra/deployment/tls/certs/` (gitignored).
Re-issue, restart the nginx sidecar, re-run `tls-check.mjs`.

**Credential rotation.**
`EVEX_AUTH_TOKEN`: set the new value, rolling-restart api/worker/mcp/
console, revoke the old. Garage keys: `key create` → re-allow bucket →
`key delete --yes` the old (rehearsed during qual). VM guest secrets are
per-VM generated at provision time — nothing to rotate.

**Incident response.**
Freeze: capture `/version` + `baseline.json`-style env facts first. Then
session trace (`dataset trace`), audit log, and the object bundle. Reports
must cite the release commit; never debug a dirty build in production.

## Backups

- `DATA_DIR` (the system of record): tar snapshots (`data-backup.tar`
  pattern), restore rehearsed (wipe → 0 sessions → restore → full recovery).
- Object bucket (Garage): data+meta dir copies; destroy/restore rehearsed
  byte-identical (`artifacts/release/garage-backup-restore.json`).
- Postgres (optional mirror): nightly `pg_dump` to the object bucket,
  30-day retention.
- Guest snapshots needed for forensics are exported before VM destroy.

## Access

Operators hold individual console accounts; the shared `EVEX_AUTH_TOKEN` is
for service-to-service calls and rotates on every personnel change and after
any incident. Skill installs are per-user and never grant capabilities.
