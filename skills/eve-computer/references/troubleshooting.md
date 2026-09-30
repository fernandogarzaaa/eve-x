# Troubleshooting

- `401 unauthorized`: set `EVEX_AUTH_TOKEN` (CLI) or pass the token header.
- `409 human_control`: a reviewer holds the session — wait for `release`.
- Empty `regions`: the frame is loading; `wait` 500ms and re-observe.
- Low confidence (<0.5): `zoom`/`crop` the area, then re-ground.
- Stream stalls: reconnect `/v1/stream/:sessionId`; trace JSONL under
  `data/objects/traces/` is the source of truth.
- VM `FAILED`: snapshot-restore to `clean`, then fork a fresh VM for bisection.
