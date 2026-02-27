# V1_ISSUES_GITHUB_DRAFT.md

Version issue-ready du backlog V1 (à créer en 12 issues), dérivée des directives CTO r4.

## Issue 01 — Freeze baseline MCIT + extraction manifest

- **Title**: `V1-01 Freeze MCIT baseline (SHA) and extraction manifest`
- **Owner suggested**: lead-dev / architecture
- **Depends on**: none
- **DoD**:
  - SHA MCIT figé et documenté
  - manifest d’extraction (paths + rationale) validé
  - source non-dirty attestée

## Issue 02 — Contracts v0.1.0 source of truth

- **Title**: `V1-02 Implement contracts package v0.1.0 (strict schemas + reason codes)`
- **Owner suggested**: contracts
- **Depends on**: V1-01
- **DoD**:
  - schemas ActionContract/Proposal/Decision/Receipt/EvidencePack versionnés
  - reject unknown fields
  - reason-codes figés + tests snapshot

## Issue 03 — Deterministic canonicalize/hash fixtures

- **Title**: `V1-03 Add deterministic canonicalization (RFC8785) + SHA256 fixtures`
- **Owner suggested**: contracts
- **Depends on**: V1-02
- **DoD**:
  - canonicalize/hash impl
  - fixtures golden stables
  - tests determinism pass

## Issue 04 — Auth v3 + anti-replay extraction

- **Title**: `V1-04 Integrate auth v3 and anti-replay (plugin-first, fail-closed)`
- **Owner suggested**: security
- **Depends on**: V1-01
- **DoD**:
  - middleware plugin-first branché
  - replay/skew tests pass
  - nonce-store down => fail-closed

## Issue 05 — Redis stores extraction

- **Title**: `V1-05 Integrate redis stores for nonce/idempotence foundations`
- **Owner suggested**: platform
- **Depends on**: V1-01, V1-04
- **DoD**:
  - nonce store branché
  - TTL explicites
  - retry budgets bornés

## Issue 06 — Idempotence extraction + key builder

- **Title**: `V1-06 Integrate idempotence with key tenant+contract+proposal_hash`
- **Owner suggested**: platform
- **Depends on**: V1-02, V1-03, V1-05
- **DoD**:
  - key builder stable
  - replay behavior défini
  - tests double-call/cross-tenant pass

## Issue 07 — Policy engine integration

- **Title**: `V1-07 Integrate policy engine DECIDE path with strict decision contract`
- **Owner suggested**: policy
- **Depends on**: V1-02, V1-04
- **DoD**:
  - Decision ALLOW/DENY/STEP_UP stricte
  - fail-safe deny si indispo
  - reason-codes tests pass

## Issue 08 — Executor graph boundary hardening

- **Title**: `V1-08 Harden executor boundary (Decision required, 1 action per contract)`
- **Owner suggested**: execution
- **Depends on**: V1-02, V1-07
- **DoD**:
  - reject if Decision != ALLOW
  - reject compound intent
  - kill-switch hook + bounded timeouts

## Issue 09 — Attest-svc tenant P0 fix

- **Title**: `V1-09 Fix attest-svc tenant isolation P0 (tenant_id, attestation_id)`
- **Owner suggested**: security
- **Depends on**: V1-04
- **DoD**:
  - storage/API strict tenant scoping
  - no wildcard scans in critical paths
  - cross-tenant deny tests pass

## Issue 10 — Gateway skeleton pipeline

- **Title**: `V1-10 Build mandate-gateway skeleton (propose→decide→execute→receipt→evidence)`
- **Owner suggested**: gateway
- **Depends on**: V1-02, V1-03, V1-06, V1-07, V1-08, V1-09
- **DoD**:
  - pipeline end-to-end branché
  - proposal_hash + idempotency_key produits
  - request/trace correlation propagated

## Issue 11 — Receipt signing + EvidencePack MVP + verify offline

- **Title**: `V1-11 Implement signed receipt + evidence pack MVP + offline verify`
- **Owner suggested**: evidence
- **Depends on**: V1-10
- **DoD**:
  - receipt signé via attest-svc
  - evidence pack MVP exportable
  - verify offline fails on tamper

## Issue 12 — E2E CI gate v0.1

- **Title**: `V1-12 Add CI E2E gate for propose→decide→execute→receipt→evidence`
- **Owner suggested**: qa
- **Depends on**: V1-10, V1-11
- **DoD**:
  - E2E minimal in CI pass
  - fail-closed tests (policy/attest/redis down)
  - cross-tenant tests pass

---

## Explicitly out of V1

- evidence-store-svc (WORM/legal-hold)
- orchestrator complet
- event-ingest as runtime product
- governance-svc complet
- graph-client/WASM non-prod
