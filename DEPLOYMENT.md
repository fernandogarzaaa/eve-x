# DEPLOYMENT

## Local compose (reproducible)

```bash
cp .env.example .env   # set EVEX_AUTH_TOKEN + POSTGRES_PASSWORD
docker compose -f infra/deployment/docker-compose.yml up --build
```

Services, ports, and volumes below mirror
`infra/deployment/docker-compose.yml` exactly (project name `eve-x`):

| Service | Image / build | Host ports | Volumes / notes |
|---|---|---|---|
| `postgres` | `postgres:16-alpine` | none published | `pgdata:/var/lib/postgresql/data`; healthy via `pg_isready -U evex` |
| `redis` | `redis:7-alpine` (`--appendonly yes`) | none published | `redisdata:/data`; healthy via `redis-cli ping` |
| `minio` | `minio/minio:RELEASE.2024-06-13T22-53-53Z` (`server /data --console-address :9001`) | none published | `miniadata:/data` |
| `inference` | `infra/vm-images/Dockerfile.inference`, `python ml/inference/server.py --host 0.0.0.0 --port 8090 --cpu` | `${INFERENCE_PORT:-8090}:8090` | healthy via `GET /health` |
| `api` | `infra/vm-images/Dockerfile.api`, `PORT=8080`, `DATA_DIR=/data` | `${API_PORT:-8080}:8080` | `evexdata:/data`; depends on postgres+redis healthy, minio started |
| `worker` | `infra/vm-images/Dockerfile.api`, `node dist/apps/worker/index.js` | none published | `evexdata:/data`; depends on api+redis healthy |
| `mcp` | `infra/vm-images/Dockerfile.api`, `node dist/apps/mcp/index.js` | `${MCP_PORT:-8081}:8081` | depends on api healthy; serves StreamableHTTP at `/mcp` |
| `console` | `infra/vm-images/Dockerfile.console`, `EVEX_API_URL=http://api:8080` | `${CONSOLE_PORT:-3000}:3000` | depends on api healthy |

Volumes: `pgdata`, `redisdata`, `miniadata`, `evexdata` persist across
restarts. `latest` is never deployed — image tags pin the release version.

Standalone equivalents of the service images (same launch contract, kept
alongside compose): `infra/docker/Dockerfile.api`, `Dockerfile.worker`,
`Dockerfile.mcp`, `Dockerfile.console`, `infra/docker/Dockerfile.inference`
(python 3.11 + `ml/`). Non-API entry paths (`worker`, `mcp`) resolve under
`dist/apps/<name>/src/index.js` in a fresh `npm run build` tree.

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
