# MANDATE_P0_FREEZE_v0.1

## Objectif

Figer le périmètre d’implémentation Mandate v0.1 selon les directives CTO (architecture, sécurité, qualité, delivery).

## Décision de cap

- GO_WITH_GUARDS (Pattern B only, anti-SOAR strict).
- Extraction ciblée ARCHE/MCIT, jamais de reprise monolithique.

## Invariants non négociables

1. Pattern B only (aucun secret/tokens/keys dans l’agent runtime).
2. 1 tool = 1 action atomique (pas de séquences orchestrées).
3. Contracts as code (schémas versionnés, stricts, testés).
4. Déterminisme hash/canonicalisation/signature.
5. Fail-closed prod (policy/attest/nonce/idempotence indispo => reject).
6. Tenant obligatoire partout (pas de tenant implicite).
7. RBAC sur claims signés uniquement (jamais header libre de rôle).
8. Baseline MCIT figée (SHA) avant extraction.

## Périmètre V1 (autorisé)

- `@mcit/auth` + anti-replay nonce
- `@mcit/idempotence`
- `policy-engine` (PDP séparé)
- `actions-svc` (executor, 1 contract = 1 action)
- `attest-svc` + `packages/evidence` + `packages/arche-verify`
- kill-switch minimal obligatoire (global + per-contract)

## Hors V1 (interdit)

- `evidence-store-svc` complet (WORM/legal-hold/export)
- `orchestrator` complet
- `event-ingest` comme produit runtime (pattern-only OK)
- `governance-svc` complet (subset/pattern-only V1)
- `graph-client` et WASM non-prod

## Corrections P0 obligatoires avant usage sensible

1. **RBAC header role interdit** (surfaces evidence/legal-hold).
2. **Tenant isolation stricte attest**: clés/API en `(tenant_id, attestation_id)`, aucun wildcard scan.
3. **Fail-closed effectif** sur policy/attest/redis.

## Flow v0.1 figé

1. PROPOSE (gateway): validate + canonicalize + proposal_hash + idempotency_key
2. DECIDE (policy-engine): Decision stricte (ALLOW/DENY/STEP_UP + reason codes)
3. EXECUTE (actions-svc): uniquement sur Decision explicite
4. RECEIPT (gateway+attest): receipt minimal signé
5. EVIDENCE (gateway): EvidencePack MVP vérifiable offline

## DoD global v0.1 (gate go-live)

- E2E CI: propose -> decide -> execute -> receipt -> evidence
- Idempotence stable (tenant+contract+proposal_hash) + replay défini
- Multi-tenant cross-access denied (tests)
- Determinisme hash/signature validé (fixtures)
- Reason-codes stables testés
- Corrélation request_id/trace_id bout-en-bout
- Aucune fuite secrets/tokens en logs/spans/evidence

## Change control

- Changement majeur (contracts/reason-codes/flow) => validation CTO.
- 1 issue = 1 PR ; PR petite ; pas de refacto hors scope.
- CI green obligatoire avant merge.
