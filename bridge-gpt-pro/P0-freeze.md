# P0 Freeze — gpt-pro-bridge

**Status:** ACTIVE  
**Date:** 2026-02-26 18:38 (Europe/Paris)  
**Window:** 48h  
**Owner:** Lead Dev  
**Source of truth:** CTO analysis based on attached reports (`memory/2026-02-26-cto-audit.md`, `memory/2026-02-26-execution-plan.md`)

---

## 1) Goal (P0 only)

Stabilize the bridge so OpenAI-compatible behavior is reliable in real usage:

- correct SSE lifecycle,
- deterministic error mapping,
- abort propagation end-to-end,
- queue behavior under pressure,
- measurable E2E validation.

---

## 2) Non-goals (strict)

- No structural refactor of the whole app.
- No shared completion-core architecture rollout during P0.
- No broad UI automation redesign beyond reliability fixes tied to P0 failures.

---

## 3) Canonical CTO findings locked for P0

1. SSE is the most fragile surface and must be hardened first.
2. Abort must propagate from HTTP request down to queue/UI/extraction.
3. Error taxonomy and OpenAI mapping must be unified before further hardening.
4. Queue must be explicitly backpressure-first (bounded, timeouted, isolated failures).
5. Process noise must be reduced (single canonical plan file, measurable acceptance).

---

## 4) Locked critical sequence (cannot change without explicit sign-off)

1. **P0-01 — SSE hardening + golden tests**
2. **P0-02 — Abort propagation end-to-end**
3. **P0-03 — Unified error taxonomy + OpenAI mapping**

> UI-focused hardening and factorization are **after** these three items.

---

## 5) Global acceptance gate for P0 exit

P0 is considered complete only if **all** pass:

1. Stream tests pass with strict framing checks + terminal `[DONE]` behavior.
2. Abort test proves cancellation path `HTTP -> queue -> UI -> extract`.
3. Error mapping responses are deterministic and OpenAI-compatible.
4. Queue pressure tests show no deadlock/leak under bounded load.
5. Smoke E2E passes for `/health`, `/v1/models`, `/v1/chat/completions` (stream/non-stream), `/v1/bridge/conversations`.

---

## 6) Execution policy

- One issue = one PR.
- Small PRs, merge in locked order.
- No scope creep.
- Every PR must include DoD evidence (tests/logs/acceptance notes).
