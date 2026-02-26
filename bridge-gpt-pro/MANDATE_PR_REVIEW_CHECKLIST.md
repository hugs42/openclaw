# MANDATE_PR_REVIEW_CHECKLIST

## A. Scope & architecture

- [ ] PR respecte Pattern B (aucun secret/token/key dans runtime).
- [ ] PR respecte anti-SOAR (aucune orchestration multi-étapes).
- [ ] 1 tool = 1 action atomique.
- [ ] Aucun élargissement implicite de scope V1.
- [ ] Aucun couplage runtime spécifique dans le cœur contracts/policy/execution.

## B. Contracts & versioning

- [ ] Schémas versionnés (`v0.1.0`) pour Contract/Proposal/Decision/Receipt/Evidence.
- [ ] Schémas stricts (reject unknown fields).
- [ ] Mapping `contract_id -> handler` explicite et testé.
- [ ] Reason-codes stables (ALLOW/DENY/STEP*UP + DENY*\*).
- [ ] Plan Delta présent si changement de schéma.

## C. Sécurité / tenant / RBAC

- [ ] Auth inter-service uniforme (plugin-first).
- [ ] Anti-replay actif sur routes critiques.
- [ ] Fail-closed prod sur dépendances critiques.
- [ ] Tenant obligatoire partout (pas de default implicite).
- [ ] Storage/index tenant-scopés `(tenant_id, object_id)`.
- [ ] Aucun scan wildcard en chemin critique.
- [ ] RBAC basé claims signés uniquement.
- [ ] Aucun rôle dérivé de header libre.

## D. Exécution / kill-switch / idempotence

- [ ] Kill-switch check obligatoire avant execute.
- [ ] Precedence kill-switch > policy.
- [ ] Idempotency key stable: `tenant+contract_id+proposal_hash`.
- [ ] TTL idempotence explicite.
- [ ] Replay comportement défini et testé.

## E. Receipt / Evidence

- [ ] Receipt sans secrets/tokens.
- [ ] Signature sur payload canonicalisé (déterministe).
- [ ] EvidencePack vérifiable offline.
- [ ] Redaction PII/secrets dans evidence/logs/spans.

## F. Résilience / erreurs / observabilité

- [ ] Timeouts bornés sur appels inter-services.
- [ ] Retry budgets bornés (pas de boucle infinie).
- [ ] Taxonomie d’erreurs stable et homogène.
- [ ] Propagation `request_id/trace_id` end-to-end.
- [ ] Métriques minimales (latence, deny/allow, fail policy/attest, replays).

## G. Tests & CI

- [ ] Fixtures déterminisme hash/signature.
- [ ] Tests contractuels schémas (golden).
- [ ] Tests fail-closed (policy/attest/redis down).
- [ ] Tests multi-tenant cross-access denied.
- [ ] E2E v0.1 en CI (propose->decide->execute->receipt).
- [ ] CI green (lint/typecheck/tests/build).

## H. Delivery

- [ ] Baseline SHA MCIT mentionnée/référencée.
- [ ] 1 issue = 1 PR.
- [ ] PR petite et sans refacto hors scope.
- [ ] Versions node/pnpm alignées repo/CI.
