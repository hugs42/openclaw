import { describe, expect, it } from "vitest";
import { isInternalControlPrompt, renderMessagesToPrompt } from "../src/ui/renderPrompt.js";

describe("renderMessagesToPrompt", () => {
  it("returns the latest user message and ignores marker/meta arguments", () => {
    const prompt = renderMessagesToPrompt(
      [
        { role: "system", content: "You are concise." },
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi" },
        { role: "user", content: "Final user prompt" },
      ],
      "[[OC=abc.sig]]",
      "Meta instructions",
    );

    expect(prompt).toBe("Final user prompt");
  });

  it("strips subagent context preamble", () => {
    const prompt = renderMessagesToPrompt(
      [
        {
          role: "user",
          content:
            "[Subagent Context] Ignore this metadata\n[Subagent Task]:   Réponds exactement: ACK_BRIDGE",
        },
      ],
      "[[OC=abc.sig]]",
      "Meta instructions",
    );

    expect(prompt).toBe("Réponds exactement: ACK_BRIDGE");
  });

  it("strips markdown subagent sections and leaked bridge marker", () => {
    const prompt = renderMessagesToPrompt(
      [
        {
          role: "user",
          content: `## Subagent Context
Session interne: 42

## Subagent Task
[[OC=req-123.sig]]
Dis bonjour en une phrase.`,
        },
      ],
      "",
      "",
    );

    expect(prompt).toBe("Dis bonjour en une phrase.");
  });

  it("drops standalone subagent context lines even without subagent-task header", () => {
    const prompt = renderMessagesToPrompt(
      [
        {
          role: "user",
          content: `[Subagent Context] You are running as a subagent (depth 1/1). Results auto-announce to your requester; do not busy-poll for status.
Bonjour, peux-tu confirmer reception ?`,
        },
      ],
      "",
      "",
    );

    expect(prompt).toBe("Bonjour, peux-tu confirmer reception ?");
  });

  it("detects agent-to-agent internal control prompt", () => {
    const prompt = renderMessagesToPrompt(
      [{ role: "user", content: "[Thu 2026-02-26 03:13 GMT+1] Agent-to-agent announce step." }],
      "",
      "",
    );

    expect(prompt).toBe("Agent-to-agent announce step.");
    expect(isInternalControlPrompt(prompt)).toBe(true);
  });

  it("detects ANNOUNCE_SKIP and REPLY_SKIP control tokens", () => {
    expect(isInternalControlPrompt("ANNOUNCE_SKIP")).toBe(true);
    expect(isInternalControlPrompt("REPLY_SKIP")).toBe(true);
    expect(isInternalControlPrompt("Bonjour")).toBe(false);
  });
});
