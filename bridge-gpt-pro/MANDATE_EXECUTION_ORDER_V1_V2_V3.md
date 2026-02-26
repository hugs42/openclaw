# MANDATE_EXECUTION_ORDER_V1_V2_V3

## Principe

Ordre strict basé sur les directives CTO. Objectif: réduire le risque d’intégration et prouver v0.1 rapidement.

## V1 — Noyau preuve (priorité absolue)

### 0. Pré-gate (bloquant)

1. Figer baseline MCIT (SHA + allowlist de briques extraites)
2. Figer contrat tenant global + règle fail-closed + reason-codes
3. Corriger P0 attest tenant isolation

### 1. Socle sécurité/exécution

4. Intégrer `@mcit/auth` + anti-replay
5. Intégrer `@mcit/idempotence` (clé stable tenant+contract+proposal_hash)
6. Intégrer `policy-engine` (Decision stricte)
7. Intégrer `actions-svc` (1 action = 1 contract + kill-switch)
8. Intégrer `attest-svc` (après fix P0) + receipt signé
9. Intégrer EvidencePack MVP + verify offline

### 2. Gates V1

10. E2E CI propose->decide->execute->receipt->evidence
11. Tests fail-closed policy/attest/redis
12. Tests multi-tenant (cross-access denied)
13. Tests déterminisme hash/signature

## V2 — Durcissement contrôlé

14. `governance-svc` (subset utile, contrat durci)
15. `policy-bundle` aligné Action Contracts v0.1
16. OTEL + redaction + métriques standardisées
17. Harmonisation CI/tooling (node/pnpm, thresholds)

## V3 — Extensions plateforme (hors noyau)

18. `evidence-store-svc` (WORM/legal-hold/export) après durcissement RBAC/tenant
19. Evidence async pipeline (builder/store)
20. Orchestrator complet uniquement si besoin business démontré

## Explicitement hors V1

- evidence-store complet
- orchestrator complet
- event-ingest comme produit runtime
- governance-svc complet
- graph-client / WASM non-prod

## Politique de merge

- 1 issue = 1 PR
- PR petites
- pas de refacto hors scope
- CI green obligatoire
