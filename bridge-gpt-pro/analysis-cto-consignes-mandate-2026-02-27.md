# Consignes CTO — Mandate (consolidation exécutable)

_Date: 2026-02-27 (Europe/Paris)_

## 1) Directive centrale CTO

Le CTO confirme le cap **GO_WITH_GUARDS** et pose une consigne structurante:

> Passer immédiatement d’un pilotage **doc-driven** à un pilotage **proof-driven**.

Autrement dit:

- les documents et le backlog sont jugés solides,
- mais aucune crédibilité audit-grade sans preuves CI/E2E binaires (PASS/FAIL) et artefacts traçables.

## 2) Ordre de mission (priorité stricte)

## T+24h — rendre le programme démarrable proprement

1. **Verrouiller baseline MCIT reproductible**
   - SHA figé
   - preuve working tree clean (`0 dirty`)
   - extraction manifest validé

2. **Désigner un document canonique unique**
   - toutes les autres docs doivent le référencer
   - objectif: éliminer le drift documentaire

3. **Transformer le backlog draft en issues réelles**
   - owners humains nominatifs
   - labels/priorités
   - dépendances explicites

4. **Rendre les gates CI visibles et exécutables**
   - jobs qui cassent réellement
   - pas de “checklist théorique” non enforcée

5. **Geler nomenclature/services/frontières**
   - éviter ambiguïtés d’implémentation
   - éviter refactos hors scope

## T+48h — prouver sécurité + déterminisme

1. Contracts v0.1.0 stricts
   - reject unknown fields
   - reason-codes snapshot-testés

2. Déterminisme crypto
   - JCS RFC8785
   - SHA-256
   - fixtures golden

3. Fail-closed réel
   - deps down => DENY
   - config guards fail-fast

4. Tenant/RBAC stricts
   - tenant obligatoire partout
   - RBAC via claims signés uniquement
   - tests négatifs inclus

5. Anti-replay + idempotence
   - nonce store
   - clé stable tenant+contract+proposal_hash
   - replay behavior testé

## T+7j — preuve E2E V1 minimal

1. Pipeline CI minimal:
   - propose -> decide -> execute -> receipt -> evidence

2. Executor boundary:
   - reject sans Decision ALLOW
   - reject compound intent
   - kill-switch avant exécution
   - timeouts bornés

3. Attest isolation tenant:
   - lookup/storage tenant-scopés
   - interdiction wildcard scans critiques
   - tests cross-tenant deny

4. Evidence MVP:
   - verify offline
   - test tamper => KO

5. No-secrets enforcement:
   - logs/spans/receipt/evidence

## 3) Points de contrôle bloquants avant merge

- baseline non reproductible => blocage
- fail-open détecté => blocage immédiat
- faille multi-tenant => blocage immédiat
- churn contracts/reason-codes sans version bump => blocage
- scope creep V1 (orchestrator/evidence-store/event-ingest runtime) => blocage

## 4) Conditions GO / NO-GO (pilotage)

## GO crédible (implémentation V1)

- baseline MCIT propre et traçable
- contracts/reason-codes gelés et testés
- gates CI non contournables en place
- scope V1 verrouillé

## GO crédible (V1 ready)

- E2E minimal passe en CI
- fail-closed tests passent
- cross-tenant tests passent
- déterminisme fixtures validé
- verify offline evidence/receipt validé
- pas de fuite secrets/tokens

## NO-GO immédiat

- baseline drift / non reproductible
- fail-open
- faille tenant isolation
- churn contractuel non gouverné
- dérive de scope
- secrets en logs/evidence/receipt

## 5) Risques à surveiller en continu

1. Reproductibilité baseline et provenance extraction
2. Drift documentaire entre freeze/invariants/backlog
3. Enforcement réel des règles (et non simple déclaration)
4. Fiabilité du canal bridge CTO (impact cadence décisionnelle)
5. Dette key management minimal (key_id, rotation, séparation env)

## 6) Conditions d’escalade CTO

Escalade immédiate vers CTO si:

- changement majeur contracts/flow/reason-codes
- incident fail-open/faille tenant
- besoin d’élargir le scope V1
- divergence entre docs canoniques et implémentation
- gate sécurité/CI contourné ou désactivé

## 7) Consigne de verrouillage immédiat

Créer un **Lock Dossier V1** contenant:

- baseline ref + manifest
- freeze canonique
- mapping `requirements -> issues -> tests -> jobs CI`
- statut PASS/FAIL des gates

Objectif: auditabilité complète et relecture externe sans ambiguïté.
