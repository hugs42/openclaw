# Analyse onboarding — workflow & équipe Mandate

_Date: 2026-02-27 (Europe/Paris)_

## 1) Objectif

Prendre connaissance du mode opératoire Mandate et de l’équipe de travail afin d’exécuter sans ambiguïté, avec rigueur de delivery et contrôle des risques.

## 2) Sources utilisées

- `MANDATE_EXECUTION_ORDER_V1_V2_V3.md`
- `MANDATE_PR_REVIEW_CHECKLIST.md`
- `TASK-BOOTSTRAP.md`
- `docs/mandate-v0.1/DEV_GUIDE.md`
- `docs/mandate-v0.1/V1_ISSUES_GITHUB_DRAFT.md`
- `memory/2026-02-26.md`
- `memory/2026-02-27.md`
- `CTO_ANALYSIS.md`

---

## 3) Workflow Mandate retenu (exécutable)

## 3.1 Séquencement produit (obligatoire)

### V1 — noyau preuve (priorité absolue)

1. Pré-gates bloquantes
   - baseline MCIT figée (SHA + allowlist extraction)
   - contrat tenant global + fail-closed + reason-codes figés
   - fix P0 isolation tenant attest

2. Socle sécurité/exécution
   - auth v3 + anti-replay
   - idempotence (clé stable tenant+contract+proposal_hash)
   - policy-engine DECIDE strict
   - executor boundary (1 action = 1 contract + kill-switch)
   - attest + receipt signé
   - evidence MVP + verify offline

3. Gates V1
   - E2E CI propose->decide->execute->receipt->evidence
   - fail-closed tests (policy/attest/redis down)
   - cross-tenant deny
   - déterminisme hash/signature

### V2 — durcissement contrôlé

- governance subset utile
- policy-bundle aligné contracts
- OTEL + redaction + métriques
- alignement CI/tooling

### V3 — extensions plateforme (hors noyau)

- evidence-store complet
- pipeline evidence async
- orchestrator complet si besoin business prouvé

## 3.2 Règles de delivery

- 1 issue = 1 PR
- PR petites, sans refacto hors scope
- CI green obligatoire avant merge
- changement majeur (contracts/flow/reason-codes) => validation CTO

## 3.3 Règles de revue PR (merge-gates)

Les points non négociables sont:

- Pattern B only / anti-SOAR / 1 action atomique
- schemas stricts versionnés + reason-codes stables
- tenant obligatoire partout + RBAC claims signés only
- fail-closed réel, kill-switch prioritaire
- evidence/receipt sans secrets + vérification offline
- tests contractuels + fail-closed + cross-tenant + E2E

---

## 4) Équipe avec laquelle je travaille sur Mandate

## 4.1 Noyau décision/exécution

1. **Sponsor/Owner produit (toi)**
   - fixe la direction business
   - arbitre priorités finales

2. **CTO (ChatGPT Pro via bridge)**
   - arbitre architecture, invariants, changements majeurs
   - valide les écarts/risques de haut niveau

3. **Lead exécution (moi)**
   - transforme les directives en backlog exécutable
   - pilote séquencement, qualité, traçabilité, consolidation

## 4.2 Équipe technique par domaines (owners fonctionnels)

- architecture / lead-dev
- contracts
- security
- platform
- policy
- execution
- gateway
- evidence
- QA

> Mapping déjà présent dans `V1_ISSUES_GITHUB_DRAFT.md` (owner suggested par issue).

---

## 5) Workflow de collaboration avec le CTO (déjà adopté)

- Ne pas contraindre le CTO sur la forme
- Intégrer le fond de ses retours
- Poser des clarifications ciblées en cas d’ambiguïté
- Une seule requête CTO active à la fois
- Formaliser chaque cycle dans `CTO_ANALYSIS.md`

---

## 6) État de readiness actuel

### Acquis

- cadre Mandate v0.1 structuré
- ordre V1/V2/V3 explicite
- checklist de review et backlog V1 définis

### Risque principal

- passage plan -> preuves CI (audit-grade)
- baseline/extraction à verrouiller proprement et reproductiblement

### Condition de succès court terme

- transformer immédiatement les exigences en checks CI binaires + owners nominatifs + échéances.

---

## 7) Posture d’exécution retenue

- exhaustive, rigoureuse, orientée preuve
- zéro dérive de scope V1
- pilotage par gates mesurables, pas par prose
- documentation vivante et traçable à chaque décision importante
