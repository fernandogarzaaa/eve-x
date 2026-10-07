# THREAT MODEL

Scope: the EVE-X control plane, worker, inference service, VM fleet, dataset
and training pipelines, and the MCP/skill surfaces. Out of scope: the public
internet at large, reviewer endpoint devices (covered by operator policy).

## Actors

| Actor | Capability | Trust |
|---|---|---|
| Operator / admin | Full console + API | Trusted, authenticated |
| Human reviewer | Judgments, takeover | Semi-trusted, blinded |
| Evaluated agent | Screen + grounded actions inside one VM | **Untrusted** |
| Skill author | Markdown + declared tools | **Untrusted** until verified |
| External network | Arbitrary content via allowlisted egress | **Untrusted** |

## Threats and mitigations

1. **Guest escape (agent breaks out of the VM).**
   Guests run under QEMU/KVM with `-sandbox
   on,obsolete=deny,elevateprivileges=deny,spawn=deny,resourcecontrol=deny`,
   per-VM CoW overlays over a pinned read-only base (boot refuses on
   `BASE_MUTATED`), VNC bound to 127.0.0.1, and per-VM port triples. Live
   escape probes from inside a real guest (`artifacts/qualification/
   escape-probes.json`): cloud metadata blocked, no QMP socket visible in
   guest, no host secrets present, host loopback unreachable from guest.
   User-mode NAT gateway (10.0.2.2) is reachable by design and documented;
   `network: none` removes it entirely. Mitigation strength: containment +
   snapshot restore + `FAILED` state quarantine. Full escape research
   (device fuzzing, virtio attack surface) remains specialized future work —
   not claimed.

2. **Prompt injection from screen content.**
   Web pages and documents rendered in the guest are untrusted data. The
   verifier grounds actions to detected regions and confidence gates; the
   policy gate denies credential use and external comms by default, so an
   injected "send password" instruction fails closed.

3. **Credential exfiltration via actions.**
   `type` payloads are length-bounded (4096 chars); credential-adjacent goals
   require `allowCredentialUse`; dataset redaction strips secrets before they
   reach training. Trace exports are capability-gated.

4. **Malicious skill (rogue SKILL.md / tool wiring).**
   `packages/skills` verifies manifest validity (name format + match with
   directory), entrypoint frontmatter (name/description agreement), and
   tool documentation before install; platform paths are user-scoped, and
   skills inherit only the installing caller's capabilities.

5. **Training-data poisoning.**
   Provenance-preserving splits plus sha256 digests per split file
   (`digest.json`) make post-hoc tampering detectable; held-out tasks are
   quarantined from training reads (`tests/benchmark-split.test.ts`), and
   promotion requires held-out evidence.

6. **Benchmark gaming (overfit to test split).**
   Genesis evaluates integrity (held-out grounding, lineage) separately from
   performance (`tests/genesis.test.ts`); production promotion demands both,
   with a human approval token — there is no automatic path. Platform
   benchmarks execute real sessions (no inline synthetic agent exists);
   mock evidence is refused in production runs and stamped in harness runs;
   inconclusive/invalid are counted, never coerced into success.

7. **Inference DoS / GPU failure cascade.**
   The inference service enforces a bounded queue (429 when full) and
   per-request timeouts (504 on expiry). Model-load failures leave it NOT
   READY (`/ready` 503, `/infer` 503 `model-not-loaded`) while `/health`
   stays green, so the control plane sheds load with explicit 502s and
   inconclusive verdicts instead of crashing — never silent heuristic
   output labeled as model output. Bearer auth on `/infer` + `/model-info`
   when configured; internal-only topology (no published port).

8. **Token theft / replay.**
   Bearer tokens travel only over loopback or TLS-terminated ingress
   (nginx sidecar pattern qualified live: TLS 1.3 + WSS through the proxy,
   `infra/deployment/tls/`); mutating `act` calls carry idempotency keys so
   replays collapse to a single execution. HMAC guest channels enforce a
   ±60 s timestamp window (boundary-tested); worker leases add epoch fencing
   so clock skew cannot cause silent double ownership.

9. **Stale screen action (act on a changed VM).**
   Actions bind `expectedFrameId`; the runtime and the API both reject
   mismatches with 409 + current frame (live-verified), so a model can never
   act on a screen it has not just seen.

10. **Evidence forgery (fake success, tampered traces).**
   Trace steps carry server-stamped SHA-256 chains; replay verifies
   sequence + chain and flags legacy digests; task validation derives
   verdicts only from server-resolved evidence (PASS needs independent
   confirmation); the worker cannot write verification or success. The
   adversarial suite (`tests/adversarial-evidence.test.ts`) covers
   mutation/reorder/deletion/duplication/stale-replay/idempotency-abuse.

## Residual risks

- Screenshots may capture reviewer PII during takeover; mitigated by
  capability-gated exports and bucket retention policy, not eliminated.
- A compromised base cloud image would propagate to all guests; mitigated by
  pinned URLs + recorded sha256 digests, requiring operator verification on
  base rotation.
