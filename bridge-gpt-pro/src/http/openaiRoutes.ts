import { type Request, type Response, Router } from "express";
import { nanoid } from "nanoid";
import type { Logger } from "pino";
import { z } from "zod";
import type { BridgeConfig, SessionBindingMode } from "../config.js";
import { BridgeError, isBridgeError, toBridgeError } from "../errors.js";
import {
  sanitizeHeaders,
  type RawExchangeLogger,
  type RawExchangeRecord,
} from "../rawExchangeLog.js";
import {
  NoopSessionBindingStore,
  normalizeConversationId,
  normalizeSessionSlot,
  type SessionBindingStore,
} from "../session/store.js";
import type { ChatGPTDriver, DriverAskResult } from "../ui/chatgptApp.js";
import { makeMarker } from "../ui/extract.js";
import {
  isInternalControlPrompt,
  type PromptMessage,
  renderMessagesToPrompt,
} from "../ui/renderPrompt.js";
import type { QueueLike } from "../utils/queue.js";
import type { RateLimiter } from "../utils/rateLimit.js";
import { expandPromptWithBridgeFiles } from "./fileContext.js";
import { setupSseHeaders, writeSseData } from "./sse.js";

const MODEL_ID = "chatgpt-macos";

const chatCompletionMessageSchema = z
  .object({
    role: z.enum(["system", "user", "assistant", "tool", "developer"]),
    content: z.union([z.string(), z.array(z.any()), z.null()]).optional(),
  })
  .passthrough();

const bridgeFileSchema = z
  .object({
    path: z.string().min(1),
    label: z.string().optional(),
    encoding: z.string().optional(),
  })
  .passthrough();

const chatCompletionRequestSchema = z
  .object({
    model: z.string(),
    messages: z.array(chatCompletionMessageSchema).min(1),
    stream: z.boolean().optional().default(false),
    conversation_id: z.string().optional(),
    session_key: z.string().optional(),
    bridge_files: z.array(bridgeFileSchema).optional(),
  })
  .passthrough();

interface OpenAiRouteDependencies {
  config: BridgeConfig;
  logger: Logger;
  queue: QueueLike;
  driver: ChatGPTDriver;
  rateLimiter: RateLimiter;
  sessionBindingStore?: SessionBindingStore;
  rawExchangeLogger?: RawExchangeLogger;
}

interface ErrorResponseShape {
  message: string;
  code: string;
  status: number;
  retryAfterSec?: number;
}

interface HeaderContext {
  sessionSlot?: string;
  conversationId?: string;
}

type ConversationSource = "body" | "binding" | "none";

interface RoutingContext {
  mode: SessionBindingMode;
  sessionSlot: string;
  conversationId?: string;
  conversationSource: ConversationSource;
  strictOpen: boolean;
}

interface RoutingResolution {
  ok: true;
  context: RoutingContext;
}

interface RoutingResolutionError {
  ok: false;
  error: ErrorResponseShape;
}

interface InFlightCompletion {
  key: string;
  promise: Promise<DriverAskResult>;
}

interface OpenAiErrorPayload {
  error: {
    message: string;
    type: "bridge_error";
    code: string;
    param: null;
  };
}

interface ChatCompletionResponseSnapshot {
  status: number;
  payload: unknown;
}

type RawHttpEventPayload = {
  event: string;
  rid?: string;
} & Record<string, unknown>;

function logRawHttpEvent(deps: OpenAiRouteDependencies, entry: RawHttpEventPayload): void {
  if (!deps.rawExchangeLogger) {
    return;
  }

  const payload: RawExchangeRecord = { channel: "http", ...entry };
  void deps.rawExchangeLogger.record(payload).catch((error) => {
    deps.logger.error(
      {
        event: "raw_exchange_log_failed",
        scope: "openai_routes",
        message: error instanceof Error ? error.message : String(error),
      },
      "raw_exchange_log_failed",
    );
  });
}

function snapshotRequest(req: Request): {
  method: string;
  path: string;
  headers: Record<string, unknown>;
  query: unknown;
  body: unknown;
} {
  return {
    method: req.method,
    path: req.path,
    headers: sanitizeHeaders(req.headers as Record<string, unknown>),
    query: req.query,
    body: req.body,
  };
}

function logOpenAiResponse(params: {
  deps: OpenAiRouteDependencies;
  req: Request;
  rid: string;
  status: number;
  payload: unknown;
  contextReset: 0 | 1;
  headerContext: HeaderContext;
  durationMs?: number;
  bridgeError?: BridgeError;
}): void {
  logRawHttpEvent(params.deps, {
    rid: params.rid,
    event: params.status >= 400 ? "http_response_error_raw" : "http_response_raw",
    request: snapshotRequest(params.req),
    status: params.status,
    contextReset: params.contextReset,
    queueDepth: params.deps.queue.getDepth(),
    sessionSlot: params.headerContext.sessionSlot ?? "",
    conversationId: params.headerContext.conversationId ?? "",
    durationMs: params.durationMs,
    errorCode: params.bridgeError?.code,
    errorDetails: params.bridgeError?.details,
    response: params.payload,
  });
}

function getRequestId(req: Request, res: Response): string {
  const locals = res.locals as { rid?: string };
  if (locals.rid) {
    return locals.rid;
  }

  const headerRequestId = req.header("x-request-id");
  const rid =
    typeof headerRequestId === "string" && headerRequestId.trim().length > 0
      ? headerRequestId.trim()
      : nanoid();
  locals.rid = rid;
  return rid;
}

function setBridgeHeaders(
  deps: OpenAiRouteDependencies,
  req: Request,
  res: Response,
  contextReset: 0 | 1,
  headerContext: HeaderContext = {},
): void {
  res.setHeader("x-bridge-version", deps.config.version);
  res.setHeader("x-bridge-request-id", getRequestId(req, res));
  res.setHeader("x-bridge-queue-depth", String(deps.queue.getDepth()));
  res.setHeader("x-bridge-context-reset", String(contextReset));
  res.setHeader("x-bridge-reset-strict", deps.config.resetStrict ? "1" : "0");
  res.setHeader("x-bridge-session-slot", headerContext.sessionSlot ?? "");
  res.setHeader("x-bridge-conversation-id", headerContext.conversationId ?? "");
}

function buildOpenAiErrorPayload(error: ErrorResponseShape): OpenAiErrorPayload {
  return {
    error: {
      message: error.message,
      type: "bridge_error",
      code: error.code,
      param: null,
    },
  };
}

function sendOpenAiError(
  deps: OpenAiRouteDependencies,
  req: Request,
  res: Response,
  error: ErrorResponseShape,
  contextReset: 0 | 1,
  headerContext: HeaderContext = {},
): OpenAiErrorPayload {
  setBridgeHeaders(deps, req, res, contextReset, headerContext);
  if (shouldDisableClientRetry(req)) {
    // The bridge action (UI automation) is not idempotent from the client
    // perspective. Prevent automatic SDK retries that can duplicate prompts.
    res.setHeader("x-should-retry", "false");
  }
  if (error.retryAfterSec !== undefined) {
    res.setHeader("Retry-After", String(error.retryAfterSec));
  }

  const payload = buildOpenAiErrorPayload(error);
  res.status(error.status).json(payload);
  return payload;
}

function shouldDisableClientRetry(req: Request): boolean {
  return req.method.toUpperCase() === "POST" && req.path === "/v1/chat/completions";
}

function hasTrackedCompletion(inFlight: InFlightCompletion | null): inFlight is InFlightCompletion {
  return inFlight !== null;
}

function sendPreviousResponsePending(
  deps: OpenAiRouteDependencies,
  req: Request,
  res: Response,
  contextReset: 0 | 1,
  headerContext: HeaderContext,
): void {
  sendOpenAiError(
    deps,
    req,
    res,
    {
      status: 409,
      code: "previous_response_pending",
      message: "Previous ChatGPT response is still pending; do not send a new prompt yet.",
    },
    contextReset,
    headerContext,
  );
}

function buildCompletionRequestKey(params: { prompt: string; routing: RoutingContext }): string {
  return JSON.stringify({
    prompt: params.prompt,
    mode: params.routing.mode,
    sessionSlot: params.routing.sessionSlot,
    conversationId: params.routing.conversationId ?? "",
    strictOpen: params.routing.strictOpen,
  });
}

function sendChatCompletionResponse(params: {
  deps: OpenAiRouteDependencies;
  req: Request;
  res: Response;
  stream: boolean;
  contextReset: 0 | 1;
  headerContext: HeaderContext;
  completionId: string;
  created: number;
  text: string;
}): ChatCompletionResponseSnapshot {
  if (params.stream) {
    setBridgeHeaders(
      params.deps,
      params.req,
      params.res,
      params.contextReset,
      params.headerContext,
    );
    setupSseHeaders(params.res);

    const roleChunk = {
      id: params.completionId,
      object: "chat.completion.chunk" as const,
      choices: [{ index: 0, delta: { role: "assistant" as const } }],
    };
    writeSseData(params.res, roleChunk);

    const contentChunk = {
      id: params.completionId,
      object: "chat.completion.chunk" as const,
      choices: [{ index: 0, delta: { content: params.text } }],
    };
    writeSseData(params.res, contentChunk);

    writeSseData(params.res, "[DONE]");
    params.res.end();
    return {
      status: 200,
      payload: {
        object: "chat.completion.stream",
        chunks: [roleChunk, contentChunk, "[DONE]"],
      },
    };
  }

  setBridgeHeaders(params.deps, params.req, params.res, params.contextReset, params.headerContext);
  const payload = {
    id: params.completionId,
    object: "chat.completion",
    created: params.created,
    model: MODEL_ID,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: params.text,
        },
        finish_reason: "stop",
      },
    ],
  };
  params.res.json(payload);
  return {
    status: 200,
    payload,
  };
}

function mapBridgeError(error: BridgeError): ErrorResponseShape {
  switch (error.code) {
    case "app_not_running":
    case "accessibility_denied":
      return { status: 503, code: error.code, message: error.message };
    case "queue_full":
      return {
        status: 429,
        code: error.code,
        message: error.message,
        retryAfterSec: error.retryAfterSec ?? 10,
      };
    case "prompt_too_large":
      return { status: 400, code: error.code, message: error.message };
    case "conversation_not_found":
      return { status: 404, code: error.code, message: error.message };
    case "file_context_not_found":
      return { status: 404, code: error.code, message: error.message };
    case "file_context_access_denied":
      return { status: 403, code: error.code, message: error.message };
    case "file_context_invalid":
    case "file_context_unsupported":
      return { status: 400, code: error.code, message: error.message };
    case "usage_cap":
    case "rate_limited_by_chatgpt":
      return {
        status: 429,
        code: error.code,
        message: error.message,
        retryAfterSec: error.retryAfterSec ?? 60,
      };
    case "captcha":
    case "auth_required":
      return { status: 403, code: error.code, message: error.message };
    case "network_error":
    case "ui_error":
    case "ui_reset_failed":
      return { status: 502, code: error.code, message: error.message };
    case "ui_element_not_found":
      // Missing ChatGPT UI window is a local precondition problem.
      // Expose it as 428 to avoid opaque transport retries.
      return { status: 428, code: error.code, message: error.message };
    case "timeout":
      return { status: 504, code: error.code, message: error.message };
    case "unknown":
    default:
      return { status: 500, code: error.code, message: error.message };
  }
}

function normalizeUiPreflightCode(input: string | undefined): BridgeError["code"] {
  switch (input) {
    case "app_not_running":
    case "accessibility_denied":
    case "ui_element_not_found":
    case "ui_error":
    case "auth_required":
    case "timeout":
    case "unknown":
      return input;
    default:
      return "unknown";
  }
}

async function runUiPreflight(deps: OpenAiRouteDependencies): Promise<BridgeError | null> {
  if (typeof deps.driver.getUiAutomationHealth !== "function") {
    return null;
  }

  try {
    const health = await deps.driver.getUiAutomationHealth();
    if (health.ok) {
      return null;
    }

    const code = normalizeUiPreflightCode(health.code);
    const message = health.message ?? "ChatGPT UI automation is not ready";
    return new BridgeError(code, message, {
      preflight: true,
      uiAutomation: health,
    });
  } catch (error) {
    const bridgeError = isBridgeError(error)
      ? error
      : toBridgeError(error, "UI automation preflight failed");
    bridgeError.details = {
      ...bridgeError.details,
      preflight: true,
    };
    return bridgeError;
  }
}

function requireAuth(deps: OpenAiRouteDependencies, req: Request, res: Response): boolean {
  const header = req.header("authorization");
  const expectedToken = deps.config.chatgptBridgeToken;
  const match = header?.match(/^Bearer\s+(.+)$/i);
  const token = match?.[1]?.trim();

  if (!token || token !== expectedToken) {
    const payload = sendOpenAiError(
      deps,
      req,
      res,
      {
        status: 401,
        code: "unauthorized",
        message: "Missing or invalid Authorization header",
      },
      0,
    );
    logOpenAiResponse({
      deps,
      req,
      rid: getRequestId(req, res),
      status: 401,
      payload,
      contextReset: 0,
      headerContext: {},
    });
    return false;
  }

  return true;
}

function extractContextReset(error: BridgeError): 0 | 1 {
  const value = error.details?.contextReset;
  if (value === 1 || value === 0) {
    return value;
  }
  return 0;
}

function resolveRoutingContext(
  config: BridgeConfig,
  sessionBindingStore: SessionBindingStore,
  conversationId: string | undefined,
  sessionKey: string | undefined,
): RoutingResolution | RoutingResolutionError {
  const mode = config.sessionBindingMode;

  if (mode === "off") {
    return {
      ok: true,
      context: {
        mode,
        sessionSlot: normalizeSessionSlot(config.sessionDefaultSlot),
        conversationSource: "none",
        strictOpen: false,
      },
    };
  }

  const sessionSlot = normalizeSessionSlot(sessionKey ?? config.sessionDefaultSlot);
  const bodyConversationId = normalizeConversationId(conversationId);

  if (mode === "explicit") {
    if (!bodyConversationId) {
      return {
        ok: false,
        error: {
          status: 400,
          code: "invalid_request",
          message: "conversation_id is required when SESSION_BINDING_MODE=explicit",
        },
      };
    }

    return {
      ok: true,
      context: {
        mode,
        sessionSlot,
        conversationId: bodyConversationId,
        conversationSource: "body",
        strictOpen: config.sessionBindingStrictOpen,
      },
    };
  }

  if (bodyConversationId) {
    return {
      ok: true,
      context: {
        mode,
        sessionSlot,
        conversationId: bodyConversationId,
        conversationSource: "body",
        strictOpen: config.sessionBindingStrictOpen,
      },
    };
  }

  const boundConversationId = normalizeConversationId(sessionBindingStore.get(sessionSlot));
  if (boundConversationId) {
    return {
      ok: true,
      context: {
        mode,
        sessionSlot,
        conversationId: boundConversationId,
        conversationSource: "binding",
        strictOpen: config.sessionBindingStrictOpen,
      },
    };
  }

  return {
    ok: true,
    context: {
      mode,
      sessionSlot,
      conversationSource: "none",
      strictOpen: false,
    },
  };
}

function resolveHeaderSessionSlot(mode: SessionBindingMode, sessionSlot: string): string {
  if (mode === "off") {
    return "";
  }
  return sessionSlot;
}

export function validatePromptLimits(
  config: BridgeConfig,
  messages: PromptMessage[],
  renderedPrompt: string,
): void {
  for (const message of messages) {
    if (message.content.length > config.maxMessageChars) {
      throw new BridgeError("prompt_too_large", "Message content exceeds maximum length", {
        maxMessageChars: config.maxMessageChars,
      });
    }
  }

  if (renderedPrompt.length > config.maxPromptChars) {
    throw new BridgeError("prompt_too_large", "Rendered prompt exceeds maximum length", {
      maxPromptChars: config.maxPromptChars,
      promptChars: renderedPrompt.length,
    });
  }
}

export function createOpenAiRouter(deps: OpenAiRouteDependencies): Router {
  const router = Router();
  const sessionBindingStore = deps.sessionBindingStore ?? new NoopSessionBindingStore();
  let inFlightCompletion: InFlightCompletion | null = null;

  router.get("/v1/models", (req, res) => {
    const rid = getRequestId(req, res);
    logRawHttpEvent(deps, {
      rid,
      event: "http_request_raw",
      request: snapshotRequest(req),
      queueDepth: deps.queue.getDepth(),
    });

    if (!requireAuth(deps, req, res)) {
      return;
    }

    deps.logger.info(
      { rid, event: "http_request", method: req.method, path: req.path },
      "http_request",
    );

    setBridgeHeaders(deps, req, res, 0);
    const payload = {
      object: "list",
      data: [{ id: MODEL_ID, object: "model", owned_by: "local-bridge" }],
    };
    res.json(payload);
    logOpenAiResponse({
      deps,
      req,
      rid,
      status: 200,
      payload,
      contextReset: 0,
      headerContext: {},
    });
  });

  router.get("/v1/bridge/conversations", async (req, res) => {
    const rid = getRequestId(req, res);
    const requestStartedAt = Date.now();
    const headerContext: HeaderContext = {
      sessionSlot: resolveHeaderSessionSlot(
        deps.config.sessionBindingMode,
        deps.config.sessionDefaultSlot,
      ),
      conversationId: "",
    };

    logRawHttpEvent(deps, {
      rid,
      event: "http_request_raw",
      request: snapshotRequest(req),
      queueDepth: deps.queue.getDepth(),
    });

    deps.logger.info(
      {
        rid,
        event: "http_request",
        method: req.method,
        path: req.path,
        queueDepth: deps.queue.getDepth(),
      },
      "http_request",
    );

    if (!requireAuth(deps, req, res)) {
      return;
    }

    try {
      const conversations = await deps.queue.add(
        () => deps.driver.getConversations(rid),
        deps.config.effectiveJobTimeoutMs,
      );

      setBridgeHeaders(deps, req, res, 0, {
        sessionSlot: resolveHeaderSessionSlot(
          deps.config.sessionBindingMode,
          deps.config.sessionDefaultSlot,
        ),
      });
      const payload = {
        object: "list",
        data: conversations.map((title) => ({
          id: title,
          object: "conversation",
          title,
        })),
      };
      res.json(payload);
      logOpenAiResponse({
        deps,
        req,
        rid,
        status: 200,
        payload,
        contextReset: 0,
        headerContext,
        durationMs: Date.now() - requestStartedAt,
      });

      deps.logger.info(
        {
          rid,
          event: "http_response",
          durationMs: Date.now() - requestStartedAt,
          queueDepth: deps.queue.getDepth(),
          count: conversations.length,
        },
        "http_response",
      );
    } catch (error) {
      const bridgeError = isBridgeError(error) ? error : toBridgeError(error);
      const mapped = mapBridgeError(bridgeError);
      const contextReset = extractContextReset(bridgeError);
      const payload = sendOpenAiError(deps, req, res, mapped, contextReset, headerContext);
      logOpenAiResponse({
        deps,
        req,
        rid,
        status: mapped.status,
        payload,
        contextReset,
        headerContext,
        durationMs: Date.now() - requestStartedAt,
        bridgeError,
      });
    }
  });

  router.post("/v1/chat/completions", async (req, res) => {
    const rid = getRequestId(req, res);
    const requestStartedAt = Date.now();
    let contextReset: 0 | 1 = 0;
    const headerContext: HeaderContext = {};

    logRawHttpEvent(deps, {
      rid,
      event: "http_request_raw",
      request: snapshotRequest(req),
      queueDepth: deps.queue.getDepth(),
    });

    deps.logger.info(
      {
        rid,
        event: "http_request",
        method: req.method,
        path: req.path,
        queueDepth: deps.queue.getDepth(),
      },
      "http_request",
    );

    if (!requireAuth(deps, req, res)) {
      return;
    }

    const parsed = chatCompletionRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      const mappedError = {
        status: 400,
        code: "invalid_request",
        message: "Invalid request body for /v1/chat/completions",
      } as const;
      const payload = sendOpenAiError(deps, req, res, mappedError, contextReset);
      logOpenAiResponse({
        deps,
        req,
        rid,
        status: mappedError.status,
        payload,
        contextReset,
        headerContext,
        durationMs: Date.now() - requestStartedAt,
      });
      return;
    }

    const {
      model,
      messages,
      stream,
      conversation_id: bodyConversationId,
      session_key: bodySessionKey,
      bridge_files: bridgeFiles,
    } = parsed.data;

    const routingResolution = resolveRoutingContext(
      deps.config,
      sessionBindingStore,
      bodyConversationId,
      bodySessionKey,
    );

    if (!routingResolution.ok) {
      const payload = sendOpenAiError(deps, req, res, routingResolution.error, contextReset);
      logOpenAiResponse({
        deps,
        req,
        rid,
        status: routingResolution.error.status,
        payload,
        contextReset,
        headerContext,
        durationMs: Date.now() - requestStartedAt,
      });
      return;
    }

    const routing = routingResolution.context;
    headerContext.sessionSlot = resolveHeaderSessionSlot(routing.mode, routing.sessionSlot);
    headerContext.conversationId = routing.conversationId ?? "";

    if (model !== MODEL_ID) {
      deps.logger.warn(
        {
          rid,
          event: "unknown_model_requested",
          requestedModel: model,
          mappedModel: MODEL_ID,
        },
        "unknown_model_requested",
      );
    }

    const preflightError = await runUiPreflight(deps);
    if (preflightError) {
      const mapped = mapBridgeError(preflightError);
      deps.logger.warn(
        {
          rid,
          event: "ui_preflight_failed",
          errorCode: preflightError.code,
          details: preflightError.details,
        },
        "ui_preflight_failed",
      );

      const payload = sendOpenAiError(deps, req, res, mapped, contextReset, headerContext);
      logOpenAiResponse({
        deps,
        req,
        rid,
        status: mapped.status,
        payload,
        contextReset,
        headerContext,
        durationMs: Date.now() - requestStartedAt,
        bridgeError: preflightError,
      });
      return;
    }

    // Drop system messages: ChatGPT Desktop has its own system prompt.
    // Only keep user/assistant messages; render as plain natural language.
    const promptMessages: PromptMessage[] = messages
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => ({
        role: m.role as PromptMessage["role"],
        content:
          typeof m.content === "string"
            ? m.content
            : Array.isArray(m.content)
              ? m.content.map((p: { text?: string }) => p.text ?? "").join("\n")
              : "",
      }));
    const renderedPrompt = renderMessagesToPrompt(promptMessages, "", deps.config.metaInstructions);
    logRawHttpEvent(deps, {
      rid,
      event: "chatgpt_prompt_rendered_raw",
      renderedPrompt,
      promptMessageCount: promptMessages.length,
    });

    if (isInternalControlPrompt(renderedPrompt)) {
      deps.logger.info(
        {
          rid,
          event: "control_prompt_filtered",
          prompt: renderedPrompt,
        },
        "control_prompt_filtered",
      );

      const completionId = `chatcmpl_${rid}`;
      const created = Math.floor(Date.now() / 1000);
      const syntheticText = "ANNOUNCE_SKIP";

      const responseSnapshot = sendChatCompletionResponse({
        deps,
        req,
        res,
        stream,
        contextReset,
        headerContext,
        completionId,
        created,
        text: syntheticText,
      });
      logRawHttpEvent(deps, {
        rid,
        event: "chatgpt_prompt_skipped_control_raw",
        renderedPrompt,
      });
      logOpenAiResponse({
        deps,
        req,
        rid,
        status: responseSnapshot.status,
        payload: responseSnapshot.payload,
        contextReset,
        headerContext,
        durationMs: Date.now() - requestStartedAt,
      });
      return;
    }
    try {
      const fileContext = expandPromptWithBridgeFiles(renderedPrompt, bridgeFiles, deps.config);
      const prompt = fileContext.prompt;
      const requestKey = buildCompletionRequestKey({ prompt, routing });

      // Strict sequencing for GPT Pro: only one active prompt. If the caller
      // retries the exact same request while it is in-flight, join the pending
      // result instead of sending a duplicate prompt to ChatGPT.
      const trackedCompletion = inFlightCompletion;
      const inFlightMatch =
        trackedCompletion && trackedCompletion.key === requestKey ? trackedCompletion : null;
      if (hasTrackedCompletion(trackedCompletion) && !inFlightMatch) {
        deps.logger.warn(
          {
            rid,
            event: "completion_rejected_in_flight",
            queueDepth: deps.queue.getDepth(),
          },
          "completion_rejected_in_flight",
        );
        sendPreviousResponsePending(deps, req, res, contextReset, headerContext);
        logOpenAiResponse({
          deps,
          req,
          rid,
          status: 409,
          payload: buildOpenAiErrorPayload({
            status: 409,
            code: "previous_response_pending",
            message: "Previous ChatGPT response is still pending; do not send a new prompt yet.",
          }),
          contextReset,
          headerContext,
          durationMs: Date.now() - requestStartedAt,
        });
        return;
      }

      if (inFlightMatch) {
        deps.logger.info(
          {
            rid,
            event: "completion_join_in_flight",
            queueDepth: deps.queue.getDepth(),
          },
          "completion_join_in_flight",
        );
      }

      let askResult: DriverAskResult;
      if (inFlightMatch) {
        askResult = await inFlightMatch.promise;
      } else {
        const rateDecision = deps.rateLimiter.consume(1);
        if (!rateDecision.allowed) {
          deps.logger.warn(
            {
              rid,
              event: "rate_limited",
              retryAfterSec: rateDecision.retryAfterSec,
              queueDepth: deps.queue.getDepth(),
            },
            "rate_limited",
          );

          const mappedError = {
            status: 429,
            code: "rate_limited",
            message: "Rate limit exceeded",
            retryAfterSec: rateDecision.retryAfterSec,
          };
          const payload = sendOpenAiError(deps, req, res, mappedError, contextReset, headerContext);
          logOpenAiResponse({
            deps,
            req,
            rid,
            status: mappedError.status,
            payload,
            contextReset,
            headerContext,
            durationMs: Date.now() - requestStartedAt,
          });
          return;
        }

        deps.logger.info({ rid, event: "queued", queueDepth: deps.queue.getDepth() }, "queued");

        const marker = makeMarker(rid, deps.config.markerSecret);
        const promptForSend = `${prompt}\n\n${marker}`;
        // Use a unique marker appended to the sent prompt so extraction can
        // reliably isolate only the assistant response text.
        validatePromptLimits(deps.config, promptMessages, promptForSend);
        logRawHttpEvent(deps, {
          rid,
          event: "chatgpt_prompt_send_raw",
          renderedPrompt,
          finalPrompt: promptForSend,
          marker,
          files: fileContext.files,
          bridgeFilesBlocksDetected: fileContext.diagnostics.bridgeFilesBlocksDetected,
          bridgeFilesBlockAccepted: fileContext.diagnostics.bridgeFilesBlockAccepted,
          bridgeFilesIgnoredNonTerminalCount:
            fileContext.diagnostics.bridgeFilesIgnoredNonTerminalCount,
          bridgeFilesInjectedCount: fileContext.diagnostics.bridgeFilesInjectedCount,
        });

        if (fileContext.files.length > 0) {
          const totalFileChars = fileContext.files.reduce((sum, file) => sum + file.chars, 0);
          deps.logger.info(
            {
              rid,
              event: "bridge_file_context",
              files: fileContext.files.length,
              totalFileChars,
              bridgeFilesBlocksDetected: fileContext.diagnostics.bridgeFilesBlocksDetected,
              bridgeFilesBlockAccepted: fileContext.diagnostics.bridgeFilesBlockAccepted,
              bridgeFilesIgnoredNonTerminalCount:
                fileContext.diagnostics.bridgeFilesIgnoredNonTerminalCount,
              bridgeFilesInjectedCount: fileContext.diagnostics.bridgeFilesInjectedCount,
            },
            "bridge_file_context",
          );
        }

        const askOperation = () =>
          deps.driver.ask({
            prompt: promptForSend,
            marker,
            requestId: rid,
            conversationId: routing.conversationId,
            strictOpen: routing.strictOpen,
            resetEachRequest: deps.config.resetChatEachRequest,
            resetStrict: deps.config.resetStrict,
          });

        const askPromise = deps.queue.addIfIdle
          ? deps.queue.addIfIdle(askOperation, deps.config.effectiveJobTimeoutMs)
          : deps.queue.add(askOperation, deps.config.effectiveJobTimeoutMs);

        if (!askPromise) {
          const inFlightAtomicMatch =
            inFlightCompletion?.key === requestKey ? inFlightCompletion : null;
          if (!inFlightAtomicMatch) {
            deps.logger.warn(
              {
                rid,
                event: "completion_rejected_in_flight_atomic",
                queueDepth: deps.queue.getDepth(),
              },
              "completion_rejected_in_flight_atomic",
            );
            sendPreviousResponsePending(deps, req, res, contextReset, headerContext);
            logOpenAiResponse({
              deps,
              req,
              rid,
              status: 409,
              payload: buildOpenAiErrorPayload({
                status: 409,
                code: "previous_response_pending",
                message:
                  "Previous ChatGPT response is still pending; do not send a new prompt yet.",
              }),
              contextReset,
              headerContext,
              durationMs: Date.now() - requestStartedAt,
            });
            return;
          }

          deps.logger.info(
            {
              rid,
              event: "completion_join_in_flight_atomic",
              queueDepth: deps.queue.getDepth(),
            },
            "completion_join_in_flight_atomic",
          );
          askResult = await inFlightAtomicMatch.promise;
        } else {
          let trackedAskPromise: Promise<DriverAskResult>;
          trackedAskPromise = askPromise.finally(() => {
            if (inFlightCompletion?.promise === trackedAskPromise) {
              inFlightCompletion = null;
            }
          });
          inFlightCompletion = {
            key: requestKey,
            promise: trackedAskPromise,
          };
          askResult = await trackedAskPromise;
        }
      }

      contextReset = askResult.contextReset;
      headerContext.conversationId = askResult.openedConversationId ?? "";
      logRawHttpEvent(deps, {
        rid,
        event: "chatgpt_prompt_response_raw",
        result: askResult,
      });

      if (askResult.openedConversationId) {
        if (routing.mode === "sticky" && routing.conversationSource === "body") {
          await sessionBindingStore.set(routing.sessionSlot, askResult.openedConversationId);
        }
        if (routing.mode === "explicit") {
          await sessionBindingStore.set(routing.sessionSlot, askResult.openedConversationId);
        }
      }

      const completionId = `chatcmpl_${rid}`;
      const created = Math.floor(Date.now() / 1000);

      const responseSnapshot = sendChatCompletionResponse({
        deps,
        req,
        res,
        stream,
        contextReset,
        headerContext,
        completionId,
        created,
        text: askResult.text,
      });
      logOpenAiResponse({
        deps,
        req,
        rid,
        status: responseSnapshot.status,
        payload: responseSnapshot.payload,
        contextReset,
        headerContext,
        durationMs: Date.now() - requestStartedAt,
      });

      deps.logger.info(
        {
          rid,
          event: "http_response",
          durationMs: Date.now() - requestStartedAt,
          contextReset,
          queueDepth: deps.queue.getDepth(),
          sessionSlot: headerContext.sessionSlot,
          conversationId: headerContext.conversationId,
        },
        "http_response",
      );
    } catch (error) {
      const bridgeError = isBridgeError(error) ? error : toBridgeError(error);
      const mapped = mapBridgeError(bridgeError);
      contextReset = extractContextReset(bridgeError);

      deps.logger.error(
        {
          rid,
          event: "http_response",
          durationMs: Date.now() - requestStartedAt,
          contextReset,
          errorCode: bridgeError.code,
          queueDepth: deps.queue.getDepth(),
          sessionSlot: headerContext.sessionSlot,
          conversationId: headerContext.conversationId,
        },
        bridgeError.message,
      );

      const payload = sendOpenAiError(deps, req, res, mapped, contextReset, headerContext);
      logOpenAiResponse({
        deps,
        req,
        rid,
        status: mapped.status,
        payload,
        contextReset,
        headerContext,
        durationMs: Date.now() - requestStartedAt,
        bridgeError,
      });
    }
  });

  return router;
}
