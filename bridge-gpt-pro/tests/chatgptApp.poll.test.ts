import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { BridgeError } from "../src/errors.js";
import { createLogger } from "../src/logger.js";
import { runAppleScriptStrict } from "../src/ui/applescript.js";
import { ChatGPTAppDriver } from "../src/ui/chatgptApp.js";
import { scrapeConversationText } from "../src/ui/scrape.js";

vi.mock("../src/ui/scrape.js", () => ({
  scrapeConversationText: vi.fn(),
}));

vi.mock("../src/ui/applescript.js", () => ({
  runAppleScriptStrict: vi.fn(),
  escapeAppleScriptString: (value: string) => value,
}));

function buildDriver(overrides?: Record<string, string>): ChatGPTAppDriver {
  const config = loadConfig({
    ...process.env,
    MARKER_SECRET: "test-secret",
    MAX_WAIT_SEC: "4",
    POLL_INTERVAL_SEC: "1",
    STABLE_CHECKS: "1",
    EXTRACT_NO_INDICATOR_STABLE_MS: "0",
    ...(overrides ?? {}),
  });
  const logger = createLogger({ level: "error", format: "json" });
  return new ChatGPTAppDriver(config, logger);
}

type PollResult = {
  fullText: string;
  extractedText: string;
  extractionMode: "marker" | "snapshot_delta";
};
type PollFn = (requestId: string, markerValue: string, extractionAnchor?: string) => Promise<PollResult>;

describe("ChatGPTAppDriver.pollForStableText", () => {
  const scrapeMock = vi.mocked(scrapeConversationText);
  const appleScriptMock = vi.mocked(runAppleScriptStrict);

  beforeEach(() => {
    vi.clearAllMocks();
    appleScriptMock.mockImplementation(async (script: string) => {
      if (script.includes('application process "ChatGPT" exists')) {
        return "true";
      }
      if (script.includes("return \"ok\"") || script.includes("return \"reopened\"") || script.includes("return \"shortcut\"")) {
        return "ok";
      }
      return "";
    });
  });

  it("recovers from transient missing-window scrape errors", async () => {
    const driver = buildDriver({ MAX_WAIT_SEC: "8" });
    const marker = "[[OC=test.sig]]";
    const fullText = `${marker}\nRéponse CTO finale`;

    scrapeMock.mockRejectedValueOnce(new BridgeError("ui_element_not_found", "No ChatGPT window found"));
    scrapeMock.mockResolvedValueOnce(fullText);
    scrapeMock.mockResolvedValueOnce(fullText);

    const result = await (driver as unknown as { pollForStableText: (...args: Parameters<PollFn>) => Promise<PollResult> })
      .pollForStableText("rid-1", marker);

    expect(result.fullText).toBe(fullText);
    expect(result.extractedText).toBe("Réponse CTO finale");
    expect(result.extractionMode).toBe("marker");
    expect(appleScriptMock).toHaveBeenCalled();
  }, 12_000);

  it("keeps waiting and times out instead of failing immediately on persistent missing-window errors", async () => {
    const driver = buildDriver({ MAX_WAIT_SEC: "2" });
    const marker = "[[OC=test.sig]]";

    scrapeMock.mockRejectedValue(new BridgeError("ui_element_not_found", "No ChatGPT window found"));

    await expect(
      (driver as unknown as { pollForStableText: (...args: Parameters<PollFn>) => Promise<PollResult> })
        .pollForStableText("rid-2", marker),
    ).rejects.toMatchObject({ code: "timeout" });
  });

  it("completes when AX noise changes but extracted response stays stable", async () => {
    const driver = buildDriver({ MAX_WAIT_SEC: "8" });
    const marker = "[[OC=test.sig]]";
    const anchor = `Prompt heading\nPrompt body\n${marker}`;
    const first = `noise-a\n${anchor}\nRéponse CTO finale`;
    const second = `noise-b\n${anchor}\nRéponse CTO finale`;

    scrapeMock.mockResolvedValueOnce(first);
    scrapeMock.mockResolvedValueOnce(second);

    const result = await (driver as unknown as { pollForStableText: (...args: Parameters<PollFn>) => Promise<PollResult> })
      .pollForStableText("rid-3", marker, anchor);

    expect(result.fullText).toBe(second);
    expect(result.extractedText).toBe("Réponse CTO finale");
    expect(result.extractionMode).toBe("marker");
  });

  it("does not complete too early without completion indicators when stability window is configured", async () => {
    const driver = buildDriver({
      MAX_WAIT_SEC: "8",
      EXTRACT_NO_INDICATOR_STABLE_MS: "2500",
    });
    const marker = "[[OC=test.sig]]";
    const fullText = `${marker}\nRéponse CTO finale`;
    const startedAt = Date.now();

    scrapeMock.mockResolvedValue(fullText);

    const result = await (driver as unknown as { pollForStableText: (...args: Parameters<PollFn>) => Promise<PollResult> })
      .pollForStableText("rid-4", marker);
    const elapsedMs = Date.now() - startedAt;

    expect(result.fullText).toBe(fullText);
    expect(result.extractedText).toBe("Réponse CTO finale");
    expect(elapsedMs).toBeGreaterThanOrEqual(2500);
  });

  it("allows completion with explicit completion indicators", async () => {
    const driver = buildDriver({
      MAX_WAIT_SEC: "8",
      EXTRACT_NO_INDICATOR_STABLE_MS: "5000",
    });
    const marker = "[[OC=test.sig]]";
    const fullText = `${marker}\nRéponse CTO finale\nRegenerate`;
    const startedAt = Date.now();

    scrapeMock.mockResolvedValue(fullText);

    const result = await (driver as unknown as { pollForStableText: (...args: Parameters<PollFn>) => Promise<PollResult> })
      .pollForStableText("rid-5", marker);
    const elapsedMs = Date.now() - startedAt;

    expect(result.fullText).toBe(fullText);
    expect(result.extractedText).toBe("Réponse CTO finale");
    expect(elapsedMs).toBeLessThan(5000);
  });

  it("waits for the current marker before completing when stale text is present", async () => {
    const driver = buildDriver({
      MAX_WAIT_SEC: "8",
      EXTRACT_NO_INDICATOR_STABLE_MS: "900",
    });
    const marker = "[[OC=current.sig]]";
    const staleText = "[[OC=old.sig]]\nAncienne réponse stable";
    const currentText = `${marker}\nRéponse CTO finale`;

    scrapeMock
      .mockResolvedValueOnce(staleText)
      .mockResolvedValueOnce(staleText)
      .mockResolvedValueOnce(currentText)
      .mockResolvedValue(currentText);

    const result = await (driver as unknown as { pollForStableText: (...args: Parameters<PollFn>) => Promise<PollResult> })
      .pollForStableText("rid-6", marker);

    expect(result.fullText).toBe(currentText);
    expect(result.extractedText).toBe("Réponse CTO finale");
    expect(scrapeMock).toHaveBeenCalledTimes(4);
  });

  it("times out when bridge marker is not visible, even with stable stale text", async () => {
    const driver = buildDriver({
      MAX_WAIT_SEC: "3",
      EXTRACT_NO_INDICATOR_STABLE_MS: "0",
    });
    const marker = "[[OC=current.sig]]";
    const promptAnchor = `Analyse CTO\n${marker}\nContexte`;
    const beforeSend = "Ancienne conversation";
    const withNewResponse = `${beforeSend}\nRéponse CTO complète`;

    scrapeMock
      .mockResolvedValue(withNewResponse);

    await expect((driver as unknown as {
      pollForStableText: (
        requestId: string,
        markerValue: string,
        extractionAnchor?: string,
        previousFullText?: string,
      ) => Promise<PollResult>;
    }).pollForStableText("rid-7", marker, promptAnchor, beforeSend)).rejects.toMatchObject({ code: "timeout" });
  });

  it("keeps legacy snapshot-delta fallback when no bridge marker is expected", async () => {
    const driver = buildDriver({
      MAX_WAIT_SEC: "8",
      EXTRACT_NO_INDICATOR_STABLE_MS: "0",
    });
    const marker = "very very long marker first line\nline2\nline3";
    const beforeSend = "very very long marker first line\nline2";
    const withNewResponse = `${beforeSend}\nRéponse CTO complète\nvery very long marker first line`;

    scrapeMock
      .mockResolvedValueOnce(withNewResponse)
      .mockResolvedValue(withNewResponse);

    const result = await (driver as unknown as {
      pollForStableText: (
        requestId: string,
        markerValue: string,
        extractionAnchor?: string,
        previousFullText?: string,
      ) => Promise<PollResult>;
    }).pollForStableText("rid-legacy", marker, marker, beforeSend);

    expect(result.fullText).toBe(withNewResponse);
    expect(result.extractedText).toContain("Réponse CTO complète");
    expect(result.extractionMode).toBe("snapshot_delta");
  });

  it("keeps scrape-timeout errors recoverable and completes when scraping resumes", async () => {
    const driver = buildDriver({
      MAX_WAIT_SEC: "8",
      EXTRACT_NO_INDICATOR_STABLE_MS: "500",
    });
    const marker = "[[OC=timeout.sig]]";
    const fullText = `${marker}\nRéponse finale`;

    scrapeMock
      .mockRejectedValueOnce(new BridgeError("timeout", "AppleScript execution timed out"))
      .mockResolvedValueOnce(fullText)
      .mockResolvedValue(fullText);

    const result = await (driver as unknown as { pollForStableText: (...args: Parameters<PollFn>) => Promise<PollResult> })
      .pollForStableText("rid-8", marker);

    expect(result.extractedText).toBe("Réponse finale");
    expect(result.extractionMode).toBe("marker");
    expect(scrapeMock.mock.calls.at(0)?.[0]).toMatchObject({ includeDescriptions: false, timeoutMs: 15000 });
    expect(scrapeMock.mock.calls.at(1)?.[0]).toMatchObject({ includeDescriptions: false, timeoutMs: 20000 });
  });

  it("backs off scrape timeout across repeated timeout failures", async () => {
    const driver = buildDriver({
      MAX_WAIT_SEC: "10",
      EXTRACT_NO_INDICATOR_STABLE_MS: "0",
    });
    const marker = "[[OC=timeout-backoff.sig]]";
    const fullText = `${marker}\nRéponse finale`;

    scrapeMock
      .mockRejectedValueOnce(new BridgeError("timeout", "AppleScript execution timed out"))
      .mockRejectedValueOnce(new BridgeError("timeout", "AppleScript execution timed out"))
      .mockResolvedValueOnce(fullText)
      .mockResolvedValue(fullText);

    const result = await (driver as unknown as { pollForStableText: (...args: Parameters<PollFn>) => Promise<PollResult> })
      .pollForStableText("rid-backoff", marker);

    expect(result.extractedText).toBe("Réponse finale");
    expect(scrapeMock.mock.calls.at(0)?.[0]).toMatchObject({ includeDescriptions: false, timeoutMs: 15000 });
    expect(scrapeMock.mock.calls.at(1)?.[0]).toMatchObject({ includeDescriptions: false, timeoutMs: 20000 });
    expect(scrapeMock.mock.calls.at(2)?.[0]).toMatchObject({ includeDescriptions: false, timeoutMs: 25000 });
  });

  it("resets stability after scrape timeout recovery before declaring completion", async () => {
    const driver = buildDriver({
      MAX_WAIT_SEC: "10",
      STABLE_CHECKS: "2",
      EXTRACT_NO_INDICATOR_STABLE_MS: "0",
    });
    const marker = "[[OC=timeout-reset.sig]]";
    const fullText = `${marker}\nRéponse finale`;

    scrapeMock
      .mockResolvedValueOnce(fullText)
      .mockResolvedValueOnce(fullText)
      .mockRejectedValueOnce(new BridgeError("timeout", "AppleScript execution timed out"))
      .mockResolvedValueOnce(fullText)
      .mockResolvedValue(fullText);

    const result = await (driver as unknown as { pollForStableText: (...args: Parameters<PollFn>) => Promise<PollResult> })
      .pollForStableText("rid-timeout-reset", marker);

    expect(result.extractedText).toBe("Réponse finale");
    expect(result.extractionMode).toBe("marker");
    expect(scrapeMock).toHaveBeenCalledTimes(6);
  }, 15_000);
});
