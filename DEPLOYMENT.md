# DEPLOYMENT

## Local compose (reproducible)

```bash
cp .env.example .env   # set EVEX_AUTH_TOKEN + POSTGRES_PASSWORD
docker compose -f infra/deployment/docker-compose.yml up --build
```

Services and ports: `api` :8080, `mcp` :8081, `console` :3000,
`inference` :8090, plus internal `postgres`, `redis`, `minio` (API :9000,
console :9001). Healthchecks gate startup order: postgres/redis healthy →
api → worker/mcp. Volumes `pgdata`, `redisdata`, `miniadata`, `evexdata`
persist across restarts.

Required Dockerfiles at the repo root build context (referenced by compose):
`infra/vm-images/Dockerfile.api` (node build → api/worker/mcp),
`infra/vm-images/Dockerfile.console`, `infra/vm-images/Dockerfile.inference`
(python + torch CPU + `ml/`). Image tags pin the release version; `latest`
is never deployed.

## Guest images

Build once per base rotation with `infra/vm-images/build.sh`, publish the
qcow2 + `<image>.build.json` digest file to the artifact bucket, and point
`VmSpec.image` at the new name. Guests are cattle: any VM can be destroyed
and reprovisioned from the snapshot without losing platform state (traces
live in Postgres/objects, not in guests).

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
