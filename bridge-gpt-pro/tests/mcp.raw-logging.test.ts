import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { BridgeError } from "../src/errors.js";
import {
  handleMcpCallToolRequest,
  handleMcpListToolsRequest,
  type McpCallToolResponse,
  type StartMcpServerOptions,
} from "../src/mcp/server.js";
import { createLogger } from "../src/logger.js";
import type { RawExchangeLogger, RawExchangeRecord } from "../src/rawExchangeLog.js";
import type { ChatGPTDriver, DriverAskOptions } from "../src/ui/chatgptApp.js";
import type { QueueLike } from "../src/utils/queue.js";

class CapturingRawExchangeLogger implements RawExchangeLogger {
  public readonly entries: RawExchangeRecord[] = [];

  public async record(entry: RawExchangeRecord): Promise<void> {
    this.entries.push(entry);
  }
}

class TestQueue implements QueueLike {
  public depth = 0;

  public getDepth(): number {
    return this.depth;
  }

  public async add<T>(task: () => Promise<T>): Promise<T> {
    this.depth += 1;
    try {
      return await task();
    } finally {
      this.depth -= 1;
    }
  }
}

function buildOptions(overrides?: {
  driver?: ChatGPTDriver;
  queue?: QueueLike;
  rawExchangeLogger?: RawExchangeLogger;
}): StartMcpServerOptions {
  const config = loadConfig({
    ...process.env,
    BRIDGE_MODE: "mcp",
    MARKER_SECRET: "secret",
  });
  const logger = createLogger({ level: "error", format: "json" });
  const queue = overrides?.queue ?? new TestQueue();
  const driver: ChatGPTDriver =
    overrides?.driver ??
    ({
      ensureRunning: async () => undefined,
      ask: async () => ({ text: "mcp ok", contextReset: 0 }),
      getConversations: async () => ["A", "B"],
    } as ChatGPTDriver);

  return {
    config,
    logger,
    queue,
    driver,
    rawExchangeLogger: overrides?.rawExchangeLogger,
  };
}

function expectTextPayload(response: McpCallToolResponse): string {
  expect(response.content.length).toBeGreaterThan(0);
  return response.content[0]?.text ?? "";
}

describe("MCP raw logging", () => {
  it("logs request/response for ListTools", async () => {
    const rawLogger = new CapturingRawExchangeLogger();
    const options = buildOptions({ rawExchangeLogger: rawLogger });

    const payload = await handleMcpListToolsRequest(options, "mcp_list_1");
    expect(payload.tools.length).toBeGreaterThan(0);

    const requestEntry = rawLogger.entries.find((entry) => entry.event === "mcp_request_raw" && entry.rid === "mcp_list_1");
    const responseEntry = rawLogger.entries.find((entry) => entry.event === "mcp_response_raw" && entry.rid === "mcp_list_1");
    expect(requestEntry).toBeDefined();
    expect(responseEntry).toBeDefined();
  });

  it("logs mcp_response_error_raw for unknown tool", async () => {
    const rawLogger = new CapturingRawExchangeLogger();
    const options = buildOptions({ rawExchangeLogger: rawLogger });

    const response = await handleMcpCallToolRequest(
      options,
      { name: "unknown_tool", arguments: {} },
      "mcp_unknown_1",
    );

    expect(response.isError).toBe(true);
    expect(expectTextPayload(response)).toContain("Unknown tool");

    const errorEntry = rawLogger.entries.find((entry) =>
      entry.event === "mcp_response_error_raw"
      && entry.rid === "mcp_unknown_1"
      && (entry as { errorCode?: string }).errorCode === "unknown_tool"
    );
    expect(errorEntry).toBeDefined();
  });

  it("logs raw chain for ask operation", async () => {
    const rawLogger = new CapturingRawExchangeLogger();
    const options = buildOptions({ rawExchangeLogger: rawLogger });

    const response = await handleMcpCallToolRequest(
      options,
      {
        name: "chatgpt",
        arguments: { operation: "ask", prompt: "hello world" },
      },
      "mcp_ask_1",
    );

    expect(response.isError).toBe(false);
    expect(expectTextPayload(response)).toContain("mcp ok");

    const events = rawLogger.entries
      .filter((entry) => entry.rid === "mcp_ask_1")
      .map((entry) => entry.event);

    expect(events).toContain("chatgpt_prompt_rendered_raw");
    expect(events).toContain("chatgpt_prompt_send_raw");
    expect(events).toContain("chatgpt_prompt_response_raw");
    expect(events).toContain("mcp_response_raw");
  });

  it("appends a unique extraction marker to MCP ask prompts", async () => {
    let askOptions: DriverAskOptions | undefined;
    const driver: ChatGPTDriver = {
      ensureRunning: async () => undefined,
      ask: async (options: DriverAskOptions) => {
        askOptions = options;
        return { text: "mcp ok", contextReset: 0 };
      },
      getConversations: async () => ["A", "B"],
    };
    const options = buildOptions({ driver });

    const response = await handleMcpCallToolRequest(
      options,
      {
        name: "chatgpt",
        arguments: { operation: "ask", prompt: "hello marker mcp" },
      },
      "mcp_marker_1",
    );

    expect(response.isError).toBe(false);
    expect(askOptions).toBeDefined();
    expect(askOptions?.marker).toMatch(/^\[\[OC=[^[\]\n]+\]\]$/);
    expect(askOptions?.prompt).toContain("hello marker mcp");
    expect(askOptions?.prompt.endsWith(askOptions?.marker ?? "")).toBe(true);
  });

  it("logs response for get_conversations operation", async () => {
    const rawLogger = new CapturingRawExchangeLogger();
    const options = buildOptions({ rawExchangeLogger: rawLogger });

    const response = await handleMcpCallToolRequest(
      options,
      {
        name: "chatgpt",
        arguments: { operation: "get_conversations" },
      },
      "mcp_getconv_1",
    );

    expect(response.isError).toBe(false);
    expect(expectTextPayload(response)).toContain("Found 2 conversation(s)");

    const responseEntry = rawLogger.entries.find((entry) =>
      entry.event === "mcp_response_raw" && entry.rid === "mcp_getconv_1"
    );
    expect(responseEntry).toBeDefined();
  });

  it("logs mcp_response_error_raw when ask fails", async () => {
    const rawLogger = new CapturingRawExchangeLogger();
    const driver: ChatGPTDriver = {
      ensureRunning: async () => undefined,
      ask: async () => {
        throw new BridgeError("ui_error", "UI failed");
      },
      getConversations: async () => ["A", "B"],
    };
    const options = buildOptions({ rawExchangeLogger: rawLogger, driver });

    const response = await handleMcpCallToolRequest(
      options,
      {
        name: "chatgpt",
        arguments: { operation: "ask", prompt: "hello world" },
      },
      "mcp_err_1",
    );

    expect(response.isError).toBe(true);
    expect(expectTextPayload(response)).toContain("ui_error");

    const errorEntry = rawLogger.entries.find((entry) =>
      entry.event === "mcp_response_error_raw"
      && entry.rid === "mcp_err_1"
      && (entry as { errorCode?: string }).errorCode === "ui_error"
    );
    expect(errorEntry).toBeDefined();
  });
});
