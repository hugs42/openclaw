# DEV_GUIDE.md — Mandate v0.1

## 1) Stack standard équipe

- Node.js >= 20 (LTS)
- TypeScript ESM (`"type": "module"`)
- pnpm 10.x (version unique dev + CI)
- Monorepo pnpm workspaces
- Fastify (services HTTP)
- undici / fetch natif Node (inter-service HTTP)
- pino (logs) + correlation IDs
- AJV (validation JSON Schema)
- Canonicalisation JCS (RFC 8785) + SHA-256
- Vitest (unit/integration/contract) + E2E minimal
- OpenTelemetry (traces/metrics), redaction stricte
- Redis obligatoire (nonce anti-replay + idempotence)

## 2) Principes d’implémentation (jour 0)

- Pattern B only
- Anti-SOAR strict
- 1 tool = 1 action atomique
- Contracts-as-code stricts
- Fail-closed prod
- Multi-tenant strict

## 3) Onboarding local (Day 0)

1. `pnpm install`
2. `docker compose up -d redis`
3. Copier chaque `.env.example` -> `.env`
4. Lancer services:
   - `pnpm --filter mandate-gateway dev`
   - `pnpm --filter policy-engine dev`
   - `pnpm --filter executor-graph-svc dev`
   - `pnpm --filter attest-svc dev`
5. Vérifier:
   - `/health` sur chaque service
   - scénario E2E minimal (propose->decide->execute->receipt)

## 4) Commandes qualité obligatoires

- `pnpm -r build`
- `pnpm -r lint`
- `pnpm -r typecheck`
- `pnpm -r test`

Tous ces checks doivent passer avant merge.

## 5) Gates PR minimales

- Build/tests/lint/typecheck green
- Contract tests (schemas + reason-codes) green
- Fixtures déterminisme hash/signature green
- Fail-closed tests green
- Cross-tenant deny tests green
- E2E v0.1 minimal green

## 6) Règles sécurité

- HMAC v3 + anti-replay plugin-first partout
- Tenant obligatoire partout (pas de default implicite)
- RBAC claims signés uniquement
- Interdit: role depuis header libre
- Interdit: wildcard scans en chemins critiques
- Interdit: secrets/tokens dans logs/receipt/evidence

## 7) Scope V1 / hors V1

### Inclus V1

- auth v3 + anti-replay
- idempotence
- policy runtime
- executor graph (3 actions)
- attestation + evidence primitives (MVP)

### Hors V1

- evidence-store complet
- orchestrator complet
- event-ingest complet
- workflow/playbook/compound intent

## 8) Release discipline

- Baseline SHA MCIT figée avant extraction
- 1 issue = 1 PR
- PR petites, sans refacto hors scope
- Changement majeur (contracts/flow/reason-codes) => validation CTO
