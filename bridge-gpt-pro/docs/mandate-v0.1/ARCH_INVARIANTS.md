# ARCH_INVARIANTS.md — Mandate v0.1

Source: directives CTO (2026-02-27).

## 1) Invariants non négociables

1. Pattern B only: aucun secret/token/clé privée dans l’agent runtime.
2. Anti-SOAR strict: pas d’orchestration multi-étapes côté Mandate.
3. 1 tool = 1 action atomique = 1 Action Contract = 1 preuve.
4. Cœur runtime-agnostic: contracts/policy/execution indépendants du transport (MCP/REST).
5. Contracts-as-code obligatoires et versionnés.
6. Déterminisme obligatoire (canonicalisation/hash/signature).
7. Fail-closed en prod (policy/attest/nonce/idempotence down => reject).
8. Extraction sélective ARCHE/MCIT, jamais de reprise monolithique.

## 2) Frontières de services v0.1

- Mandate Gateway: point d’entrée unique (MCP + REST minimal).
- Policy Engine: PDP séparé (décide, n’exécute jamais).
- Executor Graph: exécute uniquement sur Decision explicite.
- Attest SVC: service unique de signature des receipts.
- EvidencePack MVP: construit côté Gateway (stockage durable optionnel en v0.1).

## 3) Contrats v0.1.0 (source of truth)

Objets à versionner et valider strictement:

- ActionContract
- Proposal
- Decision
- Receipt
- EvidencePack

Règles:

- Schémas stricts (reject unknown fields)
- Reason-codes stables et snapshot-testés
- Payload limits bornées
- Compat ascendante via Plan Delta + bump version

## 4) Flow exécutable v0.1

1. PROPOSE (Gateway): validate -> canonicalize -> proposal_hash -> idempotency_key
2. DECIDE (Policy): décision stricte (ALLOW/DENY/STEP_UP)
3. EXECUTE (Executor): exécution uniquement si autorisé
4. RECEIPT (Gateway+Attest): receipt minimal signé
5. EVIDENCE (Gateway): EvidencePack MVP vérifiable offline

## 5) Sécurité / multi-tenant / RBAC

- Auth inter-service plugin-first uniforme
- Anti-replay obligatoire routes critiques
- Tenant obligatoire partout (pas de default implicite)
- Storage/index strictement tenant-scopés `(tenant_id, id)`
- Interdiction wildcard scan en chemins critiques
- RBAC uniquement via claims signés
- Interdiction de rôle dérivé de headers non signés

## 6) Kill-switch / idempotence

- Kill-switch hook obligatoire avant execute
- Precedence: kill-switch > policy
- Idempotency key stable: tenant + contract_id + proposal_hash
- TTL idempotence explicite + replay behavior défini

## 7) Receipt / evidence

- Jamais de secrets/tokens dans receipt/evidence/logs
- Signature canonicalisée avec metadata (alg, key_id, signed_at)
- Vérification offline obligatoire (au minimum script/CLI)
- Evidence-store WORM/legal-hold hors V1

## 8) Résilience / erreurs / observabilité

- Timeouts bornés sur tous appels inter-services
- Retry budgets bornés (pas de boucle infinie)
- Taxonomie d’erreurs homogène et stable
- Propagation request_id/trace_id bout-en-bout
- OTEL + redaction stricte

## 9) Gates qualité obligatoires

- Build + lint + typecheck + tests green
- Fixtures déterminisme hash/signature
- Tests contractuels schémas
- Tests fail-closed
- Tests cross-tenant access denied
- E2E v0.1 en CI (propose->decide->execute->receipt)

## 10) Scope strict

### Inclus V1

- auth v3 + anti-replay
- idempotence
- policy runtime
- executor graph (3 actions)
- attestation + evidence primitives

### Exclu V1

- evidence-store-svc complet
- orchestrator complet
- event-ingest comme produit runtime
- workflow/playbook/compound intent
