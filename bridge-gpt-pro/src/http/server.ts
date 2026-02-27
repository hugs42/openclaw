import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { nanoid } from "nanoid";
import type { Logger } from "pino";
import type { BridgeConfig } from "../config.js";
import { createOpenAiRouter } from "./openaiRoutes.js";
import type { RawExchangeLogger, RawExchangeRecord } from "../rawExchangeLog.js";
import { sanitizeHeaders } from "../rawExchangeLog.js";
import type { ChatGPTDriver, UiAutomationHealth } from "../ui/chatgptApp.js";
import type { QueueLike } from "../utils/queue.js";
import type { RateLimiter } from "../utils/rateLimit.js";
import type { SessionBindingStore } from "../session/store.js";

interface HttpServerDependencies {
  config: BridgeConfig;
  logger: Logger;
  queue: QueueLike;
  driver: ChatGPTDriver;
  rateLimiter: RateLimiter;
  sessionBindingStore?: SessionBindingStore;
  rawExchangeLogger?: RawExchangeLogger;
}

type RawHttpEventPayload = {
  event: string;
  rid?: string;
} & Record<string, unknown>;

function defaultUiAutomationHealth(): UiAutomationHealth {
  return {
    ok: true,
    accessibility: "unknown",
    appRunning: null,
  };
}

function applyBaseHeaders(config: BridgeConfig, queueDepth: number, rid: string, res: Response): void {
  res.setHeader("x-bridge-version", config.version);
  res.setHeader("x-bridge-request-id", rid);
  res.setHeader("x-bridge-queue-depth", String(queueDepth));
  res.setHeader("x-bridge-context-reset", "0");
  res.setHeader("x-bridge-reset-strict", config.resetStrict ? "1" : "0");
  res.setHeader("x-bridge-session-slot", "");
  res.setHeader("x-bridge-conversation-id", "");
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

function logRawHttpEvent(
  deps: HttpServerDependencies,
  entry: RawHttpEventPayload,
): void {
  if (!deps.rawExchangeLogger) {
    return;
  }

  const payload: RawExchangeRecord = { channel: "http", ...entry };
  void deps.rawExchangeLogger.record(payload).catch((error) => {
    deps.logger.error(
      {
        event: "raw_exchange_log_failed",
        scope: "http_server",
        message: error instanceof Error ? error.message : String(error),
      },
      "raw_exchange_log_failed",
    );
  });
}

export function createHttpApp(deps: HttpServerDependencies): Express {
  const app = express();

  app.disable("x-powered-by");

  app.use((req, res, next) => {
    const headerRequestId = req.header("x-request-id");
    const rid = typeof headerRequestId === "string" && headerRequestId.trim().length > 0 ? headerRequestId.trim() : nanoid();
    (res.locals as { rid?: string }).rid = rid;

    applyBaseHeaders(deps.config, deps.queue.getDepth(), rid, res);
    next();
  });

  app.use(express.json({ limit: deps.config.httpBodyLimit }));

  app.use((error: Error & { type?: string }, req: Request, res: Response, next: NextFunction) => {
    if (error.type === "entity.too.large") {
      const rid = (res.locals as { rid?: string }).rid ?? nanoid();
      applyBaseHeaders(deps.config, deps.queue.getDepth(), rid, res);
      const payload = {
        error: {
          message: "Request body is too large",
          type: "bridge_error",
          code: "prompt_too_large",
          param: null,
        },
      };
      res.status(413).json(payload);
      logRawHttpEvent(deps, {
        rid,
        event: "http_response_error_raw",
        request: snapshotRequest(req),
        status: 413,
        queueDepth: deps.queue.getDepth(),
        response: payload,
      });
      return;
    }

    if (error.type === "entity.parse.failed") {
      const rid = (res.locals as { rid?: string }).rid ?? nanoid();
      applyBaseHeaders(deps.config, deps.queue.getDepth(), rid, res);
      const payload = {
        error: {
          message: "Invalid JSON body",
          type: "bridge_error",
          code: "invalid_request",
          param: null,
        },
      };
      res.status(400).json(payload);
      logRawHttpEvent(deps, {
        rid,
        event: "http_response_error_raw",
        request: snapshotRequest(req),
        status: 400,
        queueDepth: deps.queue.getDepth(),
        response: payload,
      });
      return;
    }

    next(error);
  });

  app.get("/health", async (req, res) => {
    const rid = (res.locals as { rid?: string }).rid ?? nanoid();
    applyBaseHeaders(deps.config, deps.queue.getDepth(), rid, res);
    logRawHttpEvent(deps, {
      rid,
      event: "http_request_raw",
      request: snapshotRequest(req),
      queueDepth: deps.queue.getDepth(),
    });

    let uiAutomation = defaultUiAutomationHealth();
    if (typeof deps.driver.getUiAutomationHealth === "function") {
      try {
        uiAutomation = await deps.driver.getUiAutomationHealth();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        uiAutomation = {
          ok: false,
          accessibility: "unknown",
          appRunning: null,
          code: "unknown",
          message,
        };
      }
    }

    const payload = {
      ok: true,
      ready: uiAutomation.ok,
      mode: "http",
      queueDepth: deps.queue.getDepth(),
      version: deps.config.version,
      uiAutomation,
    };
    res.json(payload);
    logRawHttpEvent(deps, {
      rid,
      event: "http_response_raw",
      request: snapshotRequest(req),
      status: 200,
      queueDepth: deps.queue.getDepth(),
      response: payload,
    });
  });

  app.use(createOpenAiRouter(deps));

  app.use((req, res) => {
    const rid = (res.locals as { rid?: string }).rid ?? nanoid();
    applyBaseHeaders(deps.config, deps.queue.getDepth(), rid, res);

    const payload = {
      error: {
        message: "Route not found",
        type: "bridge_error",
        code: "not_found",
        param: null,
      },
    };
    res.status(404).json(payload);
    logRawHttpEvent(deps, {
      rid,
      event: "http_response_error_raw",
      request: snapshotRequest(req),
      status: 404,
      queueDepth: deps.queue.getDepth(),
      response: payload,
    });
  });

  app.use((error: Error, req: Request, res: Response, _next: NextFunction) => {
    deps.logger.error({ event: "http_unhandled_error", message: error.message, stack: error.stack }, "http_unhandled_error");
    const rid = (res.locals as { rid?: string }).rid ?? nanoid();
    applyBaseHeaders(deps.config, deps.queue.getDepth(), rid, res);
    const payload = {
      error: {
        message: "Unhandled HTTP error",
        type: "bridge_error",
        code: "unknown",
        param: null,
      },
    };
    res.status(500).json(payload);
    logRawHttpEvent(deps, {
      rid,
      event: "http_response_error_raw",
      request: snapshotRequest(req),
      status: 500,
      queueDepth: deps.queue.getDepth(),
      response: payload,
    });
  });

  return app;
}

export async function startHttpServer(deps: HttpServerDependencies): Promise<void> {
  const app = createHttpApp(deps);
  const minimumLongWaitMs = 31 * 60 * 1000;
  const requestTimeoutMs = Math.max(deps.config.effectiveJobTimeoutMs + 5_000, minimumLongWaitMs);

  await new Promise<void>((resolve) => {
    const server = app.listen(deps.config.httpPort, deps.config.httpHost, () => {
      server.requestTimeout = requestTimeoutMs;
      server.timeout = requestTimeoutMs;
      server.headersTimeout = Math.max(server.headersTimeout, requestTimeoutMs + 1_000);

      deps.logger.info(
        {
          event: "http_server_started",
          mode: "http",
          host: deps.config.httpHost,
          port: deps.config.httpPort,
          requestTimeoutMs,
        },
        "http_server_started",
      );
      resolve();
    });
  });
}
