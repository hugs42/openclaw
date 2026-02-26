# REPO_STRUCTURE.md — Mandate v0.1

Structure cible imposée (monorepo pnpm workspaces):

```text
mandate/
  services/
    mandate-gateway/
      src/
        config/
        middleware/
        routes/
        services/
        domain/
        adapters/
        index.ts
        server.ts
      tests/
        contract/
        integration/
      package.json
      tsconfig.json
      vitest.config.ts

    executor-graph-svc/
      src/
        config/
        middleware/
        routes/
        services/
        actions/
        index.ts
        server.ts
      tests/
      package.json

    policy-engine/        # extraction/réutilisation MCIT
      src/...
      package.json

    attest-svc/           # extraction/réutilisation MCIT (corrigée tenant)
      src/...
      package.json

  packages/
    contracts/
      src/
        schemas/
        reason-codes.ts
        canonicalize.ts
        hash.ts
        validate.ts
        index.ts
      tests/fixtures/
      package.json

    auth/                 # extraction MCIT
    redis-stores/         # extraction MCIT
    idempotence/          # extraction MCIT
    config-guards/
    observability/
    evidence/             # extraction MCIT
    arche-verify/         # extraction MCIT

  tests/
    e2e/
      src/
      package.json

  docs/
    mandate-v0.1/
      architecture.md
      contracts/
      runbooks/
      n2-bypass-protocol.md

  ops/
    ai/tasks/
    ai/plans/
    ai/reports/

  scripts/
    dev/
    ci/

  infra/
    docker-compose.yml

  package.json
  pnpm-workspace.yaml
  tsconfig.base.json
  .github/workflows/
```

## Règles d’organisation

- `services/*` = processus déployables
- `packages/*` = libs réutilisables (pas de dépendance runtime spécifique)
- `tests/e2e/*` = blackbox end-to-end
- `docs/mandate-v0.1/*` = vérité produit
- Pas d’orchestrator global en v0.1

## Template interne obligatoire par service

- `src/config`: env + validation fail-fast
- `src/middleware`: auth, tenant-guard, request-id
- `src/routes`: I/O HTTP (pas de logique métier)
- `src/services`: clients externes (policy/executor/attest/redis)
- `src/domain`: logique noyau runtime-agnostic
- `src/adapters`: MCP/REST mapping

## Règles de dépendances

- `routes -> domain/services` OK
- `domain -> services` OK
- `services -> domain` interdit
- `adapters -> domain` OK
- `domain` ne dépend jamais de Fastify
