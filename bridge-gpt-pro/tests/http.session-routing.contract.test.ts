import request from "supertest";
import { describe, expect, it } from "vitest";
import { loadConfig, type SessionBindingMode } from "../src/config.js";
import { BridgeError } from "../src/errors.js";
import { createHttpApp } from "../src/http/server.js";
import { createLogger } from "../src/logger.js";
import {
  normalizeSessionSlot,
  type SessionBindingStore,
} from "../src/session/store.js";
import type { ChatGPTDriver, DriverAskOptions } from "../src/ui/chatgptApp.js";
import type { QueueLike } from "../src/utils/queue.js";
import type { RateLimiter } from "../src/utils/rateLimit.js";

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

class MemorySessionBindingStore implements SessionBindingStore {
  private readonly map = new Map<string, string>();

  public async load(): Promise<void> {
    return;
  }

  public get(slot: string): string | undefined {
    return this.map.get(normalizeSessionSlot(slot));
  }

  public async set(slot: string, conversationId: string): Promise<void> {
    this.map.set(normalizeSessionSlot(slot), conversationId);
  }

  public async delete(slot: string): Promise<void> {
    this.map.delete(normalizeSessionSlot(slot));
  }
}

class SessionAwareDriver implements ChatGPTDriver {
  public readonly asks: DriverAskOptions[] = [];
  public readonly missingConversations = new Set<string>();

  public async ensureRunning(): Promise<void> {
    return;
  }

  public async ask(options: DriverAskOptions): Promise<{ text: string; contextReset: 0 | 1; openedConversationId?: string }> {
    this.asks.push(options);

    if (options.conversationId && this.missingConversations.has(options.conversationId)) {
      if (options.strictOpen) {
        throw new BridgeError("conversation_not_found", "Conversation not found", {
          conversationId: options.conversationId,
        });
      }

      return {
        text: "fallback response",
        contextReset: 0,
      };
    }

    return {
      text: "bridge response",
      contextReset: 0,
      openedConversationId: options.conversationId,
    };
  }

  public async getConversations(): Promise<string[]> {
    return ["Project Alpha", "Project Beta"];
  }
}

function buildApp(mode: SessionBindingMode, strictOpen: boolean) {
  const config = loadConfig({
    ...process.env,
    BRIDGE_MODE: "http",
    CHATGPT_BRIDGE_TOKEN: "devtoken",
    MARKER_SECRET: "secret",
    SESSION_BINDING_MODE: mode,
    SESSION_BINDING_STRICT_OPEN: strictOpen ? "true" : "false",
    RESET_CHAT_EACH_REQUEST: "false",
    RESET_STRICT: "false",
  });

  const logger = createLogger({ level: "error", format: "json" });
  const queue = new TestQueue();
  const rateLimiter: RateLimiter = {
    consume: () => ({ allowed: true, retryAfterSec: 0, remainingTokens: 1 }),
  };
  const driver = new SessionAwareDriver();
  const sessionBindingStore = new MemorySessionBindingStore();

  return {
    app: createHttpApp({ config, logger, queue, rateLimiter, driver, sessionBindingStore }),
    driver,
  };
}

describe("HTTP session routing contract", () => {
  it("sticky mode persists binding from explicit conversation_id to next request", async () => {
    const { app, driver } = buildApp("sticky", true);

    const first = await request(app)
      .post("/v1/chat/completions")
      .set("Authorization", "Bearer devtoken")
      .send({
        model: "chatgpt-macos",
        messages: [{ role: "user", content: "hello" }],
        session_key: "slot-a",
        conversation_id: "Project Alpha",
      });

    const second = await request(app)
      .post("/v1/chat/completions")
      .set("Authorization", "Bearer devtoken")
      .send({
        model: "chatgpt-macos",
        messages: [{ role: "user", content: "follow up" }],
        session_key: "slot-a",
      });

    expect(first.status).toBe(200);
    expect(first.headers["x-bridge-session-slot"]).toBe("slot-a");
    expect(first.headers["x-bridge-conversation-id"]).toBe("Project Alpha");
    expect(second.status).toBe(200);
    expect(second.headers["x-bridge-session-slot"]).toBe("slot-a");
    expect(second.headers["x-bridge-conversation-id"]).toBe("Project Alpha");
    expect(driver.asks[0]?.conversationId).toBe("Project Alpha");
    expect(driver.asks[1]?.conversationId).toBe("Project Alpha");
  });

  it("off mode ignores conversation routing and persistence fields", async () => {
    const { app, driver } = buildApp("off", true);

    const response = await request(app)
      .post("/v1/chat/completions")
      .set("Authorization", "Bearer devtoken")
      .send({
        model: "chatgpt-macos",
        messages: [{ role: "user", content: "hello" }],
        session_key: "slot-a",
        conversation_id: "Project Alpha",
      });

    expect(response.status).toBe(200);
    expect(driver.asks[0]?.conversationId).toBeUndefined();
    expect(response.headers["x-bridge-session-slot"]).toBe("");
    expect(response.headers["x-bridge-conversation-id"]).toBe("");
  });

  it("explicit mode requires conversation_id", async () => {
    const { app } = buildApp("explicit", true);

    const response = await request(app)
      .post("/v1/chat/completions")
      .set("Authorization", "Bearer devtoken")
      .send({
        model: "chatgpt-macos",
        messages: [{ role: "user", content: "hello" }],
      });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("invalid_request");
  });

  it("returns 404 when strict open is enabled and conversation is missing", async () => {
    const { app, driver } = buildApp("sticky", true);
    driver.missingConversations.add("Unknown Conversation");

    const response = await request(app)
      .post("/v1/chat/completions")
      .set("Authorization", "Bearer devtoken")
      .send({
        model: "chatgpt-macos",
        messages: [{ role: "user", content: "hello" }],
        conversation_id: "Unknown Conversation",
      });

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("conversation_not_found");
    expect(response.headers["x-bridge-conversation-id"]).toBe("Unknown Conversation");
  });

  it("falls back to active conversation when strict open is disabled", async () => {
    const { app, driver } = buildApp("sticky", false);
    driver.missingConversations.add("Unknown Conversation");

    const response = await request(app)
      .post("/v1/chat/completions")
      .set("Authorization", "Bearer devtoken")
      .send({
        model: "chatgpt-macos",
        messages: [{ role: "user", content: "hello" }],
        conversation_id: "Unknown Conversation",
      });

    expect(response.status).toBe(200);
    expect(response.body.choices[0].message.content).toBe("fallback response");
    expect(response.headers["x-bridge-conversation-id"]).toBe("");
  });

  it("exposes operator conversation listing endpoint with auth", async () => {
    const { app } = buildApp("sticky", false);

    const unauthenticated = await request(app).get("/v1/bridge/conversations");
    const authenticated = await request(app)
      .get("/v1/bridge/conversations")
      .set("Authorization", "Bearer devtoken");

    expect(unauthenticated.status).toBe(401);
    expect(authenticated.status).toBe(200);
    expect(authenticated.body.object).toBe("list");
    expect(authenticated.body.data).toHaveLength(2);
  });
});
