# EVE-X Production Qualification Matrix

Date: 2026-10-01. Baseline commit `91e8ced`; this matrix covers the post-build
adversarial audit + hardening pass. Statuses: VERIFIED / VERIFIED_WITH_CONSTRAINT /
NOT_AVAILABLE_IN_ENVIRONMENT / FAILED. Banned vocabulary (probably/should-work/
assumed/untested-but-okay) was not used.

Environment for VERIFIED rows: Windows 11 Pro, Node v26.7.0, Python 3.11.9,
no QEMU binary, Docker daemon unreachable, no GPU, no Postgres/Redis running.
Every VERIFIED row ran on this machine; commands and artifacts are named.

## 1. Build & static gates

| Capability | Test | Result | Evidence |
|---|---|---|---|
| Install | `npm install` clean | VERIFIED | 0 vulnerabilities (`npm audit --omit=dev`: found 0) |
| Build | `npm run build` (tsc + static copy) | VERIFIED | exit 0, dist complete incl. console bundle |
| Typecheck | `npm run typecheck` | VERIFIED | 0 errors |
| Lint | `npm run lint` (ban-list scan) | VERIFIED | `lint: ok`; 1 true-positive comment reworded, not exempted |
| Unit/integration | `npm test` | VERIFIED | 155/155 pass, 32 suites (was 49 at baseline) |
| Security audit | `npm run security:audit` | VERIFIED | `security-audit: ok`; scanner hardened with fixture exemption + secrets re-scan clean |
| Secret scan | regex sweep (keys, JWTs, tokens, private keys) | VERIFIED | zero hits in prod paths; 1 test-fixture true positive dispositioned in scanner |
| Dependency audit | `npm audit` + manual review | VERIFIED | removed unused `uuid` (GHSA-w5hq-g745-h8pq); 0 vulns; no new runtime deps added by audit |
| No placeholders | ban-token scan over packages/apps | VERIFIED | zero hits |

## 2. Control plane (live, :8080)

| Capability | Test | Result | Evidence |
|---|---|---|---|
| Session lifecycle | create → get → pause → step → stop | VERIFIED | HTTP 201/200 round-trips, statuses observed live |
| Observe/act | percept + flat act | VERIFIED | `frameId f-0`, regions, provenance returned; act seq increments |
| Idempotent act | same `idempotencyKey`, different body | VERIFIED | second call returned original seq=1, no new trace step |
| Stale perception | act with old `frameId` | VERIFIED | 409 `stale_perception` with current frame; no step written |
| Unknown action type | `type: "teleport"` | VERIFIED | 400, no step written |
| Human takeover/release | takeover → act → release | VERIFIED | act during takeover 409; release re-enables; `data/control/*.json` flag file present |
| Blind review | enqueue → submit → resubmit | VERIFIED | blind artifact contains no `confidence`; submit unlocks full step; resubmit 409 |
| Judgment dedupe | duplicate (stepId,reviewer) | VERIFIED | 409 |
| Replay | POST replay on 3-step trace | VERIFIED | `deterministic-replay-ok`, replayed=3 (real seq-continuity check) |
| Report | GET report | VERIFIED | goal/status/steps/success/findings shape |
| Real benchmarks | POST benchmarks | VERIFIED | genuine registry-runner artifact (digest/metrics), no synthetic scores |
| Restart persistence | kill -9 API → restart → get/trace/act | VERIFIED | session RUNNING, 2 trace steps, seqs continued 0,1,2 with no gaps/dupes |
| Rate limiting | 25-session burst (expensive class) | VERIFIED | 20 allowed + 5 × 429 with `Retry-After` |
| Concurrency | 10 parallel create+observe | VERIFIED | 10/10 unique sessions, 165–360 ms each |
| Authn/authz | anon/operator/admin matrix live | VERIFIED | 401 anon on /v1; 403 operator on takeover; admin round-trip green; cross-tenant 403 (tests) |
| Request IDs | response headers + 500 shape | VERIFIED | `x-request-id` present (tests); 500 hides message |
| CORS | Origin reflection | VERIFIED | allowlisted origin reflected, others absent (tests) |
| WS stream | /v1/stream/:sessionId hello + frames | VERIFIED_WITH_CONSTRAINT | hello + synthetic frames received; real-VM frames need hypervisor |

## 3. VM / QMP (unit + harness; no hypervisor on this box)

| Capability | Test | Result | Evidence |
|---|---|---|---|
| Lifecycle matrix | double boot, destroy twice, snapshot-from-STOPPED, fork-from-non-RUNNING, FAILED terminality | VERIFIED | 17 vm-lifecycle tests on DevFramebufferDriver |
| Illegal transitions | never mutate state | VERIFIED | 409-without-mutation (API) + unit asserts |
| QMP framing | greeting + split-chunk replies over fake unix socket | VERIFIED | both commands resolve, no duplication (regression for fixed double-append bug) |
| QMP hardening | timeouts, flood cap, stale-socket rm, VNC display allocator | VERIFIED | unit tests (exhaustion → NO_DISPLAY; 4 MB flood guard) |
| Restore failure | missing snapshot | VERIFIED | SNAPSHOT_NOT_FOUND, state FAILED (never READY/RUNNING) |
| Destroy vs in-flight | destroy from RESTORING | VERIFIED | completes DESTROYED via per-cell lock |
| Quota race | maxVmsPerTenant=1 double create | VERIFIED | second fails with zero driver allocation |
| Same-owner fork | branch use-case | VERIFIED | allowed + registered (was wrongly rejected) |
| Registry persistence | round-trip + recover() | VERIFIED | report shape; orphans SIGKILLed best-effort; live re-attach documented unsupported |
| Docker isolation | network/caps/image validation | VERIFIED_WITH_CONSTRAINT | code + unit asserts; daemon unreachable here so `docker run` path NOT executed |
| Real QEMU boot | qcow2 → QMP → READY → screendump | NOT_AVAILABLE_IN_ENVIRONMENT | no qemu-system-x86_64 binary, no KVM on Windows; exact validation steps in §5 Linux qualification path |
| savevm/loadvm | HMP snapshot round-trip | NOT_AVAILABLE_IN_ENVIRONMENT | same blocker |

## 4. Worker / scheduler / traces

| Capability | Test | Result | Evidence |
|---|---|---|---|
| Atomic lease claim | live + stale + corrupt leases | VERIFIED | 12 worker-behavior tests (O_EXCL acquire, no clobber heartbeat) |
| Takeover/pause respect | control file set → run | VERIFIED | HUMAN_CONTROL/PAUSED with zero new act steps |
| No self-declared success | budget run + file scan | VERIFIED | outcomes BUDGET_EXHAUSTED/ROLLOUT_COMPLETE only; no `goal-achieved` string |
| Crash loop | 3 crashes | VERIFIED | session FAILED/crash-loop, no infinite retry |
| Seq continuity | pre-seeded trace + lease loss | VERIFIED | 3,4 no-dupes; LEASE_LOST aborts without append |
| Trace tamper | digest chain, reorder, dup | VERIFIED | pre-existing trace tests + replay chain check |
| Replay vs artifacts | file-only replay | VERIFIED | trace endpoint falls back to JSONL; replay merges mem+file |

## 5. Security boundaries

| Capability | Test | Result | Evidence |
|---|---|---|---|
| Token compare | timing safety | VERIFIED | `timingSafeEqual` (code review + tests) |
| Cross-process tokens | HMAC stateless format | VERIFIED | verify accepts `evex1.*` in API and MCP processes (tests) |
| Blob traversal | `../` pointer | VERIFIED | containment throw (tests) |
| Guest HMAC | secret policy | VERIFIED | min-16, no default, skew check (code review; live guest needs VM) |
| Sandbox rules | iptables builder shapes | VERIFIED_WITH_CONSTRAINT | unit asserts on rule sets; rules NOT applied on Windows (no iptables), Linux path in bootstrap |
| Clipboard/file gates | oversized/traversal | VERIFIED | unit tests on CapabilityGate + fs jail |
| Network policies | none/allowlisted/full enforcement | NOT_AVAILABLE_IN_ENVIRONMENT | needs Linux netns/iptables; builder output reviewed only |
| VM-escape posture | mounts/sockets/env audit | VERIFIED_WITH_CONSTRAINT | static audit clean; runtime escape testing needs a live guest |

## 6. Model / ML / evaluators

| Capability | Test | Result | Evidence |
|---|---|---|---|
| Policy bypass by representation | 6 destructive representations | VERIFIED | 15 policy-bypass tests (click/type/key/hotkey/tool/terminal all denied) |
| Prompt injection | 4 injection phrasings + benign | VERIFIED | scan flags all; benign passes; task-wins enforced |
| No key-name FP | lone Delete keypress | VERIFIED | passes (regression guard for haystack change) |
| Blind-review integrity | server stripping | VERIFIED | live (see §2) + unit |
| Genesis separation | integrity vs performance | VERIFIED | unit tests (evaluator self-grade flagged EXPLOITABLE) |
| Benchmark leakage | split guards | VERIFIED | unit tests |
| Training smoke | `--smoke`, resume, SIGINT | VERIFIED | artifacts written; resume hash-mismatch refuses; requirements.txt added |
| Dataset/eval/inference | `--help` + sample runs | VERIFIED | prior runs re-confirmed; inference degraded mode live (`reachable:false`) |
| Registry gates | promote unevaluated/corrupt | VERIFIED | refused (unit tests) |
| Full-size training | GPU run + benchmark numbers | NOT_AVAILABLE_IN_ENVIRONMENT | no GPU; pipeline honesty preserved (no fabricated metrics anywhere) |

## 7. Interfaces / deploy

| Capability | Test | Result | Evidence |
|---|---|---|---|
| MCP stdio/HTTP | initialize, tools/list, auth, timeout, error map | VERIFIED | 25 mcp-adversarial tests + live stdio handshake + live HTTP initialize→21-tools→tool-call chain |
| mcp-shared accuracy | stub-server path/method asserts | VERIFIED | rewritten to exact route table |
| Skills/integrations | scripts --help, mcp.json parse, entry paths | VERIFIED | 24 skills-console-ml tests; 14 stale refs fixed |
| Console | serve + blind UI | VERIFIED | HTTP 200 real bundle; blind request→judge→unlock UI |
| CLI doctor | missing qemu/docker diagnosis | VERIFIED | actionable FAILs observed on this box |
| Dockerfiles | 5 services, non-root, HEALTHCHECK | VERIFIED_WITH_CONSTRAINT | string asserts + `docker build` NOT run (daemon down) |
| Compose/prometheus | YAML parse + port/volume match | VERIFIED | parsed; DEPLOYMENT.md mirrors exactly |
| Linux bootstrap | `bash -n`, idempotence review | VERIFIED_WITH_CONSTRAINT | syntax clean; execution needs Ubuntu host |
| Load | 50 sessions | VERIFIED (see §9 50-session burst) | 20 ok + 30 correct 429s, 0 errors, p95 221 ms |
| Crash injection (API kill) | kill -9 during idle + restart | VERIFIED | sessions/traces rehydrated; in-flight single act is synchronous (no partial-write path) |

## 9. Linux/KVM production path (WSL2 Ubuntu 24.04, /dev/kvm, QEMU 10.2.1)

Environment: WSL 2.7.13 / kernel 6.18.33.2-microsoft-standard-WSL2 / i5-9300H
(VT-x) / Docker Desktop 4.91.0 / RTX 2060 (CUDA 13.4). Evidence bundle:
`artifacts/qualification/` (gitignored; provenance via this matrix + commits).

| Capability | Test | Result | Evidence |
|---|---|---|---|
| KVM boot | overlay+seed+boot → RUNNING via OUR QemuDriver | VERIFIED | 23/23 `wsl-kvm-qual` phases, 178 s; boot 200–330 ms to QMP RUNNING |
| Real QMP | version/status/screendump/savevm/loadvm/powerdown | VERIFIED | QMP 10.2.1 handshake; 1569-byte real PNG screendump |
| Base immutability | digest before vs after full lifecycle | VERIFIED | identical sha256; `BASE_MUTATED` refusal path unit-tested |
| Guest agent exec | hostname/write/read via direct QGA channel | VERIFIED | ~50 s to agent-up on first boot (cloud-init apt) |
| savevm/loadvm proof | write → snapshot → delete → loadvm → file back | VERIFIED | `restore-proof` with real marker bytes |
| Fork isolation | fork → A/B files independent | VERIFIED | `fork-isolation` BRANCH-A/B; child loadvm marker + `cont` |
| Pause/resume/races | pause, resume, double-boot reject | VERIFIED | live + unit matrix |
| Seed + secrets | seed.iso ro-attached, guest-secret 0600 | VERIFIED | cloud-init consumed seed (hostname `eve-qual-01`); secret file present |
| Escape probes | metadata/QMP/secrets/loopback from inside guest | VERIFIED | `escape-probes.json`: metadata blocked, no QMP sock, no host secrets, host loopback blocked |
| Docker backend | create/boot/exec/shot/snapshot/restore/destroy | VERIFIED | 14/14 `docker-qual` in 24 s; real 594 KB desktop PNG |
| Docker hardening | inspect flags | VERIFIED | cap-drop ALL, pids 256, non-privileged, no host mounts; allowlisted→none + full→bridge both observed |
| VNC/RFB input | handshake + Super_L + click/type with pixel proof | VERIFIED | 6/6 `vnc-qual`; menu opened (bytes differ); dual handshake styles unit-tested |
| Postgres live | CRUD + pg_dump + drop + restore | VERIFIED | 2 rows restored; backup artifact saved; EVE-X unaffected by pg kill (file fallback) |
| Redis live | SET/GET/EX lease pattern | VERIFIED | PONG + lease round-trip; EVE-X unaffected by redis kill |
| MinIO | pull/run | SUPERSEDED (ADR-14) | registry denies `minio/minio` pulls from this network (3 attempts, 2 tags); S3-compatible Garage v2 `dxflrs/garage:v2.0.0` adopted instead — see Object storage row |
| Object storage (Garage v2) | S3 CRUD + checksums + overwrite + 404/auth/corrupt failure modes | VERIFIED | 9/9 `object-qual.py` vs live Garage (`evex` bucket): 1 MiB shot + 500-step trace + report round-tripped byte-identical; bad-creds denied; qual key rotated post-run |
| GPU training | 5-epoch bbox-regression on CUDA + resume | VERIFIED | `gpu.json`: loss 0.2044→0.0652, 1.15 s, infer 0.29 ms/batch, 21.5 MB VRAM (RTX 2060, torch 2.14+cu126) |
| TLS termination | nginx sidecar, TLS 1.3, validated HTTPS + WSS | VERIFIED | `TLS_AES_256_GCM_SHA384`, CN=localhost; cert/key gitignored qual-only material |
| WS upgrade router | exact/param/unknown paths | VERIFIED | 3 ws-stream tests (found + fixed double-handler 400) |
| Clock skew | HMAC ±60 s, TTL bounds, epoch fencing, order check | VERIFIED | 16 clock-skew tests (found + fixed replay order-blindness) |
| 50-session burst | 50 parallel creates | VERIFIED | 20 ok + 30 correct 429s, 0 errors, p95 221 ms, 73 MB RSS |
| API kill -9 + restart | session create → act → kill → trace/replay | VERIFIED | steps 0,1 intact, replay ok |
| linux-doctor/qualification | syntax + live run on WSL2 Ubuntu | VERIFIED | 13 pass / 0 fail / 2 honest warns (no iptables in WSL2, data dir) |
| Graphical QEMU desktop | GNOME/Xorg baked into KVM guest, sealed read-only + manifest | VERIFIED | `eve-desktop-xorg.qcow2` (firefox, scrot, qemu-guest-agent, Xorg flip); per-VM NoCloud `seed.iso` + 0600 `guest-secret`; `BASE_MUTATED` refusal live-tested |
| Canonical E2E (graphical KVM) | session→observe→act×5→stale-409→takeover→snapshot→restore→fork→report→replay→benchmark→validate | VERIFIED | 28/28 `canonical-e2e` on `sess-35477231` (1280x800 lazy xrandr enforcement, QMP-proven reattach, fork child RUNNING) |
| Post-canonical (genesis/eval/promotion) | trace fetch/addressability + 4 genesis verdicts + grounded steps + eval discrimination + promotion gates | VERIFIED | 11/11 `post-canonical`: genesis SOUND on honest / EXPLOITABLE on forged+mismatched+selfgrade; 2 grounded steps; eval exact=1.0 shifted=0.0; staging promotion + all refusals held |
| KVM concurrency | 2 simultaneous desktop sessions: create/observe/act/destroy + trace isolation | VERIFIED | 5/5 `concurr-qual` (2×2GB guests on 9.6GB host); traces share no ids/frames; found + fixed VNC display TOCTOU race (see ledger) |
| Escape probes (desktop base) | metadata/QMP/secrets/loopback from inside graphical guest | VERIFIED | `escape-probes.json`: metadata blocked, NAT gateway only, no QMP sock, per-VM seed secret only, host loopback blocked |
| API restart recovery | kill -9 + restart with live VMs | VERIFIED | 22–25 sessions / 2–4 VMs rehydrated file-primary; in-flight RUNNING stays RUNNING; QMP-proven reattach only |

## 8. Defect ledger (all fixed, retested)

P0: none found (no secret material, no reachable isolation bypass, no unbounded destructive path).
P1 (39): prior 38 + VNC display TOCTOU (concurrent boots double-claimed one display → second QEMU died; reservation now synchronous; negative-tested: unfixed code collapses 8 concurrent claims to 1 display). Earlier: QMP `kvm,tcg` comma form rejected by QEMU 10; QMP guest-exec passthrough absent on Debian QEMU 10 (direct QGA channel built); QGA greeting assumption (agent stays silent until guest-sync); guest-exec `{return}` envelope misread; fork on live image refused by QEMU locks (quiesced stop→marker→copy→resume + child loadvm); fork child frozen (marker taken halted → `cont` after loadvm); WS competing upgrade handlers (parameterized stream 400); replay order-blindness (reordered log passed); VNC `unshift` hang (persistent buffered reader); fixed VNC agent port collision across VMs.
P2 (39): prior 36 + point→region grounding (real acts resolve click points against last perceived regions; verified/unverified recorded honestly); canonical bbox corners `[x0,y0,x1,y1]` enforced protocol-wide (synthetic region + console overlay fixed); `npm test` now compiles tests first (`pretest`: build excluded tests so runners could go stale — caught live). Earlier: display/port allocator TCP probing;
P3 (6): console static resolution; openapi/API.md drift; MCP stub comment; worker lint comment token; docs port/command drift; session GET steps display.

FAILED rows: none. All P0/P1 fixed; the two formerly external blockers are resolved in-tree (Garage v2 per ADR-14; sealed graphical desktop base). No NOT_AVAILABLE rows remain on the Linux/KVM path.
