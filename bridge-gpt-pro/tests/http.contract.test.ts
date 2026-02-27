import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { BridgeError } from "../src/errors.js";
import { createHttpApp } from "../src/http/server.js";
import { createLogger } from "../src/logger.js";
import {
  FileRawExchangeLogger,
  type RawExchangeLogger,
  type RawExchangeRecord,
} from "../src/rawExchangeLog.js";
import type { ChatGPTDriver, DriverAskOptions } from "../src/ui/chatgptApp.js";
import type { QueueLike } from "../src/utils/queue.js";
import { SingleFlightQueue } from "../src/utils/queue.js";
import type { RateLimiter } from "../src/utils/rateLimit.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForFile(filePath: string, timeoutMs = 500): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (existsSync(filePath)) {
      return;
    }
    await sleep(10);
  }
}

async function waitForRawEntry(
  filePath: string,
  matcher: (line: Record<string, unknown>) => boolean,
  timeoutMs = 500,
): Promise<Record<string, unknown> | undefined> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (existsSync(filePath)) {
      const lines = parseJsonl(filePath);
      const found = lines.find(matcher);
      if (found) {
        return found;
      }
    }
    await sleep(10);
  }
  return undefined;
}

class TestQueue implements QueueLike {
  public depth = 0;
  public forceError: BridgeError | null = null;
  public addCalls = 0;

  public getDepth(): number {
    return this.depth;
  }

  public async add<T>(task: () => Promise<T>): Promise<T> {
    this.addCalls += 1;
    if (this.forceError) {
      throw this.forceError;
    }

    this.depth += 1;
    try {
      return await task();
    } finally {
      this.depth -= 1;
    }
  }
}

class CapturingRawExchangeLogger implements RawExchangeLogger {
  public readonly entries: RawExchangeRecord[] = [];

  public async record(entry: RawExchangeRecord): Promise<void> {
    this.entries.push(entry);
  }
}

function parseJsonl(filePath: string): Record<string, unknown>[] {
  const raw = readFileSync(filePath, "utf8").trim();
  if (raw.length === 0) {
    return [];
  }
  return raw.split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
}

function buildApp(overrides?: {
  queue?: QueueLike;
  rateLimiter?: RateLimiter;
  driver?: ChatGPTDriver;
  env?: Record<string, string>;
  rawExchangeLogger?: RawExchangeLogger;
}) {
  const config = loadConfig({
    ...process.env,
    BRIDGE_MODE: "http",
    CHATGPT_BRIDGE_TOKEN: "devtoken",
    MARKER_SECRET: "secret",
    ...overrides?.env,
  });

  const logger = createLogger({ level: "error", format: "json" });

  const queue = overrides?.queue ?? new TestQueue();
  const rateLimiter: RateLimiter =
    overrides?.rateLimiter ??
    ({
      consume: () => ({ allowed: true, retryAfterSec: 0, remainingTokens: 1 }),
    } as RateLimiter);

  const driver: ChatGPTDriver =
    overrides?.driver ??
    ({
      ensureRunning: async () => undefined,
      ask: async () => ({ text: "bridge response", contextReset: 1 }),
      getConversations: async () => ["A", "B"],
    } as ChatGPTDriver);

  return createHttpApp({
    config,
    logger,
    queue,
    rateLimiter,
    driver,
    rawExchangeLogger: overrides?.rawExchangeLogger,
  });
}

describe("HTTP contract", () => {
  it("returns 401 without bearer token", async () => {
    const app = buildApp();
    const response = await request(app).get("/v1/models");

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("unauthorized");
    expect(response.headers["x-bridge-version"]).toBeTruthy();
    expect(response.headers["x-bridge-request-id"]).toBeTruthy();
    expect(response.headers["x-should-retry"]).toBeUndefined();
  });

  it("logs redacted raw response for 401 /v1/models", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bridge-http-raw-401-"));
    const rawLogPath = path.join(dir, "raw-exchanges.jsonl");
    const rawLogger = new FileRawExchangeLogger({
      filePath: rawLogPath,
      logger: createLogger({ level: "error", format: "json" }),
      policy: {
        maxBytes: 1024 * 1024,
        maxFiles: 2,
        maxAgeDays: 30,
        privacyMode: "safe_raw",
      },
    });

    const app = buildApp({ rawExchangeLogger: rawLogger });
    const response = await request(app)
      .get("/v1/models")
      .set("Authorization", "Bearer wrong")
      .set("X-API-Key", "secret-key");

    expect(response.status).toBe(401);
    await waitForFile(rawLogPath);

    const unauthorized = await waitForRawEntry(
      rawLogPath,
      (line) =>
        line.event === "http_response_error_raw" &&
        (line.request as { path?: string } | undefined)?.path === "/v1/models",
    );

    expect(unauthorized).toBeDefined();
    const requestPayload = (unauthorized?.request ?? {}) as Record<string, unknown>;
    const headers = (requestPayload.headers ?? {}) as Record<string, unknown>;
    expect(headers.authorization).toBe("[REDACTED]");
    expect(headers["x-api-key"]).toBe("[REDACTED]");
  });

  it("returns models list", async () => {
    const app = buildApp();
    const response = await request(app).get("/v1/models").set("Authorization", "Bearer devtoken");

    expect(response.status).toBe(200);
    expect(response.body.object).toBe("list");
    expect(response.body.data[0].id).toBe("chatgpt-macos");
    expect(response.headers["x-bridge-request-id"]).toBeTruthy();
  });

  it("returns health payload", async () => {
    const app = buildApp();
    const response = await request(app).get("/health");

    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(response.body.ready).toBe(true);
    expect(response.body.mode).toBe("http");
    expect(response.body.uiAutomation.ok).toBe(true);
    expect(response.body.uiAutomation.accessibility).toBe("unknown");
    expect(response.headers["x-bridge-version"]).toBeTruthy();
  });

  it("reports accessibility_denied in health preflight", async () => {
    const driver: ChatGPTDriver = {
      ensureRunning: async () => undefined,
      ask: async () => ({ text: "bridge response", contextReset: 0 }),
      getConversations: async () => ["A", "B"],
      getUiAutomationHealth: async () => ({
        ok: false,
        accessibility: "denied",
        appRunning: null,
        code: "accessibility_denied",
        message: "Accessibility permission denied",
      }),
    };

    const app = buildApp({ driver });
    const response = await request(app).get("/health");

    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(response.body.ready).toBe(false);
    expect(response.body.uiAutomation.ok).toBe(false);
    expect(response.body.uiAutomation.code).toBe("accessibility_denied");
    expect(response.body.uiAutomation.accessibility).toBe("denied");
  });

  it("logs raw request/response for /health", async () => {
    const rawLogger = new CapturingRawExchangeLogger();
    const app = buildApp({ rawExchangeLogger: rawLogger });
    const response = await request(app).get("/health");

    expect(response.status).toBe(200);
    const requestEntry = rawLogger.entries.find(
      (entry) =>
        entry.event === "http_request_raw" &&
        (entry.request as { path?: string } | undefined)?.path === "/health",
    );
    const responseEntry = rawLogger.entries.find(
      (entry) =>
        entry.event === "http_response_raw" &&
        (entry.request as { path?: string } | undefined)?.path === "/health",
    );

    expect(requestEntry).toBeDefined();
    expect(responseEntry).toBeDefined();
  });

  it("returns non-stream completion", async () => {
    const app = buildApp();
    const response = await request(app)
      .post("/v1/chat/completions")
      .set("Authorization", "Bearer devtoken")
      .send({
        model: "gpt-4.1",
        messages: [{ role: "user", content: "hello" }],
      });

    expect(response.status).toBe(200);
    expect(response.body.object).toBe("chat.completion");
    expect(response.body.model).toBe("chatgpt-macos");
    expect(response.body.choices[0].message.content).toBe("bridge response");
    expect(response.headers["x-bridge-context-reset"]).toBe("1");
    expect(response.headers["x-bridge-session-slot"]).toBeDefined();
    expect(response.headers["x-bridge-conversation-id"]).toBeDefined();
  });

  it("logs raw request, final prompt and response payload for chat completions", async () => {
    const rawLogger = new CapturingRawExchangeLogger();
    const app = buildApp({ rawExchangeLogger: rawLogger });
    const response = await request(app)
      .post("/v1/chat/completions")
      .set("Authorization", "Bearer devtoken")
      .send({
        model: "chatgpt-macos",
        messages: [{ role: "user", content: "hello raw log" }],
      });

    expect(response.status).toBe(200);

    const requestEntry = rawLogger.entries.find((entry) => entry.event === "http_request_raw");
    const promptRenderedEntry = rawLogger.entries.find(
      (entry) => entry.event === "chatgpt_prompt_rendered_raw",
    );
    const promptEntry = rawLogger.entries.find(
      (entry) => entry.event === "chatgpt_prompt_send_raw",
    );
    const chatgptResponseEntry = rawLogger.entries.find(
      (entry) => entry.event === "chatgpt_prompt_response_raw",
    );
    const responseEntry = rawLogger.entries.find((entry) => entry.event === "http_response_raw");

    expect(requestEntry).toBeDefined();
    expect(promptRenderedEntry).toBeDefined();
    expect(promptEntry).toBeDefined();
    expect(chatgptResponseEntry).toBeDefined();
    expect(responseEntry).toBeDefined();

    expect((promptEntry as { finalPrompt?: string }).finalPrompt).toContain("hello raw log");
    expect((chatgptResponseEntry as { result?: { text?: string } }).result?.text).toBe(
      "bridge response",
    );
    expect((responseEntry as { status?: number }).status).toBe(200);
  });

  it("appends a unique extraction marker to the sent prompt", async () => {
    let askOptions: DriverAskOptions | undefined;
    const driver: ChatGPTDriver = {
      ensureRunning: async () => undefined,
      ask: async (options: DriverAskOptions) => {
        askOptions = options;
        return { text: "ok", contextReset: 0 };
      },
      getConversations: async () => ["A", "B"],
    };

    const app = buildApp({ driver });
    const response = await request(app)
      .post("/v1/chat/completions")
      .set("Authorization", "Bearer devtoken")
      .send({
        model: "chatgpt-macos",
        messages: [{ role: "user", content: "marker me" }],
      });

    expect(response.status).toBe(200);
    expect(askOptions).toBeDefined();
    expect(askOptions?.marker).toMatch(/^\[\[OC=[^[\]\n]+\]\]$/);
    expect(askOptions?.prompt).toContain("marker me");
    expect(askOptions?.prompt.endsWith(askOptions?.marker ?? "")).toBe(true);
  });

  it("injects bridge_files content into the prompt sent to ChatGPT", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bridge-http-files-"));
    const filePath = path.join(dir, "context.txt");
    writeFileSync(filePath, "alpha\nbeta", "utf8");

    let capturedPrompt = "";
    const driver: ChatGPTDriver = {
      ensureRunning: async () => undefined,
      ask: async (options: DriverAskOptions) => {
        capturedPrompt = options.prompt;
        return { text: "ok", contextReset: 0 };
      },
      getConversations: async () => ["A", "B"],
    };

    const app = buildApp({ driver });
    const response = await request(app)
      .post("/v1/chat/completions")
      .set("Authorization", "Bearer devtoken")
      .send({
        model: "chatgpt-macos",
        messages: [{ role: "user", content: "Use the file below." }],
        bridge_files: [{ path: filePath, label: "context.txt" }],
      });

    expect(response.status).toBe(200);
    expect(capturedPrompt).toContain("[FILE_CONTEXT]");
    expect(capturedPrompt).toContain("alpha\nbeta");
    expect(capturedPrompt).toContain("context.txt");
  });

  it("injects files declared in [BRIDGE_FILES] prompt block", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bridge-http-inline-files-"));
    const filePath = path.join(dir, "context.txt");
    writeFileSync(filePath, "inline alpha\ninline beta", "utf8");
    const rawLogger = new CapturingRawExchangeLogger();

    let capturedPrompt = "";
    const driver: ChatGPTDriver = {
      ensureRunning: async () => undefined,
      ask: async (options: DriverAskOptions) => {
        capturedPrompt = options.prompt;
        return { text: "ok", contextReset: 0 };
      },
      getConversations: async () => ["A", "B"],
    };

    const app = buildApp({ driver, rawExchangeLogger: rawLogger });
    const response = await request(app)
      .post("/v1/chat/completions")
      .set("Authorization", "Bearer devtoken")
      .send({
        model: "chatgpt-macos",
        messages: [
          {
            role: "user",
            content: `Use the file below.\n[BRIDGE_FILES]\n${filePath} | inline-context.txt\n[/BRIDGE_FILES]`,
          },
        ],
      });

    expect(response.status).toBe(200);
    expect(capturedPrompt).toContain("[FILE_CONTEXT]");
    expect(capturedPrompt).toContain("inline alpha\ninline beta");
    expect(capturedPrompt).toContain("inline-context.txt");
    expect(capturedPrompt).not.toContain("[BRIDGE_FILES]");
    const promptEntry = rawLogger.entries.find(
      (entry) => entry.event === "chatgpt_prompt_send_raw",
    );
    expect(promptEntry).toBeDefined();
    expect((promptEntry as { bridgeFilesBlocksDetected?: unknown }).bridgeFilesBlocksDetected).toBe(
      1,
    );
    expect((promptEntry as { bridgeFilesBlockAccepted?: unknown }).bridgeFilesBlockAccepted).toBe(
      true,
    );
    expect(
      (promptEntry as { bridgeFilesIgnoredNonTerminalCount?: unknown })
        .bridgeFilesIgnoredNonTerminalCount,
    ).toBe(0);
    expect((promptEntry as { bridgeFilesInjectedCount?: unknown }).bridgeFilesInjectedCount).toBe(
      1,
    );
  });

  it("does not inject files when [BRIDGE_FILES] block is not terminal", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bridge-http-non-terminal-files-"));
    const filePath = path.join(dir, "context.txt");
    writeFileSync(filePath, "inline alpha\ninline beta", "utf8");
    const rawLogger = new CapturingRawExchangeLogger();

    let capturedPrompt = "";
    const driver: ChatGPTDriver = {
      ensureRunning: async () => undefined,
      ask: async (options: DriverAskOptions) => {
        capturedPrompt = options.prompt;
        return { text: "ok", contextReset: 0 };
      },
      getConversations: async () => ["A", "B"],
    };

    const app = buildApp({ driver, rawExchangeLogger: rawLogger });
    const response = await request(app)
      .post("/v1/chat/completions")
      .set("Authorization", "Bearer devtoken")
      .send({
        model: "chatgpt-macos",
        messages: [
          {
            role: "user",
            content: `Use the file below.\n[BRIDGE_FILES]\n${filePath} | inline-context.txt\n[/BRIDGE_FILES]\nNo injection for this message.`,
          },
        ],
      });

    expect(response.status).toBe(200);
    expect(capturedPrompt).not.toContain("[FILE_CONTEXT]");
    expect(capturedPrompt).toContain("[BRIDGE_FILES]");
    const promptEntry = rawLogger.entries.find(
      (entry) => entry.event === "chatgpt_prompt_send_raw",
    );
    expect(promptEntry).toBeDefined();
    expect((promptEntry as { bridgeFilesBlocksDetected?: unknown }).bridgeFilesBlocksDetected).toBe(
      1,
    );
    expect((promptEntry as { bridgeFilesBlockAccepted?: unknown }).bridgeFilesBlockAccepted).toBe(
      false,
    );
    expect(
      (promptEntry as { bridgeFilesIgnoredNonTerminalCount?: unknown })
        .bridgeFilesIgnoredNonTerminalCount,
    ).toBe(1);
    expect((promptEntry as { bridgeFilesInjectedCount?: unknown }).bridgeFilesInjectedCount).toBe(
      0,
    );
  });

  it("returns 404 when a bridge_files path does not exist", async () => {
    const app = buildApp();
    const missingPath = path.join(tmpdir(), "bridge-missing-file-does-not-exist.txt");

    const response = await request(app)
      .post("/v1/chat/completions")
      .set("Authorization", "Bearer devtoken")
      .send({
        model: "chatgpt-macos",
        messages: [{ role: "user", content: "hello" }],
        bridge_files: [{ path: missingPath }],
      });

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("file_context_not_found");
  });

  it("joins duplicate concurrent completion requests without sending twice", async () => {
    const queue = new SingleFlightQueue({ maxSize: 20, defaultTimeoutMs: 2000 });
    let askCalls = 0;
    const driver: ChatGPTDriver = {
      ensureRunning: async () => undefined,
      ask: async () => {
        askCalls += 1;
        await sleep(150);
        return { text: "ok", contextReset: 0 };
      },
      getConversations: async () => ["A", "B"],
    };

    const app = buildApp({ queue, driver });
    const payload = {
      model: "chatgpt-macos",
      messages: [{ role: "user", content: "hello" }],
    };

    const [r1, r2] = await Promise.all([
      request(app)
        .post("/v1/chat/completions")
        .set("Authorization", "Bearer devtoken")
        .send(payload),
      request(app)
        .post("/v1/chat/completions")
        .set("Authorization", "Bearer devtoken")
        .send(payload),
    ]);

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r1.body.choices?.[0]?.message?.content).toBe("ok");
    expect(r2.body.choices?.[0]?.message?.content).toBe("ok");
    expect(askCalls).toBe(1);
  });

  it("rejects a concurrent different completion request with 409", async () => {
    const queue = new SingleFlightQueue({ maxSize: 20, defaultTimeoutMs: 2000 });
    const driver: ChatGPTDriver = {
      ensureRunning: async () => undefined,
      ask: async () => {
        await sleep(150);
        return { text: "ok", contextReset: 0 };
      },
      getConversations: async () => ["A", "B"],
    };

    const app = buildApp({ queue, driver });
    const [r1, r2] = await Promise.all([
      request(app)
        .post("/v1/chat/completions")
        .set("Authorization", "Bearer devtoken")
        .send({
          model: "chatgpt-macos",
          messages: [{ role: "user", content: "hello one" }],
        }),
      request(app)
        .post("/v1/chat/completions")
        .set("Authorization", "Bearer devtoken")
        .send({
          model: "chatgpt-macos",
          messages: [{ role: "user", content: "hello two" }],
        }),
    ]);

    const statuses = [r1.status, r2.status].toSorted((a, b) => a - b);
    expect(statuses).toEqual([200, 409]);
    const rejected = r1.status === 409 ? r1 : r2;
    expect(rejected.body.error.code).toBe("previous_response_pending");
  });

  it("does not emit prompt_send_raw for a request rejected as previous_response_pending", async () => {
    const queue = new SingleFlightQueue({ maxSize: 20, defaultTimeoutMs: 2000 });
    const rawLogger = new CapturingRawExchangeLogger();
    const driver: ChatGPTDriver = {
      ensureRunning: async () => undefined,
      ask: async () => {
        await sleep(150);
        return { text: "ok", contextReset: 0 };
      },
      getConversations: async () => ["A", "B"],
    };

    const app = buildApp({ queue, driver, rawExchangeLogger: rawLogger });
    const [r1, r2] = await Promise.all([
      request(app)
        .post("/v1/chat/completions")
        .set("Authorization", "Bearer devtoken")
        .send({
          model: "chatgpt-macos",
          messages: [{ role: "user", content: "hello one" }],
        }),
      request(app)
        .post("/v1/chat/completions")
        .set("Authorization", "Bearer devtoken")
        .send({
          model: "chatgpt-macos",
          messages: [{ role: "user", content: "hello two" }],
        }),
    ]);

    const statuses = [r1.status, r2.status].toSorted((a, b) => a - b);
    expect(statuses).toEqual([200, 409]);
    const promptSendEvents = rawLogger.entries.filter(
      (entry) => entry.event === "chatgpt_prompt_send_raw",
    );
    expect(promptSendEvents).toHaveLength(1);

    const pendingErrors = rawLogger.entries.filter(
      (entry) =>
        entry.event === "http_response_error_raw" &&
        (entry.response as { error?: { code?: string } } | undefined)?.error?.code ===
          "previous_response_pending",
    );
    expect(pendingErrors.length).toBeGreaterThanOrEqual(1);
  });

  it("short-circuits internal agent-to-agent control prompt without UI call", async () => {
    const queue = new TestQueue();
    const app = buildApp({ queue });
    const response = await request(app)
      .post("/v1/chat/completions")
      .set("Authorization", "Bearer devtoken")
      .send({
        model: "chatgpt-macos",
        messages: [
          { role: "user", content: "[Thu 2026-02-26 03:13 GMT+1] Agent-to-agent announce step." },
        ],
      });

    expect(response.status).toBe(200);
    expect(response.body.object).toBe("chat.completion");
    expect(response.body.choices[0].message.content).toBe("ANNOUNCE_SKIP");
    expect(queue.addCalls).toBe(0);
  });

  it("returns SSE stream when stream=true", async () => {
    const app = buildApp();
    const response = await request(app)
      .post("/v1/chat/completions")
      .set("Authorization", "Bearer devtoken")
      .send({
        model: "chatgpt-macos",
        messages: [{ role: "user", content: "hello" }],
        stream: true,
      });

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    expect(response.text).toContain("chat.completion.chunk");
    expect(response.text).toContain("[DONE]");
    expect(response.headers["x-bridge-session-slot"]).toBeDefined();
    expect(response.headers["x-bridge-conversation-id"]).toBeDefined();
  });

  it("logs full raw event chain for stream and non-stream completions", async () => {
    const rawLogger = new CapturingRawExchangeLogger();
    const app = buildApp({ rawExchangeLogger: rawLogger });

    const nonStream = await request(app)
      .post("/v1/chat/completions")
      .set("Authorization", "Bearer devtoken")
      .send({
        model: "chatgpt-macos",
        messages: [{ role: "user", content: "non-stream test" }],
        stream: false,
      });
    const stream = await request(app)
      .post("/v1/chat/completions")
      .set("Authorization", "Bearer devtoken")
      .send({
        model: "chatgpt-macos",
        messages: [{ role: "user", content: "stream test" }],
        stream: true,
      });

    expect(nonStream.status).toBe(200);
    expect(stream.status).toBe(200);

    const events = rawLogger.entries.map((entry) => entry.event);
    expect(events).toContain("http_request_raw");
    expect(events).toContain("chatgpt_prompt_rendered_raw");
    expect(events).toContain("chatgpt_prompt_send_raw");
    expect(events).toContain("chatgpt_prompt_response_raw");
    expect(events).toContain("http_response_raw");

    const responseEvents = rawLogger.entries.filter((entry) => entry.event === "http_response_raw");
    expect(responseEvents.length).toBeGreaterThanOrEqual(2);
  });

  it("returns conversation list endpoint payload", async () => {
    const app = buildApp();
    const response = await request(app)
      .get("/v1/bridge/conversations")
      .set("Authorization", "Bearer devtoken");

    expect(response.status).toBe(200);
    expect(response.body.object).toBe("list");
    expect(response.body.data).toHaveLength(2);
  });

  it("does not return previous_response_pending when queue is busy with conversations", async () => {
    let releaseConversations: (() => void) | undefined;
    const holdConversations = new Promise<void>((resolve) => {
      releaseConversations = resolve;
    });
    const queue = new SingleFlightQueue({ maxSize: 20, defaultTimeoutMs: 2000 });
    const driver: ChatGPTDriver = {
      ensureRunning: async () => undefined,
      ask: async () => ({ text: "bridge response", contextReset: 0 }),
      getConversations: async () => {
        await holdConversations;
        return ["A", "B"];
      },
    };

    const app = buildApp({ queue, driver });
    const conversationsPromise = request(app)
      .get("/v1/bridge/conversations")
      .set("Authorization", "Bearer devtoken");
    await sleep(25);

    const completionPromise = request(app)
      .post("/v1/chat/completions")
      .set("Authorization", "Bearer devtoken")
      .send({
        model: "chatgpt-macos",
        messages: [{ role: "user", content: "hello after conversations" }],
      });

    releaseConversations?.();
    const [conversationsResponse, completionResponse] = await Promise.all([
      conversationsPromise,
      completionPromise,
    ]);

    expect(conversationsResponse.status).toBe(200);
    expect(completionResponse.status).toBe(200);
    expect(completionResponse.body.error).toBeUndefined();
  });

  it("maps queue_full to 429", async () => {
    const queue = new TestQueue();
    queue.forceError = new BridgeError("queue_full", "Queue is full", undefined, 10);

    const app = buildApp({ queue });
    const response = await request(app)
      .post("/v1/chat/completions")
      .set("Authorization", "Bearer devtoken")
      .send({
        model: "chatgpt-macos",
        messages: [{ role: "user", content: "hello" }],
      });

    expect(response.status).toBe(429);
    expect(response.body.error.code).toBe("queue_full");
    expect(response.headers["retry-after"]).toBe("10");
    expect(response.headers["x-should-retry"]).toBe("false");
  });

  it("does not reject completion solely because queue depth is non-zero", async () => {
    const queue = new TestQueue();
    queue.depth = 1;

    const app = buildApp({ queue });
    const response = await request(app)
      .post("/v1/chat/completions")
      .set("Authorization", "Bearer devtoken")
      .send({
        model: "chatgpt-macos",
        messages: [{ role: "user", content: "hello" }],
      });

    expect(response.status).toBe(200);
    expect(response.body.choices?.[0]?.message?.content).toBe("bridge response");
    expect(queue.addCalls).toBe(1);
  });

  it("maps auth_required to 403", async () => {
    const queue = new TestQueue();
    queue.forceError = new BridgeError("auth_required", "Auth required");

    const app = buildApp({ queue });
    const response = await request(app)
      .post("/v1/chat/completions")
      .set("Authorization", "Bearer devtoken")
      .send({
        model: "chatgpt-macos",
        messages: [{ role: "user", content: "hello" }],
      });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("auth_required");
  });

  it("maps timeout to 504", async () => {
    const queue = new TestQueue();
    queue.forceError = new BridgeError("timeout", "Timed out");

    const app = buildApp({ queue });
    const response = await request(app)
      .post("/v1/chat/completions")
      .set("Authorization", "Bearer devtoken")
      .send({
        model: "chatgpt-macos",
        messages: [{ role: "user", content: "hello" }],
      });

    expect(response.status).toBe(504);
    expect(response.body.error.code).toBe("timeout");
    expect(response.headers["x-should-retry"]).toBe("false");
  });

  it("maps app_not_running to 503", async () => {
    const queue = new TestQueue();
    queue.forceError = new BridgeError("app_not_running", "App is not running");

    const app = buildApp({ queue });
    const response = await request(app)
      .post("/v1/chat/completions")
      .set("Authorization", "Bearer devtoken")
      .send({
        model: "chatgpt-macos",
        messages: [{ role: "user", content: "hello" }],
      });

    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe("app_not_running");
  });

  it("fails fast when UI preflight reports no ChatGPT window", async () => {
    const queue = new TestQueue();
    const driver: ChatGPTDriver = {
      ensureRunning: async () => undefined,
      ask: async () => ({ text: "should-not-run", contextReset: 0 }),
      getConversations: async () => ["A", "B"],
      getUiAutomationHealth: async () => ({
        ok: false,
        accessibility: "granted",
        appRunning: true,
        code: "ui_element_not_found",
        message: "No ChatGPT window found",
      }),
    };

    const app = buildApp({ queue, driver });
    const response = await request(app)
      .post("/v1/chat/completions")
      .set("Authorization", "Bearer devtoken")
      .send({
        model: "chatgpt-macos",
        messages: [{ role: "user", content: "hello" }],
      });

    expect(response.status).toBe(428);
    expect(response.body.error.code).toBe("ui_element_not_found");
    expect(response.headers["x-should-retry"]).toBe("false");
    expect(queue.addCalls).toBe(0);
  });

  it("returns 400 on invalid body", async () => {
    const app = buildApp();
    const response = await request(app)
      .post("/v1/chat/completions")
      .set("Authorization", "Bearer devtoken")
      .send({ model: "chatgpt-macos" });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("invalid_request");
  });

  it("logs http_response_error_raw for invalid request body (400)", async () => {
    const rawLogger = new CapturingRawExchangeLogger();
    const app = buildApp({ rawExchangeLogger: rawLogger });
    const response = await request(app)
      .post("/v1/chat/completions")
      .set("Authorization", "Bearer devtoken")
      .send({ model: "chatgpt-macos" });

    expect(response.status).toBe(400);
    const errorEntry = rawLogger.entries.find(
      (entry) =>
        entry.event === "http_response_error_raw" &&
        (entry.request as { path?: string } | undefined)?.path === "/v1/chat/completions" &&
        (entry as { status?: number }).status === 400,
    );
    expect(errorEntry).toBeDefined();
  });

  it("returns 429 when bridge rate limiter rejects", async () => {
    const app = buildApp({
      rateLimiter: {
        consume: () => ({ allowed: false, retryAfterSec: 7, remainingTokens: 0 }),
      },
    });

    const response = await request(app)
      .post("/v1/chat/completions")
      .set("Authorization", "Bearer devtoken")
      .send({
        model: "chatgpt-macos",
        messages: [{ role: "user", content: "hello" }],
      });

    expect(response.status).toBe(429);
    expect(response.body.error.code).toBe("rate_limited");
    expect(response.headers["retry-after"]).toBe("7");
    expect(response.headers["x-should-retry"]).toBe("false");
  });

  it("supports case-insensitive Bearer auth scheme", async () => {
    const app = buildApp();
    const response = await request(app).get("/v1/models").set("Authorization", "bearer devtoken");

    expect(response.status).toBe(200);
  });

  it("propagates context reset flag on downstream error", async () => {
    const queue = new TestQueue();
    queue.forceError = new BridgeError("ui_error", "Marker missing", { contextReset: 1 });

    const app = buildApp({ queue });
    const response = await request(app)
      .post("/v1/chat/completions")
      .set("Authorization", "Bearer devtoken")
      .send({
        model: "chatgpt-macos",
        messages: [{ role: "user", content: "hello" }],
      });

    expect(response.status).toBe(502);
    expect(response.headers["x-bridge-context-reset"]).toBe("1");
  });

  it("returns OpenAI-like error when body exceeds limit", async () => {
    const app = buildApp({ env: { HTTP_BODY_LIMIT: "2kb" } });
    const hugeText = "x".repeat(5000);

    const response = await request(app)
      .post("/v1/chat/completions")
      .set("Authorization", "Bearer devtoken")
      .send({
        model: "chatgpt-macos",
        messages: [{ role: "user", content: hugeText }],
      });

    expect(response.status).toBe(413);
    expect(response.body.error.code).toBe("prompt_too_large");
  });

  it("logs http_response_error_raw for oversized body (413)", async () => {
    const rawLogger = new CapturingRawExchangeLogger();
    const app = buildApp({
      env: { HTTP_BODY_LIMIT: "2kb" },
      rawExchangeLogger: rawLogger,
    });
    const hugeText = "x".repeat(5000);

    const response = await request(app)
      .post("/v1/chat/completions")
      .set("Authorization", "Bearer devtoken")
      .send({
        model: "chatgpt-macos",
        messages: [{ role: "user", content: hugeText }],
      });

    expect(response.status).toBe(413);
    const errorEntry = rawLogger.entries.find(
      (entry) =>
        entry.event === "http_response_error_raw" &&
        (entry.request as { path?: string } | undefined)?.path === "/v1/chat/completions" &&
        (entry as { status?: number }).status === 413,
    );
    expect(errorEntry).toBeDefined();
  });
});
