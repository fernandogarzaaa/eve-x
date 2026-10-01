# Troubleshooting

- `401 unauthorized`: set `EVEX_AUTH_TOKEN` (CLI) or pass the token header.
- `403 forbidden`: the token lacks the capability (see `policy.md`), or the
  session/VM belongs to another tenant.
- `409 human_control`: a reviewer holds the session — wait for `release`.
- `409 stale_perception`: re-observe and retry with the fresh `frameId`.
- Empty `regions`: the frame is loading; `wait` 500ms and re-observe.
- Low confidence (<0.5): `zoom`/`crop` the area, then re-ground.
- Stream stalls: reconnect `/v1/stream/:sessionId`; trace JSONL under
  `data/objects/traces/` (or `$OBJECT_DIR/traces/`) is the source of truth.
- VM `FAILED`: snapshot a known-good state first
  (`POST /v1/vms/{id}/snapshot` with a label — restoring a label that was
  never snapshotted returns `404 snapshot_not_found`), restore that label,
  then fork a fresh VM for bisection.
