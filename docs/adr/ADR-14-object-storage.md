# ADR-14: S3-compatible object storage (Garage v2, not MinIO)

Date: 2026-10-02. Status: accepted. Context: production qualification.

## Finding

MinIO open-source distribution is dead upstream:

- `docker pull minio/minio` (any tag tried: `latest`,
  `RELEASE.2025-09-07T16-13-09Z`): `pull access denied ... may require
  'docker login'` despite valid Hub credentials (other repos pull fine).
- `https://dl.min.io/server/minio/release/linux-amd64/minio`: HTTP 410 Gone
  with body "The open-source MinIO Server ... [is] archived and no longer
  maintained."
- `https://api.github.com/minio/minio/releases/latest`: HTTP 404.
- Docker Hub API for `minio/minio` tags: `{"message":"object not found"}`.

MinIO OSS cannot be acquired through any approved public channel. Pinning a
dead distribution would make the deployment unreproducible by construction.

## Decision

Deploy Garage v2 (`dxflrs/garage:v2.0.0`, digest-pinned at deploy time) as
the S3-compatible object store. Rationale:

- Actively maintained (upstream pushes observed 2026-10-02), Apache-2.0,
  single static binary, ~20 MB image, sqlite metadata backend suitable for
  single-node production.
- Speaks the S3 API, which is the actual contract surface EVE-X deployment
  needs (buckets, versioned-style overwrite semantics, typed errors).
  No EVE-X application code speaks vendor-specific APIs: the control plane
  remains file-primary with deployment-level object storage, so this change
  touches deployment only (compose service, env template, bring-up scripts).
- If an operator supplies MinIO through private channels, the deployment
  accepts any S3 endpoint via `OBJECT_ENDPOINT`; nothing is MinIO-specific
  in code.

## Qualification (all executed, not asserted)

- `infra/deployment/object-storage/bring-up.sh`: config from template with
  deploy-time secrets (0600), layout assign/apply, key + bucket provisioning.
- `infra/qualification/object-qual.py`: 9/9 — upload, sha256-verified
  download, prefix list, overwrite, NoSuchKey, AccessDenied on bad creds,
  tamper-evident digests.
- Restart persistence: container restart → identical bytes + digest.
- Backup/restore: data+meta dirs copied out, instance destroyed, dirs
  restored into a clean instance, objects byte-identical
  (`qual/shot.png` sha256 `fbbab289f7f94b25…` before and after;
  release rehearsal evidence: `artifacts/release/garage-backup-restore.json`).
- Rejected weak secrets: Garage refuses non-hex RPC secrets at startup
  (observed during qual; bring-up generates 64-hex).

## Consequences

- `docker-compose.yml` garage service replaces minio; `OBJECT_ENDPOINT`
  default `http://garage:3900`; `miniadata` volume replaced.
- Operators must generate `GARAGE_RPC_SECRET`/`GARAGE_ADMIN_TOKEN` at deploy
  time; the template contains placeholders only.
