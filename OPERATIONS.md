# OPERATIONS

## Daily rhythm

- Check `/health` on api + inference `/health`; confirm `/ready` is 200
  (unready means degraded heuristic mode — serving, but investigate).
- Review worker backlog (Redis queue depth) and VM fleet states; any VM in
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

**Inference degraded (`/ready` 503, `/health` 200).**
Reload weights or restart the inference container; the plane keeps serving
with low-confidence heuristic actions meanwhile. No traffic shift needed.

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

## Backups

- Postgres: nightly `pg_dump` to the object bucket, 30-day retention.
- Object bucket: versioned; registry `records/*.json` also committed to the
  release branch per promotion.
- Guest snapshots needed for forensics are exported before VM destroy.

## Access

Operators hold individual console accounts; the shared `EVEX_AUTH_TOKEN` is
for service-to-service calls and rotates on every personnel change and after
any incident. Skill installs are per-user and never grant capabilities.
