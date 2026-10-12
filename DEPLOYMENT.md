# DEPLOYMENT

## Local compose (reproducible)

```bash
cp .env.example .env   # then SET EVEX_AUTH_TOKEN (>=32 random chars) + POSTGRES_PASSWORD
docker compose -f infra/deployment/docker-compose.yml up --build
```

Secrets are REQUIRED, never defaulted: compose refuses to start without
`EVEX_AUTH_TOKEN` and `POSTGRES_PASSWORD` (`${VAR:?...}` guards); the
example file carries `REPLACE_ME_...` markers that the production gate
rejects; `eve-x init` mints a fresh random token per project.

Services, ports, and volumes below mirror
`infra/deployment/docker-compose.yml` exactly (project name `eve-x`):

| Service | Image / build | Host ports | Volumes / notes |
|---|---|---|---|
| `postgres` | `postgres:16-alpine@sha256:7218…` (digest-pinned; `verify-release` cross-checks) | none published | `pgdata:/var/lib/postgresql/data`; healthy via `pg_isready -U evex` |
| `redis` | `redis:7-alpine@sha256:858f…` (digest-pinned; `verify-release` cross-checks) | none published | `redisdata:/data`; healthy via `redis-cli ping` |
| `garage` | `dxflrs/garage:v2.0.0@sha256:15b4…` (digest-pinned; `verify-release` cross-checks), `server -c /etc/garage.toml` | none published | `garagedata-meta`, `garagedata-data`; config rendered at deploy time from `infra/deployment/object-storage/garage.toml.template` (secrets never committed). The qualified S3-compatible backend per ADR-14; MinIO is a merely supported alternative, not the qualified backend |
| `inference` | `infra/docker/Dockerfile.inference`, `python ml/inference/server.py --host 0.0.0.0 --port 8090 --cpu --allow-heuristic` | none published (internal-only plane; the API reaches it over the compose network) | healthy via `GET /health`; readiness via `GET /ready` (503 until verified weights load or the explicit heuristic flag applies). Set `EVEX_INFERENCE_TOKEN` to require bearer auth on `/infer` + `/model-info`. Production with real models mounts `--weights` + `--weights-sha256` (+ `--arch` / manifest) and drops `--allow-heuristic`. |
| `api` | `infra/docker/Dockerfile.api`, `PORT=8080`, `DATA_DIR=/data` | `${API_PORT:-8080}:8080` | `evexdata:/data`; depends on postgres+redis healthy, garage started |
| `worker` | `infra/docker/Dockerfile.worker`, `node dist/apps/worker/src/index.js` | none published | `evexdata:/data`; depends on api+redis healthy |
| `mcp` | `infra/docker/Dockerfile.mcp`, `node dist/apps/mcp/src/index.js` | `${MCP_PORT:-8081}:8091` (container serves `MCP_PORT=8091`) | depends on api healthy; serves StreamableHTTP at `/mcp` |
| `console` | `infra/docker/Dockerfile.console`, `EVEX_API_URL=http://api:8080` | `${CONSOLE_PORT:-3000}:3000` | depends on api healthy |

Volumes: `pgdata`, `redisdata`, `garagedata-meta`, `garagedata-data`,
`evexdata` persist across restarts. `latest` is never deployed — image tags
pin the release version and the release manifest pins base digests.

Standalone equivalents of the service images (same launch contract, kept
alongside compose): `infra/docker/Dockerfile.api`, `Dockerfile.worker`,
`Dockerfile.mcp`, `Dockerfile.console`, `infra/docker/Dockerfile.inference`
(python 3.11 + `ml/`). Non-API entry paths (`worker`, `mcp`) resolve under
`dist/apps/<name>/src/index.js` in a fresh `npm run build` tree.

## Persistence split (system of record, §15)

| State | System of record | Role of the rest |
|---|---|---|
| Sessions, VMs, tasks, trace steps (JSONL), judgments, model registry, audit logs | **Filesystem** (`DATA_DIR`: JSON collections + `objects/traces/*.jsonl`) | Postgres is an optional structured mirror, not the record: with `DATABASE_URL` unset or the `pg` driver absent the control plane stays file-primary; `EVEX_REQUIRE_SERVICES` only gates reachability when an operator explicitly requires it |
| Coordination / leases | **Filesystem leases** (Redis driver absent by default) | Redis is ephemeral coordination only, never durable; file-lease fallback is the default path |
| Blobs (screenshots, reports, exports, weights) | **Filesystem** (`OBJECT_DIR`) content-addressed by sha256 | Garage (S3 API) is the qualified artifact publish/backup target, operated at the deployment layer; no application code speaks S3 or depends on Garage-specific behavior (§14) |
| Guests | Cattle | Any VM can be destroyed and reprovisioned from the sealed base + snapshot without losing platform state |

Do not imply Postgres is the system of record. Do not imply Redis is
durable. Do not imply the filesystem fallback is equivalent to distributed
persistence — it is the primary by design in 1.0.0.

## Guest images

Build once per base rotation with `infra/vm-images/build.sh`, publish the
qcow2 + `<image>.build.json` digest file to the artifact bucket, and point
`VmSpec.image` at the new name. Guests are cattle: any VM can be destroyed
and reprovisioned from the snapshot without losing platform state (traces
live in Postgres/objects, not in guests). On a fresh Linux host,
`infra/deployment/linux-bootstrap.sh` performs this fetch/build hook plus
KVM, user/group, `DATA_DIR` layout, systemd, and sysctl setup.

## Configuration

All tunables flow through environment (see `.env.example`): `PORT`,
`WS_PORT`, `VNC_PORT`, `DATA_DIR`, `OBJECT_DIR`, `DATABASE_URL`,
`REDIS_URL`, `INFERENCE_URL`, `EVEX_AUTH_TOKEN`, `VM_BACKEND`, `QEMU_BIN`.
Compose maps the same names with `_PORT` overrides for host bindings
(`API_PORT`, `MCP_PORT`, `CONSOLE_PORT`, `INFERENCE_PORT`).

## Promotion to shared environments

1. `npx tsc --noEmit` green, `node --test` green, `python --version` sane.
2. Build guest image, record digests.
3. `docker compose up` on a staging host; run a canary benchmark split.
4. Cut model promotion with a human approval token (registry enforces it).
5. Tag release; attach eval artifacts and image `.build.json` files.
