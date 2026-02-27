import { type Logger } from "pino";
import type { BridgeConfig } from "../config.js";
import { BridgeError, isBridgeError, toBridgeError, type BridgeErrorCode } from "../errors.js";
import { Mutex } from "../utils/mutex.js";
import { detectUiError } from "./detectErrors.js";
import { escapeAppleScriptString, runAppleScriptStrict } from "./applescript.js";
import { extractAfterMarkerWithSnapshotFallback, hasBridgeMarkerInAnchor } from "./extract.js";
import { matchMarkerInScrapedText } from "./markerMatch.js";
import { resetToNewChat } from "./reset.js";
import { scrapeConversationText } from "./scrape.js";

const clipboardMutex = new Mutex();
const POLL_UI_RECOVERY_GRACE_MS = 120_000;
const POLL_PROGRESS_LOG_MS = 30_000;
const POLL_SCRAPE_TIMEOUT_GRACE_MS = 120_000;
const POLL_SCRAPE_TIMEOUT_BACKOFF_STEP_MS = 5_000;
const POLL_SCRAPE_TIMEOUT_BACKOFF_MAX_MS = 60_000;

export interface DriverAskOptions {
  prompt: string;
  marker: string;
  requestId: string;
  conversationId?: string;
  strictOpen: boolean;
  resetEachRequest: boolean;
  resetStrict: boolean;
}

export interface DriverAskResult {
  text: string;
  contextReset: 0 | 1;
  openedConversationId?: string;
  extractionMode?: "marker" | "snapshot_delta";
}

export interface UiAutomationHealth {
  ok: boolean;
  accessibility: "granted" | "denied" | "unknown";
  appRunning: boolean | null;
  code?: BridgeErrorCode;
  message?: string;
}

export interface ChatGPTDriver {
  ensureRunning(): Promise<void>;
  ask(options: DriverAskOptions): Promise<DriverAskResult>;
  getConversations(requestId: string): Promise<string[]>;
  getUiAutomationHealth?(): Promise<UiAutomationHealth>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface PollResult {
  fullText: string;
  extractedText: string;
  extractionMode: "marker" | "snapshot_delta";
}

export class ChatGPTAppDriver implements ChatGPTDriver {
  private readonly config: BridgeConfig;
  private readonly logger: Logger;

  public constructor(config: BridgeConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;
  }

  public async getUiAutomationHealth(): Promise<UiAutomationHealth> {
    try {
      const isRunning = await runAppleScriptStrict(`
        tell application "System Events"
          return application process "ChatGPT" exists
        end tell
      `);

      const appRunning = isRunning.trim().toLowerCase() === "true";
      if (!appRunning) {
        return {
          ok: false,
          accessibility: "granted",
          appRunning: false,
          code: "app_not_running",
          message: "ChatGPT app is not running",
        };
      }

      await this.ensureWindowAvailable();

      const probeResult = await runAppleScriptStrict(`
        tell application "ChatGPT" to activate
        delay 0.1

        tell application "System Events"
          tell process "ChatGPT"
            if not (exists window 1) then
              return "no_window"
            end if

            -- Force an AX traversal similar to prompt-focus flow. This fails
            -- with accessibility-denied when the bridge process lacks assistive
            -- access permissions.
            set _probeElements to entire contents of window 1
            return "ok"
          end tell
        end tell
      `);

      if (probeResult.trim().toLowerCase() === "no_window") {
        return {
          ok: false,
          accessibility: "granted",
          appRunning: true,
          code: "ui_element_not_found",
          message: "No ChatGPT window found",
        };
      }

      return {
        ok: true,
        accessibility: "granted",
        appRunning: true,
      };
    } catch (error) {
      const bridgeError = toBridgeError(error, "UI automation preflight failed");
      if (bridgeError.code === "accessibility_denied") {
        return {
          ok: false,
          accessibility: "denied",
          appRunning: null,
          code: bridgeError.code,
          message: bridgeError.message,
        };
      }

      return {
        ok: false,
        accessibility: "unknown",
        appRunning: null,
        code: bridgeError.code,
        message: bridgeError.message,
      };
    }
  }

  public async ensureRunning(): Promise<void> {
    const isRunning = await runAppleScriptStrict(`
      tell application "System Events"
        return application process "ChatGPT" exists
      end tell
    `);

    if (isRunning.trim().toLowerCase() === "true") {
      return;
    }

    await runAppleScriptStrict(`
      tell application "ChatGPT" to activate
      delay 1
    `);

    const isRunningAfterActivate = await runAppleScriptStrict(`
      tell application "System Events"
        return application process "ChatGPT" exists
      end tell
    `);

    if (isRunningAfterActivate.trim().toLowerCase() !== "true") {
      throw new BridgeError("app_not_running", "ChatGPT app is not running");
    }
  }

  public async ask(options: DriverAskOptions): Promise<DriverAskResult> {
    const start = Date.now();
    let contextReset: 0 | 1 = 0;

    try {
      await this.ensureRunning();
      await this.ensureWindowAvailable(options.requestId);
      this.logger.info({ rid: options.requestId, event: "activate_app", durationMs: Date.now() - start }, "activate_app");

      if (options.resetEachRequest) {
        const resetStartedAt = Date.now();
        const resetOk = await resetToNewChat(this.config.uiLabelNewChat);
        if (resetOk) {
          contextReset = 1;
          // Wait for the new chat UI to fully render (input area, etc.)
          await sleep(1500);
          this.logger.info(
            { rid: options.requestId, event: "reset_chat", contextReset, durationMs: Date.now() - resetStartedAt },
            "reset_chat",
          );
        } else if (options.resetStrict) {
          throw new BridgeError("ui_reset_failed", "Reset to new chat failed");
        } else {
          this.logger.warn(
            {
              rid: options.requestId,
              event: "reset_chat",
              contextReset,
              resetFailed: true,
              durationMs: Date.now() - resetStartedAt,
            },
            "reset_chat",
          );
        }
      }

      const extractionAnchor = options.prompt;
      const preSendSnapshot = await this.capturePreSendSnapshot(options.requestId);

      const openedConversationId = await this.sendPromptWithClipboard(
        options.prompt,
        options.conversationId,
        options.strictOpen,
        options.requestId,
      );

      const scrapeStartedAt = Date.now();
      const pollResult = await this.pollForStableText(
        options.requestId,
        options.marker,
        extractionAnchor,
        preSendSnapshot,
      );
      this.logger.debug(
        {
          rid: options.requestId,
          event: "scrape_poll",
          durationMs: Date.now() - scrapeStartedAt,
          textLength: pollResult.fullText.length,
          extractedLength: pollResult.extractedText.length,
          extractionMode: pollResult.extractionMode,
        },
        "scrape_poll",
      );

      this.logger.info(
        {
          rid: options.requestId,
          event: "extract_done",
          contextReset,
          durationMs: Date.now() - start,
          textLength: pollResult.extractedText.length,
          extractionMode: pollResult.extractionMode,
        },
        "extract_done",
      );

      return {
        text: pollResult.extractedText,
        contextReset,
        openedConversationId,
        extractionMode: pollResult.extractionMode,
      };
    } catch (error) {
      const bridgeError = toBridgeError(error, "Failed to interact with ChatGPT app");
      bridgeError.details = {
        ...(bridgeError.details ?? {}),
        contextReset,
      };
      this.logger.error(
        {
          rid: options.requestId,
          event: "ask_failed",
          contextReset,
          durationMs: Date.now() - start,
          errorCode: bridgeError.code,
          details: bridgeError.details,
        },
        bridgeError.message,
      );
      throw bridgeError;
    }
  }

  private async capturePreSendSnapshot(requestId: string): Promise<string> {
    try {
      const snapshot = await scrapeConversationText({
        includeDescriptions: false,
        timeoutMs: this.config.scrapeCallTimeoutMs,
      });
      this.logger.debug(
        {
          rid: requestId,
          event: "scrape_snapshot_before_send",
          textLength: snapshot.length,
        },
        "scrape_snapshot_before_send",
      );
      return snapshot;
    } catch (error) {
      const bridgeError = isBridgeError(error) ? error : toBridgeError(error, "Failed to capture pre-send snapshot");
      this.logger.warn(
        {
          rid: requestId,
          event: "scrape_snapshot_before_send_failed",
          errorCode: bridgeError.code,
          details: bridgeError.details,
        },
        "scrape_snapshot_before_send_failed",
      );
      return "";
    }
  }

  public async getConversations(requestId: string): Promise<string[]> {
    const startedAt = Date.now();
    await this.ensureRunning();
    await this.ensureWindowAvailable(requestId);

    const result = await runAppleScriptStrict(`
      tell application "ChatGPT" to activate
      delay 0.5

      tell application "System Events"
        tell process "ChatGPT"
          if not (exists window 1) then
            return "__NO_WINDOW__"
          end if

          set allUIElements to entire contents of window 1
          set conversationsList to {}

          repeat with e in allUIElements
            try
              if (role of e) is "AXButton" then
                set buttonName to name of e
                if buttonName is not missing value and buttonName is not "" and buttonName is not "${escapeAppleScriptString(this.config.uiLabelNewChat)}" then
                  set end of conversationsList to buttonName
                end if
              end if
            end try
          end repeat

          if (count of conversationsList) = 0 then
            return ""
          end if

          set AppleScript's text item delimiters to linefeed
          return conversationsList as text
        end tell
      end tell
    `);

    if (result === "__NO_WINDOW__") {
      throw new BridgeError("ui_element_not_found", "No ChatGPT window found");
    }

    const unique = [...new Set(result.split("\n").map((s) => s.trim()).filter((s) => s.length > 0))];

    this.logger.info(
      {
        rid: requestId,
        event: "get_conversations",
        durationMs: Date.now() - startedAt,
        count: unique.length,
      },
      "get_conversations",
    );

    return unique;
  }

  private async sendPromptWithClipboard(
    prompt: string,
    conversationId: string | undefined,
    strictOpen: boolean,
    requestId: string,
  ): Promise<string | undefined> {
    const startedAt = Date.now();
    let openedConversationId: string | undefined;

    await clipboardMutex.runExclusive(async () => {
      let originalClipboard = "";

      try {
        originalClipboard = await runAppleScriptStrict("return the clipboard as text");
      } catch {
        originalClipboard = "";
      }

      try {
        await runAppleScriptStrict(`set the clipboard to "${escapeAppleScriptString(prompt)}"`);

        if (conversationId) {
          const openStatus = await this.tryOpenConversationByName(conversationId);
          if (openStatus === "opened") {
            openedConversationId = conversationId;
          } else if (strictOpen) {
            throw new BridgeError("conversation_not_found", "Requested conversation was not found in ChatGPT sidebar", {
              conversationId,
            });
          } else {
            this.logger.warn(
              {
                rid: requestId,
                event: "conversation_not_found",
                conversationId,
                strictOpen,
              },
              "conversation_not_found",
            );
          }
        }

        const focusResult = await this.focusPromptInput(requestId);
        if (focusResult.success) {
          this.logger.info(
            {
              rid: requestId,
              event: "focus_input",
              strategy: focusResult.strategy,
              fallback: focusResult.fallback,
            },
            "focus_input",
          );
        } else {
          this.logger.warn(
            {
              rid: requestId,
              event: "focus_input",
              strategy: focusResult.strategy,
              fallback: focusResult.fallback,
              success: false,
            },
            "focus_input_failed",
          );
        }

        await runAppleScriptStrict(`
          tell application "ChatGPT" to activate
          delay 0.3

          tell application "System Events"
            tell process "ChatGPT"
              keystroke "a" using {command down}
              key code 51
              delay 0.2
              keystroke "v" using {command down}
              delay 0.8
              -- Submit: Return, then Cmd+Return as fallback
              key code 36
              delay 0.5
              keystroke return using {command down}
            end tell
          end tell
        `);
      } finally {
        await runAppleScriptStrict(`set the clipboard to "${escapeAppleScriptString(originalClipboard)}"`);
      }
    });

    this.logger.info(
      {
        rid: requestId,
        event: "send_prompt",
        durationMs: Date.now() - startedAt,
      },
      "send_prompt",
    );

    return openedConversationId;
  }

  private async ensureWindowAvailable(requestId?: string): Promise<void> {
    const windowReady = await runAppleScriptStrict(`
      tell application "ChatGPT" to activate
      delay 0.1

      tell application "System Events"
        tell process "ChatGPT"
          if (exists window 1) then
            return "ok"
          end if
        end tell
      end tell

      tell application "ChatGPT" to reopen
      delay 0.4

      tell application "System Events"
        tell process "ChatGPT"
          if (exists window 1) then
            return "reopened"
          end if
        end tell
      end tell

      tell application "System Events"
        tell process "ChatGPT"
          keystroke "n" using {command down}
        end tell
      end tell
      delay 0.5

      tell application "System Events"
        tell process "ChatGPT"
          if (exists window 1) then
            return "shortcut"
          end if
        end tell
      end tell

      return "none"
    `);

    const normalized = windowReady.trim().toLowerCase();
    if (normalized === "ok") {
      return;
    }

    if (normalized === "reopened" || normalized === "shortcut") {
      this.logger.info(
        {
          rid: requestId,
          event: "window_recovered",
          strategy: normalized,
        },
        "window_recovered",
      );
      return;
    }

    throw new BridgeError("ui_element_not_found", "No ChatGPT window found");
  }

  private async tryOpenConversationByName(conversationId: string): Promise<"opened" | "not_found"> {
    const opened = await runAppleScriptStrict(`
      tell application "ChatGPT" to activate
      delay 0.2

      tell application "System Events"
        tell process "ChatGPT"
          if not (exists window 1) then
            return "false"
          end if

          set targetName to "${escapeAppleScriptString(conversationId)}"
          set allUIElements to entire contents of window 1
          set didOpen to false

          repeat with e in allUIElements
            try
              if (role of e) is "AXButton" and (name of e) is targetName then
                click e
                set didOpen to true
                exit repeat
              end if
            end try
          end repeat

          return didOpen
        end tell
      end tell
    `);

    if (opened.trim().toLowerCase() !== "true") {
      return "not_found";
    }

    return "opened";
  }

  private async focusPromptInput(
    requestId: string,
  ): Promise<{ success: boolean; strategy: "ax_input" | "window_bottom_click" | "tab_cycle" | "none"; fallback: boolean }> {
    const primaryResult = await runAppleScriptStrict(`
      tell application "ChatGPT" to activate
      delay 0.1

      tell application "System Events"
        tell process "ChatGPT"
          if not (exists window 1) then
            return "none"
          end if

          set allUIElements to entire contents of window 1
          repeat with e in allUIElements
            try
              if (role of e) is "AXTextArea" then
                click e
                return "ax_input"
              end if

              if (role of e) is "AXTextField" then
                click e
                return "ax_input"
              end if
            end try
          end repeat

          return "none"
        end tell
      end tell
    `);

    if (primaryResult.trim().toLowerCase() === "ax_input") {
      return { success: true, strategy: "ax_input", fallback: false };
    }

    const fallbackResult = await runAppleScriptStrict(`
      tell application "ChatGPT" to activate
      delay 0.1

      tell application "System Events"
        tell process "ChatGPT"
          if not (exists window 1) then
            return "none"
          end if

          try
            set frontWin to front window
            set winPos to position of frontWin
            set winSize to size of frontWin
            set clickX to (item 1 of winPos) + ((item 1 of winSize) / 2)
            set clickY to (item 2 of winPos) + ((item 2 of winSize) - 120)
            click at {clickX, clickY}
            return "window_bottom_click"
          on error
            try
              repeat 3 times
                key code 48
              end repeat
              return "tab_cycle"
            on error
              return "none"
            end try
          end try
        end tell
      end tell
    `);

    const normalizedFallback = fallbackResult.trim().toLowerCase();
    if (normalizedFallback === "window_bottom_click") {
      return { success: true, strategy: "window_bottom_click", fallback: true };
    }

    if (normalizedFallback === "tab_cycle") {
      this.logger.warn({ rid: requestId, event: "focus_input_tab_fallback" }, "focus_input_tab_fallback");
      return { success: true, strategy: "tab_cycle", fallback: true };
    }

    return { success: false, strategy: "none", fallback: true };
  }

  private async pollForStableText(
    requestId: string,
    marker: string,
    extractionAnchor: string = marker,
    previousFullText: string = "",
  ): Promise<PollResult> {
    const maxDurationMs = this.config.maxWaitSec * 1000;
    const intervalMs = this.config.pollIntervalSec * 1000;
    const scrapeTimeoutGraceMs = Math.max(POLL_SCRAPE_TIMEOUT_GRACE_MS, maxDurationMs);
    const deadline = Date.now() + maxDurationMs;

    let previousText = "";
    let previousExtractedNormalized = "";
    let previousExtractionMode: PollResult["extractionMode"] | null = null;
    let stableExtractedSinceMs: number | null = null;
    let stableCount = 0;
    let latestText = "";
    let uiUnavailableSince: number | null = null;
    let uiRecoveryAttempts = 0;
    let scrapeTimeoutSince: number | null = null;
    let scrapeTimeoutAttempts = 0;
    let scrapeCallTimeoutMs = this.config.scrapeCallTimeoutMs;
    let nextProgressLogAt = Date.now() + POLL_PROGRESS_LOG_MS;
    const bridgeMarkerExpected = hasBridgeMarkerInAnchor(extractionAnchor);

    const regenerateLower = this.config.uiLabelRegenerate.toLowerCase();
    const continueLower = this.config.uiLabelContinue.toLowerCase();
    const resetStabilityState = (): void => {
      stableCount = 0;
      stableExtractedSinceMs = null;
      previousExtractedNormalized = "";
      previousExtractionMode = null;
    };

    while (Date.now() < deadline) {
      await sleep(intervalMs);
      try {
        latestText = await scrapeConversationText({
          // Polling only needs visible static text; avoiding AXDescription
          // drastically reduces AX traversal cost on long conversations.
          includeDescriptions: false,
          timeoutMs: scrapeCallTimeoutMs,
        });
      } catch (error) {
        const bridgeError = isBridgeError(error) ? error : toBridgeError(error, "Failed to scrape ChatGPT response");
        const isRecoverableUiError = bridgeError.code === "ui_element_not_found" || bridgeError.code === "app_not_running";
        const isRecoverableScrapeTimeout = bridgeError.code === "timeout";

        if (!isRecoverableUiError && !isRecoverableScrapeTimeout) {
          throw bridgeError;
        }

        if (isRecoverableScrapeTimeout) {
          const now = Date.now();
          if (scrapeTimeoutSince === null) {
            scrapeTimeoutSince = now;
          }
          scrapeTimeoutAttempts += 1;
          const unavailableMs = now - scrapeTimeoutSince;

          this.logger.warn(
            {
              rid: requestId,
              event: "scrape_poll_timeout",
              unavailableMs,
              attempts: scrapeTimeoutAttempts,
              timeoutMs: scrapeCallTimeoutMs,
              graceMs: scrapeTimeoutGraceMs,
              details: bridgeError.details,
            },
            "scrape_poll_timeout",
          );

          if (unavailableMs >= scrapeTimeoutGraceMs) {
            throw new BridgeError("timeout", "Timed out scraping ChatGPT response", {
              duringPoll: true,
              reason: "scrape_timeout",
              unavailableMs,
              attempts: scrapeTimeoutAttempts,
              scrapeCallTimeoutMs,
              graceMs: scrapeTimeoutGraceMs,
            });
          }

          const nextScrapeCallTimeoutMs = Math.min(
            scrapeCallTimeoutMs + POLL_SCRAPE_TIMEOUT_BACKOFF_STEP_MS,
            POLL_SCRAPE_TIMEOUT_BACKOFF_MAX_MS,
          );
          if (nextScrapeCallTimeoutMs !== scrapeCallTimeoutMs) {
            this.logger.info(
              {
                rid: requestId,
                event: "scrape_poll_timeout_backoff",
                fromTimeoutMs: scrapeCallTimeoutMs,
                toTimeoutMs: nextScrapeCallTimeoutMs,
              },
              "scrape_poll_timeout_backoff",
            );
            scrapeCallTimeoutMs = nextScrapeCallTimeoutMs;
          }

          resetStabilityState();
          continue;
        }

        const now = Date.now();
        if (uiUnavailableSince === null) {
          uiUnavailableSince = now;
        }
        uiRecoveryAttempts += 1;
        const unavailableMs = now - uiUnavailableSince;

        this.logger.warn(
          {
            rid: requestId,
            event: "scrape_poll_ui_unavailable",
            errorCode: bridgeError.code,
            unavailableMs,
            attempts: uiRecoveryAttempts,
          },
          "scrape_poll_ui_unavailable",
        );

        try {
          await this.ensureRunning();
          await this.ensureWindowAvailable(requestId);
        } catch (recoverError) {
          const recoverBridgeError = isBridgeError(recoverError)
            ? recoverError
            : toBridgeError(recoverError, "Failed to recover ChatGPT UI automation");
          this.logger.warn(
            {
              rid: requestId,
              event: "scrape_poll_ui_recovery_attempt_failed",
              errorCode: recoverBridgeError.code,
              unavailableMs,
              attempts: uiRecoveryAttempts,
            },
            "scrape_poll_ui_recovery_attempt_failed",
          );
        }

        if (unavailableMs >= POLL_UI_RECOVERY_GRACE_MS) {
          throw new BridgeError("ui_element_not_found", "No ChatGPT window found", {
            duringPoll: true,
            unavailableMs,
            attempts: uiRecoveryAttempts,
          });
        }

        resetStabilityState();
        continue;
      }

      if (scrapeTimeoutSince !== null) {
        this.logger.info(
          {
            rid: requestId,
            event: "scrape_poll_timeout_recovered",
            unavailableMs: Date.now() - scrapeTimeoutSince,
            attempts: scrapeTimeoutAttempts,
          },
          "scrape_poll_timeout_recovered",
        );
        if (scrapeCallTimeoutMs !== this.config.scrapeCallTimeoutMs) {
          this.logger.info(
            {
              rid: requestId,
              event: "scrape_poll_timeout_backoff_reset",
              timeoutMs: this.config.scrapeCallTimeoutMs,
            },
            "scrape_poll_timeout_backoff_reset",
          );
          scrapeCallTimeoutMs = this.config.scrapeCallTimeoutMs;
        }
        scrapeTimeoutSince = null;
        scrapeTimeoutAttempts = 0;
      }

      if (uiUnavailableSince !== null) {
        this.logger.info(
          {
            rid: requestId,
            event: "scrape_poll_ui_recovered",
            unavailableMs: Date.now() - uiUnavailableSince,
            attempts: uiRecoveryAttempts,
          },
          "scrape_poll_ui_recovered",
        );
        uiUnavailableSince = null;
        uiRecoveryAttempts = 0;
      }

      const detectedError = detectUiError(latestText, this.config.uiErrorPatterns);
      if (detectedError) {
        throw detectedError;
      }

      // Keep marker visibility for diagnostics, but never treat it alone as a
      // completion signal. Prompt text appears immediately and can stay stable
      // while ChatGPT is still thinking.
      const markerMatch = matchMarkerInScrapedText(latestText, marker);
      const hasMarker = markerMatch.hasMarker;
      // Seeing the marker alone is not enough; the prompt itself appears in AX
      // immediately after submission and can stay stable while ChatGPT is still
      // thinking. Require a truly extractable response segment.
      const extractedCandidate = this.tryExtractableResponse(latestText, extractionAnchor, previousFullText);
      const hasExtractableResponse = extractedCandidate !== null;
      const extractedNormalized = extractedCandidate ? this.normalizeForStableCompare(extractedCandidate.text) : "";
      const extractionMode = extractedCandidate?.mode ?? null;

      const isSameAsPrevious = latestText === previousText;
      const isSameAsPreviousExtracted =
        extractedNormalized.length > 0
        && extractedNormalized === previousExtractedNormalized
        && extractionMode === previousExtractionMode;
      const hasTypingCursor = latestText.includes("▍");
      const lowerText = latestText.toLowerCase();
      const hasCompletionIndicators = lowerText.includes(regenerateLower) || lowerText.includes(continueLower);
      const indicatorOk = !this.config.requireCompletionIndicators || hasCompletionIndicators;
      const noIndicatorStableMs = this.config.extractNoIndicatorStableMs;
      const now = Date.now();
      if (!hasExtractableResponse) {
        stableExtractedSinceMs = null;
      } else if (extractedNormalized !== previousExtractedNormalized) {
        stableExtractedSinceMs = now;
      } else if (stableExtractedSinceMs === null) {
        stableExtractedSinceMs = now;
      }
      const stableExtractedMs = stableExtractedSinceMs === null ? 0 : now - stableExtractedSinceMs;
      const noIndicatorStableEnough = hasCompletionIndicators || stableExtractedMs >= noIndicatorStableMs;
      const completionGatePassed = indicatorOk && noIndicatorStableEnough;
      const markerGatePassed = !bridgeMarkerExpected || (hasMarker && extractionMode === "marker");
      const doneCandidate =
        hasExtractableResponse
        && isSameAsPreviousExtracted
        && !hasTypingCursor
        && completionGatePassed
        && markerGatePassed
        && extractionMode !== null
        && latestText.length > 0;
      stableCount = doneCandidate ? stableCount + 1 : 0;

      this.logger.debug(
        {
          rid: requestId,
          event: "scrape_poll",
          stableCount,
          textLength: latestText.length,
          hasMarker,
          hasExtractableResponse,
          extractedLength: extractedCandidate?.text.length ?? 0,
          extractionMode,
          bridgeMarkerExpected,
          markerGatePassed,
          markerMatchMode: markerMatch.mode,
          isSameAsPrevious,
          isSameAsPreviousExtracted,
          hasTypingCursor,
          hasCompletionIndicators,
          indicatorOk,
          stableExtractedMs,
          noIndicatorStableMs,
          completionGatePassed,
        },
        "scrape_poll",
      );

      if (Date.now() >= nextProgressLogAt) {
        this.logger.info(
          {
            rid: requestId,
            event: "scrape_poll_progress",
            elapsedMs: maxDurationMs - Math.max(0, deadline - Date.now()),
            stableCount,
            textLength: latestText.length,
            hasMarker,
            hasExtractableResponse,
            extractedLength: extractedCandidate?.text.length ?? 0,
            extractionMode,
            bridgeMarkerExpected,
            markerGatePassed,
            hasTypingCursor,
            hasCompletionIndicators,
            stableExtractedMs,
            noIndicatorStableMs,
            completionGatePassed,
          },
          "scrape_poll_progress",
        );
        nextProgressLogAt = Date.now() + POLL_PROGRESS_LOG_MS;
      }

      previousText = latestText;
      previousExtractedNormalized = extractedNormalized;
      previousExtractionMode = extractionMode;

      if (stableCount >= this.config.stableChecks && extractedCandidate) {
        return {
          fullText: latestText,
          extractedText: extractedCandidate.text,
          extractionMode: extractedCandidate.mode,
        };
      }
    }

    throw new BridgeError("timeout", "Timed out waiting for ChatGPT response", {
      maxWaitSec: this.config.maxWaitSec,
    });
  }

  private tryExtractableResponse(
    latestText: string,
    extractionAnchor: string,
    previousFullText: string,
  ): { text: string; mode: "marker" | "snapshot_delta" } | null {
    if (extractionAnchor.length === 0) {
      return null;
    }

    try {
      const extracted = extractAfterMarkerWithSnapshotFallback(latestText, extractionAnchor, {
        uiLabelRegenerate: this.config.uiLabelRegenerate,
        uiLabelContinue: this.config.uiLabelContinue,
      }, { previousFullText });
      return extracted.text.trim().length > 0 ? extracted : null;
    } catch {
      return null;
    }
  }

  private normalizeForStableCompare(value: string): string {
    return value.replace(/\r\n/g, "\n").replace(/\s+/g, " ").trim();
  }
}
