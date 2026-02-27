# Plan d’implémentation complet v1.1 — Bridge HTTP OpenAI-compatible

## Résumé
Refactor du repo vers `src/*` avec séparation `ui`, `mcp`, `http`, `utils`, ajout d’un mode HTTP OpenAI-compatible (`/health`, `/v1/models`, `/v1/chat/completions`) et maintien du mode MCP par défaut.

## Décisions verrouillées
1. Source de vérité package manager: `npm`.
2. Runtime TypeScript: ESM NodeNext, imports relatifs avec extension `.js`.
3. Stack HTTP: `express` + `zod` + `supertest`.
4. Logger structuré: `pino` sur `stderr`.
5. Politique modèle HTTP: permissive, mapping vers `chatgpt-macos`.
6. Reset chat: stratégie shortcut/menu puis fallback label.
7. Queue unique partagée MCP+HTTP (single-flight).
8. Timeout effectif clampé avec garde `MAX_WAIT_SEC`.

## Contrats publics
- Auth HTTP: `Authorization: Bearer <CHATGPT_BRIDGE_TOKEN>`.
- Headers systématiques: `x-bridge-version`, `x-bridge-request-id`, `x-bridge-queue-depth`, `x-bridge-context-reset`, `x-bridge-reset-strict`.
- Endpoints: `GET /health`, `GET /v1/models`, `POST /v1/chat/completions`.
- Streaming `stream=true`: SSE minimal (role chunk, content chunk, `[DONE]`).
- Format d’erreur: `{ error: { message, type: "bridge_error", code, param: null } }`.

## Mapping BridgeError -> HTTP
- `app_not_running`, `accessibility_denied` -> 503
- `queue_full` -> 429 (+ `Retry-After`)
- `prompt_too_large` -> 400
- `usage_cap`, `rate_limited_by_chatgpt` -> 429 (+ `Retry-After`)
- `captcha`, `auth_required` -> 403
- `network_error`, `ui_error`, `ui_element_not_found`, `ui_reset_failed` -> 502
- `timeout` -> 504
- `unknown` -> 500

## Plan exécuté (PR logical order)
1. Tooling/tests (`vitest`, `supertest`, scripts npm, `.env.example`).
2. Refactor architecture `src/*` + bootstrap mode.
3. Logging structuré + garde anti-`console.log`.
4. Erreurs typées + détection configurable des erreurs UI.
5. Marker HMAC + rendu prompt + extraction marker-first.
6. Validation tailles prompt/messages + body HTTP limit.
7. Queue single-flight + timeout + mutex clipboard.
8. Reset New Chat strict/non-strict observable.
9. API HTTP OpenAI-compatible non-stream + auth + `/v1/models`.
10. SSE minimal pour `stream=true`.
11. Rate limiting token bucket.
12. Docs/README/metadata release.

## Tests obligatoires
### Automatisés
- Unit: render prompt, marker/extract, detectUIErrors, queue, rate limit, validations.
- Contract HTTP: auth, `/health`, `/v1/models`, completions non-stream/stream, headers, mapping erreurs.

### Manuels macOS
- ChatGPT app ouverte/loggée + Accessibility.
- Smoke `/v1/models`, `/v1/chat/completions`, `stream=true`.
- Scénarios résilience: flood, reset failure strict, erreur réseau.

## Assumptions & defaults
1. `BRIDGE_MODE=mcp` par défaut.
2. `HTTP_HOST=127.0.0.1`, `HTTP_PORT=19000`.
3. `RATE_LIMIT_RPM=10`, `RATE_LIMIT_BURST=2`.
4. `RESET_CHAT_EACH_REQUEST=true`, `RESET_STRICT=true`.
5. `LOG_FORMAT=json`, `LOG_INCLUDE_AX_DUMP=false`.
6. `MARKER_SECRET` éphémère si absent (warning log).
