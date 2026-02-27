import { promises as fs } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import type { Logger } from "pino";

export type RawExchangeChannel = "http" | "mcp";
export type RawExchangeLogPrivacyMode = "safe_raw" | "header_only" | "metadata_only";

export interface RawExchangeRecord {
  channel: RawExchangeChannel;
  event: string;
  rid?: string;
  [key: string]: unknown;
}

export interface RawExchangeLogger {
  record(entry: RawExchangeRecord): Promise<void>;
}

export interface RawExchangeLogPolicy {
  maxBytes: number;
  maxFiles: number;
  maxAgeDays: number;
  privacyMode: RawExchangeLogPrivacyMode;
}

export interface FileRawExchangeLoggerOptions {
  filePath: string;
  logger: Logger;
  policy: RawExchangeLogPolicy;
}

const SENSITIVE_HEADER_KEYS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
]);

const SENSITIVE_FIELD_KEY_RE = /(password|secret|token|api[_-]?key|client_secret|refresh_token|jwt|session)/i;

export class NoopRawExchangeLogger implements RawExchangeLogger {
  public async record(_entry: RawExchangeRecord): Promise<void> {
    return;
  }
}

export class FileRawExchangeLogger implements RawExchangeLogger {
  private writeChain: Promise<void> = Promise.resolve();
  private readonly filePath: string;
  private readonly logger: Logger;
  private readonly policy: RawExchangeLogPolicy;

  public constructor(options: FileRawExchangeLoggerOptions) {
    this.filePath = options.filePath;
    this.logger = options.logger;
    this.policy = options.policy;
  }

  public async record(entry: RawExchangeRecord): Promise<void> {
    this.writeChain = this.writeChain
      .catch(() => undefined)
      .then(() => this.appendEntry(entry))
      .catch((error) => {
        this.logger.error(
          {
            event: "raw_exchange_log_write_failed",
            filePath: this.filePath,
            message: error instanceof Error ? error.message : String(error),
          },
          "raw_exchange_log_write_failed",
        );
      });

    await this.writeChain;
  }

  private async appendEntry(entry: RawExchangeRecord): Promise<void> {
    await fs.mkdir(dirname(this.filePath), { recursive: true });
    const preparedEntry = sanitizeRawExchangeEntry(entry, this.policy.privacyMode);
    const line = `${JSON.stringify({ ts: new Date().toISOString(), ...preparedEntry })}\n`;
    const lineBytes = Buffer.byteLength(line, "utf8");
    await this.rotateIfNeeded(lineBytes);
    await fs.appendFile(this.filePath, line, "utf8");
    await this.purgeExpiredFiles();
  }

  private async rotateIfNeeded(nextLineBytes: number): Promise<void> {
    const currentSize = await this.getCurrentFileSize();
    if (currentSize + nextLineBytes <= this.policy.maxBytes) {
      return;
    }

    if (this.policy.maxFiles <= 1) {
      await this.unlinkIfExists(this.filePath);
      this.logger.info(
        {
          event: "raw_exchange_log_rotated",
          path: this.filePath,
          strategy: "truncate_single_file",
          maxBytes: this.policy.maxBytes,
        },
        "raw_exchange_log_rotated",
      );
      return;
    }

    const maxArchiveIndex = this.policy.maxFiles - 1;
    for (let index = maxArchiveIndex; index >= 1; index -= 1) {
      const sourcePath = index === 1 ? this.filePath : `${this.filePath}.${index - 1}`;
      const destinationPath = `${this.filePath}.${index}`;
      if (!(await this.fileExists(sourcePath))) {
        continue;
      }

      await this.unlinkIfExists(destinationPath);
      await fs.rename(sourcePath, destinationPath);
    }

    this.logger.info(
      {
        event: "raw_exchange_log_rotated",
        path: this.filePath,
        maxBytes: this.policy.maxBytes,
        maxFiles: this.policy.maxFiles,
      },
      "raw_exchange_log_rotated",
    );
  }

  private async purgeExpiredFiles(): Promise<void> {
    if (this.policy.maxAgeDays <= 0) {
      return;
    }

    const thresholdMs = Date.now() - this.policy.maxAgeDays * 24 * 60 * 60 * 1000;
    const directoryPath = dirname(this.filePath);
    const fileBaseName = basename(this.filePath);

    let files: string[];
    try {
      files = await fs.readdir(directoryPath);
    } catch (error) {
      const withCode = error as NodeJS.ErrnoException;
      if (withCode.code === "ENOENT") {
        return;
      }
      throw error;
    }

    const deletedPaths: string[] = [];
    for (const fileName of files) {
      if (!(fileName === fileBaseName || fileName.startsWith(`${fileBaseName}.`))) {
        continue;
      }

      const candidatePath = resolve(directoryPath, fileName);
      let stats;
      try {
        stats = await fs.stat(candidatePath);
      } catch (error) {
        const withCode = error as NodeJS.ErrnoException;
        if (withCode.code === "ENOENT") {
          continue;
        }
        throw error;
      }

      if (stats.mtimeMs > thresholdMs) {
        continue;
      }

      await this.unlinkIfExists(candidatePath);
      deletedPaths.push(candidatePath);
    }

    if (deletedPaths.length > 0) {
      this.logger.info(
        {
          event: "raw_exchange_log_purged",
          path: this.filePath,
          maxAgeDays: this.policy.maxAgeDays,
          deletedFiles: deletedPaths.length,
        },
        "raw_exchange_log_purged",
      );
    }
  }

  private async getCurrentFileSize(): Promise<number> {
    try {
      const stats = await fs.stat(this.filePath);
      return stats.size;
    } catch (error) {
      const withCode = error as NodeJS.ErrnoException;
      if (withCode.code === "ENOENT") {
        return 0;
      }
      throw error;
    }
  }

  private async fileExists(pathValue: string): Promise<boolean> {
    try {
      await fs.access(pathValue);
      return true;
    } catch {
      return false;
    }
  }

  private async unlinkIfExists(pathValue: string): Promise<void> {
    try {
      await fs.unlink(pathValue);
    } catch (error) {
      const withCode = error as NodeJS.ErrnoException;
      if (withCode.code === "ENOENT") {
        return;
      }
      throw error;
    }
  }
}

export function defaultRawExchangeLogPath(sessionBindingsPath: string): string {
  return resolve(dirname(sessionBindingsPath), "logs", "raw-exchanges.jsonl");
}

export function sanitizeHeaders(headers: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(headers)) {
    const lowered = key.toLowerCase();
    if (SENSITIVE_HEADER_KEYS.has(lowered)) {
      sanitized[key] = "[REDACTED]";
      continue;
    }
    sanitized[key] = value;
  }
  return sanitized;
}

function sanitizeObjectFields(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeObjectFields(item));
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  const input = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const [key, fieldValue] of Object.entries(input)) {
    if (SENSITIVE_FIELD_KEY_RE.test(key)) {
      output[key] = "[REDACTED]";
      continue;
    }

    if (key.toLowerCase() === "headers" && fieldValue && typeof fieldValue === "object" && !Array.isArray(fieldValue)) {
      output[key] = sanitizeHeaders(fieldValue as Record<string, unknown>);
      continue;
    }

    output[key] = sanitizeObjectFields(fieldValue);
  }

  return output;
}

function sanitizeHeaderFieldsOnly(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeHeaderFieldsOnly(item));
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  const input = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const [key, fieldValue] of Object.entries(input)) {
    if (key.toLowerCase() === "headers" && fieldValue && typeof fieldValue === "object" && !Array.isArray(fieldValue)) {
      output[key] = sanitizeHeaders(fieldValue as Record<string, unknown>);
      continue;
    }
    output[key] = sanitizeHeaderFieldsOnly(fieldValue);
  }
  return output;
}

function summarizeValue(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    return { type: "string", chars: value.length, bytes: Buffer.byteLength(value, "utf8") };
  }

  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    return { type: "primitive" };
  }

  if (Array.isArray(value)) {
    const serialized = JSON.stringify(value);
    return {
      type: "array",
      items: value.length,
      bytes: serialized ? Buffer.byteLength(serialized, "utf8") : 0,
    };
  }

  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const serialized = JSON.stringify(record);
    return {
      type: "object",
      keys: Object.keys(record).length,
      bytes: serialized ? Buffer.byteLength(serialized, "utf8") : 0,
    };
  }

  return { type: "unknown" };
}

function toMetadataOnlyEntry(entry: RawExchangeRecord): RawExchangeRecord {
  const passthroughKeys = new Set([
    "channel",
    "event",
    "rid",
    "status",
    "queueDepth",
    "durationMs",
    "contextReset",
    "sessionSlot",
    "conversationId",
    "errorCode",
  ]);

  const output: RawExchangeRecord = {
    channel: entry.channel,
    event: entry.event,
    rid: entry.rid,
  };

  for (const [key, value] of Object.entries(entry)) {
    if (passthroughKeys.has(key)) {
      (output as Record<string, unknown>)[key] = value;
      continue;
    }

    if (key === "channel" || key === "event" || key === "rid") {
      continue;
    }

    (output as Record<string, unknown>)[`${key}Meta`] = summarizeValue(value);
  }

  return output;
}

export function sanitizeRawExchangeEntry(
  entry: RawExchangeRecord,
  privacyMode: RawExchangeLogPrivacyMode,
): RawExchangeRecord {
  if (privacyMode === "metadata_only") {
    return toMetadataOnlyEntry(entry);
  }

  if (privacyMode === "header_only") {
    return sanitizeHeaderFieldsOnly(entry) as RawExchangeRecord;
  }

  return sanitizeObjectFields(entry) as RawExchangeRecord;
}
