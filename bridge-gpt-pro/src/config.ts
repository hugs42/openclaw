import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

export type BridgeMode = "mcp" | "http";
export type SessionBindingMode = "off" | "sticky" | "explicit";
export type RawExchangeLogPrivacyMode = "safe_raw" | "header_only" | "metadata_only";

export interface UiErrorPattern {
  code: string;
  includes: string[];
}

export interface BridgeConfig {
  version: string;
  bridgeMode: BridgeMode;
  httpHost: string;
  httpPort: number;
  chatgptBridgeToken: string;
  httpBodyLimit: string;

  maxQueueSize: number;
  jobTimeoutMs: number;
  effectiveJobTimeoutMs: number;
  jobTimeoutClamped: boolean;

  maxWaitSec: number;
  pollIntervalSec: number;
  stableChecks: number;
  extractNoIndicatorStableMs: number;
  scrapeCallTimeoutMs: number;

  maxPromptChars: number;
  maxMessageChars: number;
  fileContextEnabled: boolean;
  fileContextAllowedRoots: string[];
  fileContextMaxFiles: number;
  fileContextMaxFileChars: number;
  fileContextMaxTotalChars: number;

  rateLimitRpm: number;
  rateLimitBurst: number;

  uiLabelNewChat: string;
  uiLabelRegenerate: string;
  uiLabelContinue: string;
  requireCompletionIndicators: boolean;

  uiErrorPatterns: UiErrorPattern[];

  resetChatEachRequest: boolean;
  resetStrict: boolean;
  sessionBindingMode: SessionBindingMode;
  sessionDefaultSlot: string;
  sessionBindingsPath: string;
  sessionBindingStrictOpen: boolean;

  markerSecret: string;
  markerSecretEphemeral: boolean;
  metaInstructions: string;

  logLevel: "debug" | "info" | "warn" | "error";
  logFormat: "json" | "pretty";
  logIncludeAxDump: boolean;
  rawExchangeLogEnabled: boolean;
  rawExchangeLogPath: string;
  rawExchangeLogMaxBytes: number;
  rawExchangeLogMaxFiles: number;
  rawExchangeLogMaxAgeDays: number;
  rawExchangeLogPrivacyMode: RawExchangeLogPrivacyMode;
}

const DEFAULT_UI_ERROR_PATTERNS: UiErrorPattern[] = [
  { code: "usage_cap", includes: ["usage cap", "reached the current usage cap"] },
  { code: "rate_limited", includes: ["too many requests", "try again later"] },
  { code: "network_error", includes: ["network error", "something went wrong"] },
  { code: "captcha", includes: ["verify you are human", "captcha"] },
  { code: "auth_required", includes: ["log in", "sign in to continue"] },
];

const DEFAULT_META_INSTRUCTIONS = [
  "You will receive a hidden marker like [[OC=...]] inside the prompt.",
  "Do not repeat the marker in your answer.",
  "Answer normally and ignore the marker.",
].join("\n");

// ChatGPT "Thinking" currently supports up to 128k input tokens.
// We use the OpenAI rule of thumb (~4 chars/token) to keep a local
// character guardrail aligned with ChatGPT-scale inputs.
const DEFAULT_CHATGPT_MAX_INPUT_TOKENS = 128_000;
const APPROX_CHARS_PER_TOKEN = 4;
const DEFAULT_CHATGPT_MAX_INPUT_CHARS = DEFAULT_CHATGPT_MAX_INPUT_TOKENS * APPROX_CHARS_PER_TOKEN;

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  const lowered = value.trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(lowered)) return true;
  if (["0", "false", "no", "n", "off"].includes(lowered)) return false;
  return fallback;
}

function parseNumber(value: string | undefined, fallback: number, min = 0): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || Number.isNaN(parsed)) return fallback;
  return Math.max(parsed, min);
}

function parseLogLevel(value: string | undefined): BridgeConfig["logLevel"] {
  if (value === "debug" || value === "info" || value === "warn" || value === "error") {
    return value;
  }
  return "info";
}

function parseLogFormat(value: string | undefined): BridgeConfig["logFormat"] {
  if (value === "pretty" || value === "json") {
    return value;
  }
  return "json";
}

function parseRawExchangeLogPrivacyMode(value: string | undefined): RawExchangeLogPrivacyMode {
  if (value === "safe_raw" || value === "header_only" || value === "metadata_only") {
    return value;
  }
  return "safe_raw";
}

function parseBridgeMode(value: string | undefined): BridgeMode {
  if (value === "http" || value === "mcp") {
    return value;
  }
  return "mcp";
}

function parseSessionBindingMode(value: string | undefined): SessionBindingMode {
  if (value === "off" || value === "sticky" || value === "explicit") {
    return value;
  }
  return "off";
}

function normalizeSlot(value: string | undefined): string {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return "default";
  }
  return normalized;
}

function expandHomePath(pathValue: string): string {
  if (pathValue === "~") {
    return homedir();
  }
  if (pathValue.startsWith("~/")) {
    return resolve(homedir(), pathValue.slice(2));
  }
  return pathValue;
}

function parseUiPatterns(value: string | undefined): UiErrorPattern[] {
  if (!value) {
    return DEFAULT_UI_ERROR_PATTERNS;
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) {
      return DEFAULT_UI_ERROR_PATTERNS;
    }

    const normalized = parsed
      .map((item) => {
        if (!item || typeof item !== "object") return null;
        const code = (item as { code?: unknown }).code;
        const includes = (item as { includes?: unknown }).includes;
        if (typeof code !== "string" || !Array.isArray(includes)) return null;
        const list = includes.filter((v): v is string => typeof v === "string" && v.length > 0);
        if (list.length === 0) return null;
        return { code, includes: list };
      })
      .filter((item): item is UiErrorPattern => item !== null);

    return normalized.length > 0 ? normalized : DEFAULT_UI_ERROR_PATTERNS;
  } catch {
    return DEFAULT_UI_ERROR_PATTERNS;
  }
}

function parsePathList(value: string | undefined): string[] {
  if (!value) {
    return [];
  }

  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => resolve(expandHomePath(entry)));
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BridgeConfig {
  const maxWaitSec = parseNumber(env.MAX_WAIT_SEC, 3600, 1);
  const jobTimeoutMs = parseNumber(env.JOB_TIMEOUT_MS, 3615000, 1000);
  const minimumTimeoutMs = (maxWaitSec + 15) * 1000;
  const effectiveJobTimeoutMs = Math.max(jobTimeoutMs, minimumTimeoutMs);

  const markerSecretFromEnv = env.MARKER_SECRET?.trim();
  const markerSecret = markerSecretFromEnv || randomBytes(32).toString("base64url");
  const sessionBindingsPath = expandHomePath(
    env.SESSION_BINDINGS_PATH || "~/.openclaw/chatgpt-pro-bridge/session-bindings.json",
  );
  const defaultRawExchangePath = resolve(dirname(sessionBindingsPath), "logs", "raw-exchanges.jsonl");

  return {
    version: env.BRIDGE_VERSION || "1.1.0",
    bridgeMode: parseBridgeMode(env.BRIDGE_MODE),
    httpHost: env.HTTP_HOST || "127.0.0.1",
    httpPort: parseNumber(env.HTTP_PORT, 19000, 1),
    chatgptBridgeToken: env.CHATGPT_BRIDGE_TOKEN || "",
    httpBodyLimit: env.HTTP_BODY_LIMIT || "256kb",

    maxQueueSize: parseNumber(env.MAX_QUEUE_SIZE, 20, 1),
    jobTimeoutMs,
    effectiveJobTimeoutMs,
    jobTimeoutClamped: effectiveJobTimeoutMs !== jobTimeoutMs,

    maxWaitSec,
    pollIntervalSec: parseNumber(env.POLL_INTERVAL_SEC, 1, 1),
    stableChecks: parseNumber(env.STABLE_CHECKS, 3, 1),
    extractNoIndicatorStableMs: parseNumber(env.EXTRACT_NO_INDICATOR_STABLE_MS, 15_000, 0),
    scrapeCallTimeoutMs: parseNumber(env.SCRAPE_CALL_TIMEOUT_MS, 15_000, 1),

    maxPromptChars: parseNumber(env.MAX_PROMPT_CHARS, DEFAULT_CHATGPT_MAX_INPUT_CHARS, 1),
    maxMessageChars: parseNumber(env.MAX_MESSAGE_CHARS, DEFAULT_CHATGPT_MAX_INPUT_CHARS, 1),
    fileContextEnabled: parseBoolean(env.FILE_CONTEXT_ENABLED, true),
    fileContextAllowedRoots: parsePathList(env.FILE_CONTEXT_ALLOWED_ROOTS),
    fileContextMaxFiles: parseNumber(env.FILE_CONTEXT_MAX_FILES, 8, 1),
    fileContextMaxFileChars: parseNumber(env.FILE_CONTEXT_MAX_FILE_CHARS, 200000, 1),
    fileContextMaxTotalChars: parseNumber(env.FILE_CONTEXT_MAX_TOTAL_CHARS, 400000, 1),

    rateLimitRpm: parseNumber(env.RATE_LIMIT_RPM, 10, 1),
    rateLimitBurst: parseNumber(env.RATE_LIMIT_BURST, 2, 1),

    uiLabelNewChat: env.UI_LABEL_NEW_CHAT || "New chat",
    uiLabelRegenerate: env.UI_LABEL_REGENERATE || "Regenerate",
    uiLabelContinue: env.UI_LABEL_CONTINUE || "Continue generating",
    requireCompletionIndicators: parseBoolean(env.REQUIRE_COMPLETION_INDICATORS, false),

    uiErrorPatterns: parseUiPatterns(env.UI_ERROR_PATTERNS_JSON),

    resetChatEachRequest: parseBoolean(env.RESET_CHAT_EACH_REQUEST, false),
    resetStrict: parseBoolean(env.RESET_STRICT, true),
    sessionBindingMode: parseSessionBindingMode(env.SESSION_BINDING_MODE),
    sessionDefaultSlot: normalizeSlot(env.SESSION_DEFAULT_SLOT),
    sessionBindingsPath,
    sessionBindingStrictOpen: parseBoolean(env.SESSION_BINDING_STRICT_OPEN, false),

    markerSecret,
    markerSecretEphemeral: !markerSecretFromEnv,
    metaInstructions: env.META_INSTRUCTIONS || DEFAULT_META_INSTRUCTIONS,

    logLevel: parseLogLevel(env.LOG_LEVEL),
    logFormat: parseLogFormat(env.LOG_FORMAT),
    logIncludeAxDump: parseBoolean(env.LOG_INCLUDE_AX_DUMP, false),
    rawExchangeLogEnabled: parseBoolean(env.RAW_EXCHANGE_LOG_ENABLED, true),
    rawExchangeLogPath: expandHomePath(env.RAW_EXCHANGE_LOG_PATH || defaultRawExchangePath),
    rawExchangeLogMaxBytes: parseNumber(env.RAW_EXCHANGE_LOG_MAX_BYTES, 64 * 1024 * 1024, 1),
    rawExchangeLogMaxFiles: parseNumber(env.RAW_EXCHANGE_LOG_MAX_FILES, 20, 1),
    rawExchangeLogMaxAgeDays: parseNumber(env.RAW_EXCHANGE_LOG_MAX_AGE_DAYS, 30, 0),
    rawExchangeLogPrivacyMode: parseRawExchangeLogPrivacyMode(env.RAW_EXCHANGE_LOG_PRIVACY),
  };
}

export function validateHttpModeConfig(config: BridgeConfig): void {
  if (config.bridgeMode === "http" && !config.chatgptBridgeToken) {
    throw new Error("CHATGPT_BRIDGE_TOKEN is required when BRIDGE_MODE=http");
  }
}
