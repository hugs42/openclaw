import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { validatePromptLimits } from "../src/http/openaiRoutes.js";

describe("validatePromptLimits", () => {
  it("throws prompt_too_large for long message", () => {
    const config = loadConfig({
      ...process.env,
      MAX_MESSAGE_CHARS: "2",
      MAX_PROMPT_CHARS: "200",
    });

    expect(() => validatePromptLimits(config, [{ role: "user", content: "abc" }], "abc")).toThrowError(
      /Message content exceeds maximum length/,
    );
  });

  it("throws prompt_too_large for long prompt", () => {
    const config = loadConfig({
      ...process.env,
      MAX_MESSAGE_CHARS: "200",
      MAX_PROMPT_CHARS: "2",
    });

    expect(() => validatePromptLimits(config, [{ role: "user", content: "ok" }], "long")).toThrowError(
      /Rendered prompt exceeds maximum length/,
    );
  });
});
