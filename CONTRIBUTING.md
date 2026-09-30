# CONTRIBUTING

## Ground rules

- One npm package, strict TS, ESM NodeNext. Run `npx tsc --noEmit` before
  every push; keep imports to `protocol` / `core` / `model-registry` plus
  local modules.
- Production code contains no unchecked types and no dead scaffolding:
  schemas validate at boundaries, errors carry codes, logs carry reasons.
- Python scripts use stdlib + declared deps only, guard optional imports
  with actionable messages, and always offer a fast dependency-free check
  (`--smoke`, `--help`) that CI can run without GPUs or downloads.
- Numbers are measured: tests assert behavior, eval reports counted metrics,
  training writes computed losses. Imputed or hand-written expected values
  in committed artifacts are a review blocker.

## Workflow

1. Open an issue describing the change and its evidence (failing test,
   benchmark delta, reviewer report).
2. Branch from `main`; keep the diff scoped to one plane (api, ml, infra,
   docs).
3. Add or update `tests/*.test.ts` (`node:test`, relative imports to
   `../packages/...`) and, for structural choices, a docs ADR.
4. Verify: `npm install --no-audit --no-fund && npx tsc --noEmit`,
   relevant `node --test` suites, `python --version`, and the ML
   `--smoke`/`--help` paths you touched.
5. Open a PR with the verification output pasted in; a maintainer merges
   after CI (typecheck, tests, secret scan, compose build) is green.

## Docs

Every user-visible behavior needs a home in the `*.md` guides; ADRs record
*why*, guides record *how*. Update both when behavior changes — a code-only
PR that contradicts the guides will be sent back.
