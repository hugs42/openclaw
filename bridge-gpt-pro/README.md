# Claude ChatGPT MCP Tool + HTTP Bridge

`claude-chatgpt-mcp` is a macOS bridge that automates the ChatGPT desktop app through AppleScript/Accessibility.

It now supports two modes:
- `mcp` (default): stdio MCP server for Claude/Smithery
- `http`: local OpenAI-compatible HTTP server (`/v1/models`, `/v1/chat/completions`)

## Requirements

- macOS with ChatGPT desktop app installed and logged in
- Accessibility permission granted to the terminal process running the bridge
- Node.js `>=18`

## Install

```bash
npm install
npm run build
```

## Run

### MCP mode (default)

```bash
npm start
```

### HTTP mode

```bash
BRIDGE_MODE=http \
CHATGPT_BRIDGE_TOKEN=devtoken \
MARKER_SECRET=devsecret \
SESSION_BINDING_MODE=off \
npm start
```

HTTP defaults:
- `HTTP_HOST=127.0.0.1`
- `HTTP_PORT=19000`

### Run as a persistent macOS service (recommended)

This mode keeps the bridge alive and automatically restarts it after crashes
until you stop it manually.

```bash
scripts/setup-bridge-service.sh
scripts/bridge-service.sh status
```

Manual control:

```bash
scripts/bridge-service.sh start
scripts/bridge-service.sh stop
scripts/bridge-service.sh restart
scripts/bridge-service.sh logs
```

## OpenAI-compatible endpoints (HTTP mode)

- `GET /health`
- `GET /v1/models`
- `POST /v1/chat/completions`
- `GET /v1/bridge/conversations`

Auth is required for `/v1/*`:
- `Authorization: Bearer <CHATGPT_BRIDGE_TOKEN>`

### `GET /health`

`/health` is unauthenticated and returns both process liveness and UI-automation
readiness:
- `ok=true`: HTTP bridge process is up
- `ready`: UI automation preflight result
- `uiAutomation.code=accessibility_denied`: macOS Accessibility permission is missing for the bridge process

### `GET /v1/models`

```bash
curl -s \
  -H 'Authorization: Bearer devtoken' \
  http://127.0.0.1:19000/v1/models
```

### Non-stream completion

```bash
curl -s \
  -H 'Authorization: Bearer devtoken' \
  -H 'Content-Type: application/json' \
  http://127.0.0.1:19000/v1/chat/completions \
  -d '{
    "model":"chatgpt-macos",
    "messages":[{"role":"user","content":"Hello"}],
    "stream":false
}'
```

### Completion with local file injection (`bridge_files`)

Use `bridge_files` to include complete local file snapshots without manually
copy/pasting file contents into the prompt text:

```bash
curl -s \
  -H 'Authorization: Bearer devtoken' \
  -H 'Content-Type: application/json' \
  http://127.0.0.1:19000/v1/chat/completions \
  -d '{
    "model":"chatgpt-macos",
    "messages":[{"role":"user","content":"Review these files and suggest changes."}],
    "bridge_files":[
      {"path":"/ABS/PATH/TO/src/app.ts","label":"src/app.ts"},
      {"path":"/ABS/PATH/TO/README.md"}
    ],
    "stream":false
  }'
```

### Prompt-declared local files (`[BRIDGE_FILES]`)

If a client cannot send custom JSON fields, it can declare files directly in the
prompt body. This is an optional tool: only include it when full file snapshots
are actually needed (or explicitly requested).

The bridge only activates prompt-declared files when the **last**
`[BRIDGE_FILES]...[/BRIDGE_FILES]` block is terminal (nothing after it except
whitespace). Non-terminal blocks are ignored.

When activated, the bridge strips that terminal block from the prompt and
injects file contents as normal `FILE_CONTEXT`.

Line format:

```text
[BRIDGE_FILES]
/ABS/PATH/TO/src/app.ts | src/app.ts
/ABS/PATH/TO/README.md
[/BRIDGE_FILES]
```

JSON format is also supported:

```text
[BRIDGE_FILES]
[
  {"path":"/ABS/PATH/TO/src/app.ts","label":"src/app.ts"},
  {"path":"/ABS/PATH/TO/README.md"}
]
[/BRIDGE_FILES]
```

### Stream completion (SSE)

```bash
curl -N \
  -H 'Authorization: Bearer devtoken' \
  -H 'Content-Type: application/json' \
  http://127.0.0.1:19000/v1/chat/completions \
  -d '{
    "model":"chatgpt-macos",
    "messages":[{"role":"user","content":"Hello"}],
    "stream":true
  }'
```

### Sticky conversation routing (optional)

When `SESSION_BINDING_MODE=sticky` or `SESSION_BINDING_MODE=explicit`, the completion body can include:
- `conversation_id` (exact ChatGPT sidebar title)
- `session_key` (slot key used for binding persistence)

Example:

```bash
curl -s \
  -H 'Authorization: Bearer devtoken' \
  -H 'Content-Type: application/json' \
  http://127.0.0.1:19000/v1/chat/completions \
  -d '{
    "model":"chatgpt-macos",
    "messages":[{"role":"user","content":"Continue this thread"}],
    "conversation_id":"Project Alpha",
    "session_key":"default",
    "stream":false
  }'
```

Response headers include:
- `x-bridge-session-slot`
- `x-bridge-conversation-id`

### List available conversations

```bash
curl -s \
  -H 'Authorization: Bearer devtoken' \
  http://127.0.0.1:19000/v1/bridge/conversations
```

## OpenClaw provider snippet

Point OpenClaw (or any OpenAI-compatible client) to:
- Base URL: `http://127.0.0.1:19000`
- API key: your `CHATGPT_BRIDGE_TOKEN`
- Model: `chatgpt-macos`

Expected flow is:
1. `GET /v1/models`
2. `POST /v1/chat/completions`

## Environment variables

See `.env.example` for all options.

High-impact defaults:
- `BRIDGE_MODE=mcp`
- `MAX_QUEUE_SIZE=20`
- `JOB_TIMEOUT_MS=3615000`
- `MAX_WAIT_SEC=3600`
- `MAX_MESSAGE_CHARS=512000`
- `MAX_PROMPT_CHARS=512000`
- `FILE_CONTEXT_ENABLED=true`
- `FILE_CONTEXT_ALLOWED_ROOTS=` (comma-separated absolute roots, optional)
- `FILE_CONTEXT_MAX_FILES=8`
- `FILE_CONTEXT_MAX_FILE_CHARS=200000`
- `FILE_CONTEXT_MAX_TOTAL_CHARS=400000`
- `RATE_LIMIT_RPM=10`
- `RATE_LIMIT_BURST=2`
- `REQUIRE_COMPLETION_INDICATORS=false`
- `RESET_CHAT_EACH_REQUEST=false`
- `RESET_STRICT=true`
- `SESSION_BINDING_MODE=off`
- `SESSION_DEFAULT_SLOT=default`
- `SESSION_BINDING_STRICT_OPEN=false`
- `SESSION_BINDINGS_PATH=~/.openclaw/chatgpt-pro-bridge/session-bindings.json`
- `RAW_EXCHANGE_LOG_ENABLED=true`
- `RAW_EXCHANGE_LOG_PATH=~/.openclaw/chatgpt-pro-bridge/logs/raw-exchanges.jsonl`
- `RAW_EXCHANGE_LOG_MAX_BYTES=67108864`
- `RAW_EXCHANGE_LOG_MAX_FILES=20`
- `RAW_EXCHANGE_LOG_MAX_AGE_DAYS=30`
- `RAW_EXCHANGE_LOG_PRIVACY=safe_raw` (`safe_raw|header_only|metadata_only`)

Single-flight admission:
- `POST /v1/chat/completions` is serialized through a single-flight queue (`concurrency=1`).
- If a prior prompt is still running, a new prompt is rejected with `409 previous_response_pending` (no queueing).
- This guarantees each new prompt can be built only after the previous response is available.

Session binding modes:
- `off`: legacy behavior, no sticky binding persistence
- `sticky`: use `conversation_id` first, then slot binding, then active conversation fallback
- `explicit`: require `conversation_id` on every request

Strict opening:
- `SESSION_BINDING_STRICT_OPEN=true`: missing conversation title returns `404 conversation_not_found`
- `SESSION_BINDING_STRICT_OPEN=false`: warning + fallback to active conversation

Completion indicators:
- `REQUIRE_COMPLETION_INDICATORS=false`: do not require UI labels to conclude generation (default)
- `REQUIRE_COMPLETION_INDICATORS=true`: require labels like `UI_LABEL_REGENERATE`/`UI_LABEL_CONTINUE`

Long-running responses:
- Defaults are configured to support waits beyond 30 minutes.
- Keep `MAX_WAIT_SEC` and `JOB_TIMEOUT_MS` aligned for your workload.

Prompt size limits:
- `MAX_MESSAGE_CHARS` and `MAX_PROMPT_CHARS` default to `512000` chars
- This aligns with ChatGPT's 128k input-token scale using ~4 chars/token
- `bridge_files` content is merged into the final prompt and still counted against `MAX_PROMPT_CHARS`

Rollback:
- Set `SESSION_BINDING_MODE=off` at runtime to disable sticky routing immediately

## Security and operational notes

- Keep HTTP binding on localhost unless you fully trust your network.
- Do not expose this bridge directly to the public internet.
- Use a strong bearer token in HTTP mode.
- The bridge is single-flight (`concurrency=1`) by design.
- During a request, ChatGPT is foregrounded and your clipboard is temporarily modified.
- Non-text clipboard content (image/file payloads) may not be restored identically.
- A timeout returned to a client does not guarantee immediate UI cancellation; the in-flight UI task may continue until completion.

## Logging

Structured logs are emitted to `stderr` (JSON by default).

Config:
- `LOG_LEVEL=debug|info|warn|error`
- `LOG_FORMAT=json|pretty`
- `LOG_INCLUDE_AX_DUMP=false` (leave disabled in production)

### Raw exchange audit logging

When enabled, the bridge writes append-only JSONL audit events covering:
- HTTP request/response flows (including `/health`, parse errors, 404, 500)
- MCP request/response flows (`ListTools`, `CallTool`, errors)
- Prompt lifecycle (`chatgpt_prompt_rendered_raw`, `chatgpt_prompt_send_raw`, `chatgpt_prompt_response_raw`)

Default path:
- `~/.openclaw/chatgpt-pro-bridge/logs/raw-exchanges.jsonl`

Retention policy:
- Size rotation in ring (`raw-exchanges.jsonl`, `.1`, `.2`, ...)
- Max file size: `RAW_EXCHANGE_LOG_MAX_BYTES` (default 64MB)
- Max retained files: `RAW_EXCHANGE_LOG_MAX_FILES` (default 20)
- Age purge: `RAW_EXCHANGE_LOG_MAX_AGE_DAYS` (default 30 days)

Privacy modes:
- `safe_raw` (default): redacts sensitive headers and known secret-like JSON/query fields
- `header_only`: redacts sensitive headers only
- `metadata_only`: stores metadata/sizes instead of full payload bodies

Security note:
- Raw audit logs can still contain sensitive business context. Keep log files local, protected by filesystem permissions, and avoid sharing them externally.

Quick lookup example by request id:

```bash
rg '"rid":"<RID>"' ~/.openclaw/chatgpt-pro-bridge/logs/raw-exchanges.jsonl
```

## Development

```bash
npm run build
npm test
```

## Docker note

The Docker image can build and start the Node process, but it cannot automate the macOS ChatGPT app at runtime.

## Version

Current release target: `v1.1.0`.
