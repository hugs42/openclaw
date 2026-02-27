#!/usr/bin/env node

import { loadConfig, validateHttpModeConfig } from "./src/config.js";
import { startHttpServer } from "./src/http/server.js";
import { createLogger } from "./src/logger.js";
import { startMcpServer } from "./src/mcp/server.js";
import { FileRawExchangeLogger, NoopRawExchangeLogger } from "./src/rawExchangeLog.js";
import { FileSessionBindingStore } from "./src/session/store.js";
import { ChatGPTAppDriver } from "./src/ui/chatgptApp.js";
import { SingleFlightQueue } from "./src/utils/queue.js";
import { TokenBucketRateLimiter } from "./src/utils/rateLimit.js";

const config = loadConfig(process.env);
const logger = createLogger({ level: config.logLevel, format: config.logFormat });
const rawExchangeLogger = config.rawExchangeLogEnabled
  ? new FileRawExchangeLogger({
      filePath: config.rawExchangeLogPath,
      logger,
      policy: {
        maxBytes: config.rawExchangeLogMaxBytes,
        maxFiles: config.rawExchangeLogMaxFiles,
        maxAgeDays: config.rawExchangeLogMaxAgeDays,
        privacyMode: config.rawExchangeLogPrivacyMode,
      },
    })
  : new NoopRawExchangeLogger();

if (config.rawExchangeLogEnabled) {
  logger.info(
    {
      event: "raw_exchange_log_enabled",
      path: config.rawExchangeLogPath,
      maxBytes: config.rawExchangeLogMaxBytes,
      maxFiles: config.rawExchangeLogMaxFiles,
      maxAgeDays: config.rawExchangeLogMaxAgeDays,
      privacyMode: config.rawExchangeLogPrivacyMode,
    },
    "raw_exchange_log_enabled",
  );
} else {
  logger.info({ event: "raw_exchange_log_disabled" }, "raw_exchange_log_disabled");
}

if (config.markerSecretEphemeral) {
  logger.warn({ event: "config_warning", marker_secret_ephemeral: true }, "MARKER_SECRET missing, using ephemeral secret");
}

if (config.jobTimeoutClamped) {
  logger.warn(
    {
      event: "config_warning",
      jobTimeoutMs: config.jobTimeoutMs,
      effectiveJobTimeoutMs: config.effectiveJobTimeoutMs,
      maxWaitSec: config.maxWaitSec,
    },
    "JOB_TIMEOUT_MS was clamped to stay above MAX_WAIT_SEC",
  );
}

const queue = new SingleFlightQueue({
  maxSize: config.maxQueueSize,
  defaultTimeoutMs: config.effectiveJobTimeoutMs,
  onLateOutcome: (event) => {
    logger.warn(
      {
        event: "late_outcome_after_timeout",
        outcome: event.outcome,
        timeoutMs: event.timeoutMs,
        durationMs: event.durationMs,
        errorCode: event.errorCode,
      },
      "late_outcome_after_timeout",
    );
  },
});

const driver = new ChatGPTAppDriver(config, logger);
const rateLimiter = new TokenBucketRateLimiter({
  rpm: config.rateLimitRpm,
  burst: config.rateLimitBurst,
});

process.on("unhandledRejection", (reason) => {
  logger.error({ event: "unhandled_rejection", reason }, "unhandled_rejection");
});

process.on("uncaughtException", (error) => {
  logger.error({ event: "uncaught_exception", error }, "uncaught_exception");
});

if (config.bridgeMode === "http") {
  validateHttpModeConfig(config);
  const sessionBindingStore = new FileSessionBindingStore(config.sessionBindingsPath);
  await sessionBindingStore.load();

  await startHttpServer({
    config,
    logger,
    queue,
    driver,
    rateLimiter,
    sessionBindingStore,
    rawExchangeLogger,
  });
} else {
  await startMcpServer({
    config,
    logger,
    queue,
    driver,
    rawExchangeLogger,
  });
}
