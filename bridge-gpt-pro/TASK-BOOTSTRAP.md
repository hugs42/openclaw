# TASK-BOOTSTRAP.md — Mandate v0.1

Backlog initial (ordre strict), orienté livraison noyau v0.1.

## MB-001 — Baseline MCIT freeze

**Objectif**: figer la provenance d’extraction.

- DoD:
  - SHA MCIT figé + documenté
  - allowlist des dossiers/fichiers extraits
  - note de conformité “pas de working tree dirty”
- Dépendances: aucune

## MB-002 — Contracts package v0.1.0 (source of truth)

- DoD:
  - Schemas ActionContract/Proposal/Decision/Receipt/EvidencePack versionnés
  - schemas stricts (unknown fields reject)
  - reason-codes taxonomie figée
- Dépendances: MB-001

## MB-003 — Déterminisme canonicalize/hash/signature fixtures

- DoD:
  - impl JCS + SHA-256
  - fixtures stables
  - tests snapshot
- Dépendances: MB-002

## MB-004 — Config guards fail-fast

- DoD:
  - validation env stricte par service
  - erreurs explicites au boot
  - fail-open interdit en prod
- Dépendances: MB-001

## MB-005 — Extraction auth v3 + anti-replay (plugin-first)

- DoD:
  - auth inter-service uniforme
  - anti-replay nonce actif
  - tests replay reject
- Dépendances: MB-001, MB-004

## MB-006 — Extraction idempotence + Redis store

- DoD:
  - clé stable tenant+contract+proposal_hash
  - TTL explicite
  - replay behavior défini/testé
- Dépendances: MB-002, MB-003, MB-005

## MB-007 — Policy engine integration (DECIDE strict)

- DoD:
  - API Decision stricte (ALLOW/DENY/STEP_UP)
  - fail-safe deny quand indisponible
  - tests reason-codes
- Dépendances: MB-002, MB-005

## MB-008 — Executor graph boundary hardening

- DoD:
  - refuse sans Decision explicite
  - enforcement 1 action = 1 contract
  - kill-switch hook obligatoire
- Dépendances: MB-002, MB-007

## MB-009 — Attest-svc P0 tenant isolation fix

- DoD:
  - lookup/storage `(tenant_id, attestation_id)`
  - suppression wildcard scans
  - tests cross-tenant deny
- Dépendances: MB-005

## MB-010 — Mandate Gateway skeleton (flow complet)

- DoD:
  - pipeline propose->decide->execute->receipt->evidence
  - validation contract + proposal_hash + idempotency_key
  - propagation request_id/trace_id
- Dépendances: MB-002, MB-003, MB-006, MB-007, MB-008, MB-009

## MB-011 — EvidencePack MVP + verify offline

- DoD:
  - EvidencePack minimal sans secrets
  - verify offline script/CLI
  - test de tamper = verify KO
- Dépendances: MB-010

## MB-012 — Observability + redaction hardening

- DoD:
  - OTEL sur chemin critique
  - redaction tokens/secrets/PII
  - métriques minimales (latence, deny/allow, fail deps, replay)
- Dépendances: MB-010

## MB-013 — E2E CI minimal v0.1

- DoD:
  - test blackbox propose->decide->execute->receipt
  - fail-closed tests policy/attest/redis down
  - cross-tenant deny tests critiques
- Dépendances: MB-010, MB-011

## MB-014 — CI/tooling alignment

- DoD:
  - Node/pnpm alignés repo + CI
  - lint/typecheck/test/build en gate unique
- Dépendances: MB-001

## MB-015 — V1 freeze + go/no-go checklist

- DoD:
  - checklist v0.1 signée
  - statut P0=0
  - critères passage V1->V2 validés
- Dépendances: MB-013, MB-014

---

## Hors scope V1 (explicit)

- evidence-store-svc complet
- orchestrator complet
- event-ingest runtime complet
- governance-svc complet
- workflow/playbook/compound intent
