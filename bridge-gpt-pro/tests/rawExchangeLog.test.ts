import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  defaultRawExchangeLogPath,
  FileRawExchangeLogger,
  sanitizeHeaders,
  sanitizeRawExchangeEntry,
  type RawExchangeRecord,
} from "../src/rawExchangeLog.js";

function createLoggerSpy() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn(),
  } as unknown as import("pino").Logger;
}

function createRawLogger(filePath: string, logger: import("pino").Logger) {
  return new FileRawExchangeLogger({
    filePath,
    logger,
    policy: {
      maxBytes: 256,
      maxFiles: 3,
      maxAgeDays: 30,
      privacyMode: "safe_raw",
    },
  });
}

function parseJsonl(filePath: string): Record<string, unknown>[] {
  const content = readFileSync(filePath, "utf8").trim();
  if (!content) return [];
  return content.split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("raw exchange logger", () => {
  it("redacts sensitive headers", () => {
    const sanitized = sanitizeHeaders({
      authorization: "Bearer abc",
      "proxy-authorization": "Bearer p",
      cookie: "session=secret",
      "set-cookie": "a=b",
      "x-api-key": "sk-123",
      "content-type": "application/json",
    });

    expect(sanitized.authorization).toBe("[REDACTED]");
    expect(sanitized["proxy-authorization"]).toBe("[REDACTED]");
    expect(sanitized.cookie).toBe("[REDACTED]");
    expect(sanitized["set-cookie"]).toBe("[REDACTED]");
    expect(sanitized["x-api-key"]).toBe("[REDACTED]");
    expect(sanitized["content-type"]).toBe("application/json");
  });

  it("safe_raw redacts nested sensitive fields and query values", () => {
    const entry: RawExchangeRecord = {
      channel: "http",
      event: "http_request_raw",
      request: {
        headers: {
          authorization: "Bearer abc",
          "content-type": "application/json",
        },
        query: {
          token: "secret-token",
          plain: "ok",
        },
        body: {
          nested: { client_secret: "123" },
          apiKey: "xyz",
          session: "sid",
          plain: "visible",
        },
      },
    };

    const sanitized = sanitizeRawExchangeEntry(entry, "safe_raw");
    const request = (sanitized.request ?? {}) as Record<string, unknown>;
    const headers = (request.headers ?? {}) as Record<string, unknown>;
    const query = (request.query ?? {}) as Record<string, unknown>;
    const body = (request.body ?? {}) as Record<string, unknown>;
    const nested = (body.nested ?? {}) as Record<string, unknown>;

    expect(headers.authorization).toBe("[REDACTED]");
    expect(headers["content-type"]).toBe("application/json");
    expect(query.token).toBe("[REDACTED]");
    expect(query.plain).toBe("ok");
    expect(body.apiKey).toBe("[REDACTED]");
    expect(body.session).toBe("[REDACTED]");
    expect(body.plain).toBe("visible");
    expect(nested.client_secret).toBe("[REDACTED]");
  });

  it("metadata_only strips payload content to metadata", () => {
    const entry: RawExchangeRecord = {
      channel: "http",
      event: "http_response_raw",
      rid: "r1",
      status: 200,
      request: { body: { password: "abc" } },
      response: { choices: [{ message: { content: "hello" } }] },
    };

    const sanitized = sanitizeRawExchangeEntry(entry, "metadata_only") as Record<string, unknown>;
    expect(sanitized.request).toBeUndefined();
    expect(sanitized.response).toBeUndefined();
    expect(sanitized.requestMeta).toBeDefined();
    expect(sanitized.responseMeta).toBeDefined();
    expect(sanitized.status).toBe(200);
  });

  it("writes JSONL and rotates on size", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "raw-exchange-log-"));
    const filePath = path.join(dir, "logs", "raw-exchanges.jsonl");
    const logger = createLoggerSpy();
    const rawLogger = createRawLogger(filePath, logger);

    for (let index = 0; index < 6; index += 1) {
      await rawLogger.record({
        channel: "http",
        event: "http_request_raw",
        rid: `r${index}`,
        request: { body: "x".repeat(120) },
      });
    }

    expect(readFileSync(filePath, "utf8").length).toBeGreaterThan(0);
    expect(readFileSync(`${filePath}.1`, "utf8").length).toBeGreaterThan(0);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: "raw_exchange_log_rotated" }),
      "raw_exchange_log_rotated",
    );
  });

  it("purges expired rotated files by age", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "raw-exchange-purge-"));
    const filePath = path.join(dir, "logs", "raw-exchanges.jsonl");
    const logger = createLoggerSpy();
    const rawLogger = new FileRawExchangeLogger({
      filePath,
      logger,
      policy: {
        maxBytes: 1024 * 1024,
        maxFiles: 20,
        maxAgeDays: 30,
        privacyMode: "safe_raw",
      },
    });

    await fs.mkdir(path.dirname(filePath), { recursive: true });
    writeFileSync(`${filePath}.99`, "old", "utf8");
    const oldDate = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000);
    await fs.utimes(`${filePath}.99`, oldDate, oldDate);

    await rawLogger.record({
      channel: "http",
      event: "http_response_raw",
      rid: "final",
      status: 200,
    });

    await expect(fs.access(`${filePath}.99`)).rejects.toBeDefined();
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: "raw_exchange_log_purged" }),
      "raw_exchange_log_purged",
    );
  });

  it("is fail-open when appendFile fails", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "raw-exchange-fail-open-"));
    const filePath = path.join(dir, "logs", "raw-exchanges.jsonl");
    const logger = createLoggerSpy();
    const rawLogger = createRawLogger(filePath, logger);

    const appendSpy = vi.spyOn(fs, "appendFile").mockRejectedValueOnce(new Error("disk-full"));
    await expect(
      rawLogger.record({
        channel: "http",
        event: "http_request_raw",
        rid: "r1",
        request: { body: "abc" },
      }),
    ).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: "raw_exchange_log_write_failed" }),
      "raw_exchange_log_write_failed",
    );

    appendSpy.mockRestore();
  });

  it("writes redacted content to disk using configured privacy mode", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "raw-exchange-redacted-"));
    const filePath = path.join(dir, "logs", "raw-exchanges.jsonl");
    const logger = createLoggerSpy();
    const rawLogger = new FileRawExchangeLogger({
      filePath,
      logger,
      policy: {
        maxBytes: 1024 * 1024,
        maxFiles: 2,
        maxAgeDays: 30,
        privacyMode: "safe_raw",
      },
    });

    await rawLogger.record({
      channel: "http",
      event: "http_request_raw",
      request: {
        headers: { authorization: "Bearer abc" },
        body: { password: "secret", plain: "ok" },
      },
    });

    const lines = parseJsonl(filePath);
    const first = lines[0] ?? {};
    const request = (first.request ?? {}) as Record<string, unknown>;
    const headers = (request.headers ?? {}) as Record<string, unknown>;
    const body = (request.body ?? {}) as Record<string, unknown>;

    expect(headers.authorization).toBe("[REDACTED]");
    expect(body.password).toBe("[REDACTED]");
    expect(body.plain).toBe("ok");
  });

  it("derives raw log path from session bindings path", () => {
    const derived = defaultRawExchangeLogPath("/tmp/bridge/session-bindings.json");
    expect(derived).toBe(path.resolve("/tmp/bridge/logs/raw-exchanges.jsonl"));
  });
});
