import { type Logger } from "pino";
import { nanoid } from "nanoid";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type ListToolsResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import type { BridgeConfig } from "../config.js";
import { BridgeError, toBridgeError } from "../errors.js";
import type { RawExchangeLogger, RawExchangeRecord } from "../rawExchangeLog.js";
import type { ChatGPTDriver } from "../ui/chatgptApp.js";
import { makeMarker } from "../ui/extract.js";
import { isInternalControlPrompt, renderMessagesToPrompt } from "../ui/renderPrompt.js";
import type { QueueLike } from "../utils/queue.js";
import { expandPromptWithBridgeFiles, type BridgeFileReference } from "../http/fileContext.js";

export const CHATGPT_TOOL: Tool = {
  name: "chatgpt",
  description: "Interact with the ChatGPT desktop app on macOS",
  inputSchema: {
    type: "object",
    properties: {
      operation: {
        type: "string",
        description: "Operation to perform: 'ask' or 'get_conversations'",
        enum: ["ask", "get_conversations"],
      },
      prompt: {
        type: "string",
        description: "The prompt to send to ChatGPT (required for ask operation)",
      },
      conversation_id: {
        type: "string",
        description: "Optional conversation ID to continue a specific conversation",
      },
      bridge_files: {
        type: "array",
        description: "Optional local files to inject into the prompt",
        items: {
          type: "object",
          properties: {
            path: { type: "string", description: "Absolute local file path" },
            label: { type: "string", description: "Optional label shown in FILE_CONTEXT block" },
            encoding: { type: "string", description: "Only utf8 is supported" },
          },
          required: ["path"],
        },
      },
    },
    required: ["operation"],
  },
};

export interface StartMcpServerOptions {
  config: BridgeConfig;
  logger: Logger;
  queue: QueueLike;
  driver: ChatGPTDriver;
  rawExchangeLogger?: RawExchangeLogger;
}

export interface McpCallToolRequestParams {
  name: string;
  arguments?: unknown;
}

export type McpCallToolResponse = CallToolResult;

type RawMcpEventPayload = {
  event: string;
  rid?: string;
} & Record<string, unknown>;

function isChatGPTArgs(args: unknown): args is {
  operation: "ask" | "get_conversations";
  prompt?: string;
  conversation_id?: string;
  bridge_files?: BridgeFileReference[];
} {
  if (typeof args !== "object" || args === null) return false;

  const operation = (args as { operation?: unknown }).operation;
  const prompt = (args as { prompt?: unknown }).prompt;
  const conversationId = (args as { conversation_id?: unknown }).conversation_id;
  const bridgeFiles = (args as { bridge_files?: unknown }).bridge_files;

  if (operation !== "ask" && operation !== "get_conversations") {
    return false;
  }

  if (operation === "ask" && typeof prompt !== "string") {
    return false;
  }

  if (prompt !== undefined && typeof prompt !== "string") {
    return false;
  }

  if (conversationId !== undefined && typeof conversationId !== "string") {
    return false;
  }

  if (
    bridgeFiles !== undefined
    && (
      !Array.isArray(bridgeFiles)
      || !bridgeFiles.every((item) => {
        if (typeof item !== "object" || item === null) return false;
        const filePath = (item as { path?: unknown }).path;
        const label = (item as { label?: unknown }).label;
        const encoding = (item as { encoding?: unknown }).encoding;
        return (
          typeof filePath === "string"
          && (label === undefined || typeof label === "string")
          && (encoding === undefined || typeof encoding === "string")
        );
      })
    )
  ) {
    return false;
  }

  return true;
}

function formatMcpError(error: unknown): string {
  const bridgeError = toBridgeError(error);
  return `${bridgeError.code}: ${bridgeError.message}`;
}

function buildMcpTextPayload(text: string, isError: boolean): McpCallToolResponse {
  return {
    content: [{ type: "text", text }],
    isError,
  };
}

function logRawMcpEvent(
  options: StartMcpServerOptions,
  entry: RawMcpEventPayload,
): void {
  if (!options.rawExchangeLogger) {
    return;
  }

  const payload: RawExchangeRecord = { channel: "mcp", ...entry };
  void options.rawExchangeLogger.record(payload).catch((error) => {
    options.logger.error(
      {
        event: "raw_exchange_log_failed",
        scope: "mcp_server",
        message: error instanceof Error ? error.message : String(error),
      },
      "raw_exchange_log_failed",
    );
  });
}

export async function handleMcpListToolsRequest(
  options: StartMcpServerOptions,
  rid: string = `mcp_${nanoid()}`,
): Promise<ListToolsResult> {
  logRawMcpEvent(options, {
    rid,
    event: "mcp_request_raw",
    operation: "list_tools",
    queueDepth: options.queue.getDepth(),
  });

  const payload = { tools: [CHATGPT_TOOL] };
  logRawMcpEvent(options, {
    rid,
    event: "mcp_response_raw",
    operation: "list_tools",
    payload,
    queueDepth: options.queue.getDepth(),
  });
  return payload;
}

export async function handleMcpCallToolRequest(
  options: StartMcpServerOptions,
  params: McpCallToolRequestParams,
  rid: string = `mcp_${nanoid()}`,
): Promise<McpCallToolResponse> {
  logRawMcpEvent(options, {
    rid,
    event: "mcp_request_raw",
    operation: "call_tool",
    toolName: params.name,
    arguments: params.arguments,
    queueDepth: options.queue.getDepth(),
  });

  try {
    const { name, arguments: args } = params;

    if (!args) {
      throw new BridgeError("unknown", "No arguments provided");
    }

    if (name !== "chatgpt") {
      const payload = buildMcpTextPayload(`Unknown tool: ${name}`, true);
      logRawMcpEvent(options, {
        rid,
        event: "mcp_response_error_raw",
        operation: "call_tool",
        toolName: name,
        payload,
        errorCode: "unknown_tool",
        queueDepth: options.queue.getDepth(),
      });
      return payload;
    }

    if (!isChatGPTArgs(args)) {
      throw new BridgeError("unknown", "Invalid arguments for ChatGPT tool");
    }

    if (args.operation === "ask") {
      if ((args.prompt ?? "").length > options.config.maxMessageChars) {
        throw new BridgeError("prompt_too_large", "Prompt exceeds maximum message size", {
          maxMessageChars: options.config.maxMessageChars,
          messageChars: (args.prompt ?? "").length,
        });
      }

      const prompt = renderMessagesToPrompt(
        [{ role: "user", content: args.prompt ?? "" }],
        "",
        options.config.metaInstructions,
      );
      logRawMcpEvent(options, {
        rid,
        event: "chatgpt_prompt_rendered_raw",
        renderedPrompt: prompt,
        queueDepth: options.queue.getDepth(),
      });

      if (isInternalControlPrompt(prompt)) {
        const payload = buildMcpTextPayload("ANNOUNCE_SKIP", false);
        logRawMcpEvent(options, {
          rid,
          event: "mcp_response_raw",
          operation: "call_tool",
          toolName: name,
          payload,
          queueDepth: options.queue.getDepth(),
        });
        return payload;
      }

      const fileContext = expandPromptWithBridgeFiles(prompt, args.bridge_files, options.config);
      const finalPrompt = fileContext.prompt;
      const marker = makeMarker(rid, options.config.markerSecret);
      const promptForSend = `${finalPrompt}\n\n${marker}`;
      logRawMcpEvent(options, {
        rid,
        event: "chatgpt_prompt_send_raw",
        renderedPrompt: prompt,
        finalPrompt: promptForSend,
        marker,
        files: fileContext.files,
        queueDepth: options.queue.getDepth(),
      });

      if (promptForSend.length > options.config.maxPromptChars) {
        throw new BridgeError("prompt_too_large", "Prompt exceeds maximum size", {
          maxPromptChars: options.config.maxPromptChars,
          promptChars: promptForSend.length,
        });
      }

      const askOperation = () =>
        options.driver.ask({
          prompt: promptForSend,
          marker,
          requestId: rid,
          conversationId: args.conversation_id,
          strictOpen: false,
          resetEachRequest: false,
          resetStrict: false,
        });

      const askPromise = options.queue.addIfIdle
        ? options.queue.addIfIdle(askOperation, options.config.effectiveJobTimeoutMs)
        : options.queue.add(askOperation, options.config.effectiveJobTimeoutMs);

      if (!askPromise) {
        throw new BridgeError(
          "queue_full",
          "Previous ChatGPT response is still pending; do not send a new prompt yet.",
          { reason: "previous_response_pending" },
          1,
        );
      }

      const result = await askPromise;
      const payload = buildMcpTextPayload(result.text || "No response received from ChatGPT.", false);
      logRawMcpEvent(options, {
        rid,
        event: "chatgpt_prompt_response_raw",
        result,
        queueDepth: options.queue.getDepth(),
      });
      logRawMcpEvent(options, {
        rid,
        event: "mcp_response_raw",
        operation: "call_tool",
        toolName: name,
        payload,
        queueDepth: options.queue.getDepth(),
      });
      return payload;
    }

    const conversations = await options.queue.add(
      () => options.driver.getConversations(rid),
      options.config.effectiveJobTimeoutMs,
    );

    const payload = buildMcpTextPayload(
      conversations.length > 0
        ? `Found ${conversations.length} conversation(s):\n\n${conversations.join("\n")}`
        : "No conversations found in ChatGPT.",
      false,
    );
    logRawMcpEvent(options, {
      rid,
      event: "mcp_response_raw",
      operation: "call_tool",
      toolName: name,
      payload,
      queueDepth: options.queue.getDepth(),
    });
    return payload;
  } catch (error) {
    const bridgeError = toBridgeError(error);
    options.logger.error(
      {
        rid,
        event: "mcp_error",
        errorCode: bridgeError.code,
        details: bridgeError.details,
      },
      bridgeError.message,
    );

    const payload = buildMcpTextPayload(`Error: ${formatMcpError(error)}`, true);
    logRawMcpEvent(options, {
      rid,
      event: "mcp_response_error_raw",
      operation: "call_tool",
      toolName: params.name,
      payload,
      errorCode: bridgeError.code,
      errorDetails: bridgeError.details,
      queueDepth: options.queue.getDepth(),
    });
    return payload;
  }
}

export async function startMcpServer(options: StartMcpServerOptions): Promise<void> {
  const server = new Server(
    {
      name: "ChatGPT MCP Tool",
      version: options.config.version,
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => handleMcpListToolsRequest(options));

  server.setRequestHandler(CallToolRequestSchema, async (request) =>
    handleMcpCallToolRequest(
      options,
      {
        name: request.params.name,
        arguments: request.params.arguments,
      },
    ));

  const transport = new StdioServerTransport();
  await server.connect(transport);
  options.logger.info({ event: "mcp_server_started", mode: "mcp" }, "mcp_server_started");
}
