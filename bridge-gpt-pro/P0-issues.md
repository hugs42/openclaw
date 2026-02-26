# P0 Issues — Ready to create (gpt-pro-bridge)

This backlog follows the locked order from `P0-freeze.md`.

---

## P0-01 — Harden SSE lifecycle and add golden tests

**Why**  
SSE is the critical contract surface for OpenAI-compatible streaming clients.

**DoD**

- [ ] `text/event-stream` framing is deterministic (chunk structure + ordering).
- [ ] Terminal `[DONE]` is emitted exactly once for successful streams.
- [ ] Mid-stream errors are represented consistently.
- [ ] Client disconnect closes stream resources cleanly.
- [ ] Golden tests cover: normal stream, abort, mid-stream error.

**Dependencies**: none  
**Risk if skipped**: broken SDK clients, hung streams, silent regressions  
**Labels**: `P0`, `streaming`, `contract`, `tests`

---

## P0-02 — Implement abort propagation end-to-end

**Why**  
Without full cancellation propagation, timed out/disconnected requests continue running.

**DoD**

- [ ] `AbortSignal` from HTTP layer is propagated into queue jobs.
- [ ] Queue cancellation reaches UI automation call path.
- [ ] Extraction loop exits on abort without resource leak.
- [ ] Integration test proves `HTTP -> queue -> UI -> extract` cancellation.

**Dependencies**: P0-01  
**Risk if skipped**: zombie jobs, memory leaks, UI contention  
**Labels**: `P0`, `abort`, `reliability`

---

## P0-03 — Unify error taxonomy and OpenAI-compatible mapping

**Why**  
Clients need stable status codes and retry semantics.

**DoD**

- [ ] Single internal error taxonomy (retryable/non-retryable).
- [ ] Consistent mapping to HTTP status + OpenAI-style error body.
- [ ] Retry hints are deterministic (`retry-after`, optional retry header strategy).
- [ ] No internal stack traces leak in production responses.
- [ ] Contract tests assert mapping for key classes (timeout, queue full, auth, UI errors).

**Dependencies**: P0-01, P0-02  
**Risk if skipped**: bad client behavior, noisy support/debug loops  
**Labels**: `P0`, `errors`, `api-contract`

---

## P0-04 — Centralize timeout/retry/abort behavior in HTTP client path

**Why**  
Transport behavior must be bounded and consistent.

**DoD**

- [ ] One central utility controls timeout/retry/backoff/jitter/abort behavior.
- [ ] `openaiRoutes` adopts the utility (no duplicated ad-hoc logic).
- [ ] Retry policy is bounded and class-aware.
- [ ] Tests cover timeout path + retry stop conditions.

**Dependencies**: P0-03  
**Risk if skipped**: inconsistent behavior, hard-to-debug tail failures  
**Labels**: `P0`, `http`, `timeouts`, `retry`

---

## P0-05 — Make queue explicitly backpressure-first

**Why**  
Queue saturation should fail predictably, not degrade the UI/runtime.

**DoD**

- [ ] Queue is bounded (`maxQueueSize`) and rejects excess deterministically.
- [ ] Per-job timeout is enforced.
- [ ] Failures are isolated (no poisoning subsequent jobs).
- [ ] Minimal DLQ artifact exists for failed jobs (JSONL acceptable for P0).
- [ ] Load test proves no deadlock under bounded pressure.

**Dependencies**: P0-02, P0-04  
**Risk if skipped**: flakiness, saturation, starvation  
**Labels**: `P0`, `queue`, `backpressure`

---

## P0-06 — Add smoke E2E suite for critical endpoints

**Why**  
Need a fast gate that catches integration regressions before merge.

**DoD**

- [ ] Smoke covers `/health`, `/v1/models`, `/v1/chat/completions` non-stream.
- [ ] Smoke covers `/v1/chat/completions` stream with `[DONE]` assertion.
- [ ] Smoke covers `/v1/bridge/conversations`.
- [ ] Suite runs in CI and blocks merge on failure.

**Dependencies**: P0-01, P0-03, P0-05  
**Risk if skipped**: regressions reach main unnoticed  
**Labels**: `P0`, `e2e`, `ci`

---

## P0-07 — Add Idempotency-Key and dedup TTL (critical non-stream paths)

**Why**  
Prevent duplicate execution on retries and transient network repeats.

**DoD**

- [ ] Idempotency-Key support for non-stream completion path.
- [ ] Dedup TTL store prevents duplicate execution.
- [ ] Replayed request with same key returns consistent response behavior.
- [ ] Tests cover replay + collision mismatch handling.

**Dependencies**: P0-03, P0-05, P0-06  
**Risk if skipped**: duplicate actions/responses, inconsistent state  
**Labels**: `P0`, `idempotency`, `reliability`

---

## P0-08 — UI state-machine hardening (scoped)

**Why**  
Finalize reliability after transport/queue contract is stabilized.

**DoD**

- [ ] Explicit handling for stuck-generating/focus/retry edge cases.
- [ ] Timeouts and recovery paths are deterministic.
- [ ] No double-submit under retry conditions.
- [ ] Tests (or deterministic harness checks) cover high-risk UI transitions.

**Dependencies**: P0-01, P0-02, P0-05, P0-06  
**Risk if skipped**: residual flakiness despite backend stabilization  
**Labels**: `P0`, `ui-automation`, `stability`

---

## Merge order (enforced)

`P0-01 -> P0-02 -> P0-03 -> P0-04 -> P0-05 -> P0-06 -> P0-07 -> P0-08`
