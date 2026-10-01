# EVE-X — Isolated-VM Computer-Use Experience Validation

EVE-X runs AI agents inside isolated virtual machines, watches them use a real
desktop the way a person would (screenshot in, grounded UI action out), and
scores the experience with statistical rigor plus blinded human judgment.

## What it does

1. **Provisions isolated guests** — on Linux production hosts, every
   evaluation task boots from a clean, reproducible qcow2 snapshot (see
   `VM.md`, `infra/vm-images/build.sh`, `infra/deployment/linux-bootstrap.sh`
   for the KVM/QEMU setup). On Windows dev machines there is no KVM/QEMU
   backend, so the platform runs against the synthetic/process fallback —
   guest isolation there is *not* VM-grade. Do not treat dev-host runs as
   isolation evidence.
2. **Drives computer use** — the agent observes screenshots with detected UI
   regions and emits `ActionIR` actions (click, type, drag, …) that the
   verifier grounds before execution (see `COMPUTER_USE.md`).
3. **Records everything** — an append-only trace ledger captures percepts,
   candidate actions, grounding, verification, and outcomes (see `ARCHITECTURE.md`).
4. **Validates the experience** — seeded population studies, blinded human
   review, and benchmark gates decide ship / no-ship (see `HUMAN_VALIDATION.md`,
   `BENCHMARKS.md`).

## Repository layout

| Path | Contents |
|---|---|
| `packages/protocol` | Canonical zod schemas: ActionIR, percepts, traces, VM/task specs |
| `packages/core` | IDs, deterministic PRNG, audited state machines, error type |
| `packages/mcp-shared` | Shared MCP tool schemas + control-plane HTTP client |
| `packages/skills` | Agent-skill installer / verifier |
| `packages/model-registry` | Versioned model records, gated promotion |
| `ml/training` | SFT + grounding-head + verifier + preference training (`train.py`) |
| `ml/datasets` | Trajectory → dataset pipeline (`build.py`) |
| `ml/evaluation` | Benchmark eval runner (`eval.py`) |
| `ml/inference` | Inference HTTP service (`server.py`) |
| `infra/deployment` | `docker-compose.yml` local deploy (api/worker/mcp/console/postgres/redis/minio/inference) |
| `infra/vm-images` | qcow2 image build script + cloud-init seed |
| `infra/observability` | Prometheus scrape config |
| `apps/api` | `openapi.json` — versioned (`/v1`) public API definition |
| `tests` | `node:test` suites covering state machines, IR, verifier, traces, replay, policy, determinism, authz, splits, genesis |
| `docs/adr` | Architecture decision records ADR-01 … ADR-13 |

## Quick start

```bash
# 1. Typecheck everything (single npm package, strict TS, NodeNext)
npm install --no-audit --no-fund
npx tsc --noEmit

# 2. Run the test suites
npx tsc -p tsconfig.build.json   # build first if dist/ is used by your runner
node --test dist/tests/*.test.js

# 3. Reproducible local deploy
cp .env.example .env   # set EVEX_AUTH_TOKEN, POSTGRES_PASSWORD
docker compose -f infra/deployment/docker-compose.yml up --build

# 4. ML smoke test (CPU-only, <60s, no dataset needed)
python ml/training/train.py --smoke --out out/smoke
python --version  # sanity: scripts target stock Python 3.10+
```

## Key contracts

- **Protocol is law.** `packages/protocol` is the single schema authority;
  the API, MCP tools, traces, and datasets all validate against it.
- **Nothing auto-promotes.** Model promotion to staging/production requires a
  human approval token plus passing test *and* held-out benchmark gates.
- **Numbers are measured, never invented.** The eval runner fails loudly on
  missing predictions instead of imputing scores; training writes only metrics
  it computed.
- **Humans stay in the loop.** Destructive, purchase, and data-export actions
  escalate; blinded reviewers score reasonableness, targeting, and recovery.

Further reading: `ARCHITECTURE.md` → `DEPLOYMENT.md` → `OPERATIONS.md`.
Security posture: `SECURITY.md` + `THREAT_MODEL.md`.

## Platform split

- **Windows (dev):** `npm run build`, `npx tsc --noEmit`, `node --test`,
  `eve-x doctor`, ML smoke tests. No KVM, no systemd, no containers required.
- **Linux (prod):** `infra/deployment/linux-bootstrap.sh` (Ubuntu 24.04+,
  KVM/QEMU, systemd units `evex-api/worker/mcp/console`), plus the compose
  stack in `infra/deployment/docker-compose.yml`. Only Linux hosts provide
  real VM isolation.
