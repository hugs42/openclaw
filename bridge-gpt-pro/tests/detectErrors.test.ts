import { describe, expect, it } from "vitest";
import { detectUiError } from "../src/ui/detectErrors.js";

const patterns = [
  { code: "usage_cap", includes: ["usage cap"] },
  { code: "rate_limited", includes: ["too many requests"] },
  { code: "network_error", includes: ["network error"] },
  { code: "captcha", includes: ["verify you are human"] },
  { code: "auth_required", includes: ["sign in to continue"] },
];

describe("detectUiError", () => {
  it("maps usage cap", () => {
    const error = detectUiError("You have reached the usage cap", patterns);
    expect(error?.code).toBe("usage_cap");
  });

  it("maps rate limit", () => {
    const error = detectUiError("Too many requests right now", patterns);
    expect(error?.code).toBe("rate_limited_by_chatgpt");
  });

  it("maps network error", () => {
    const error = detectUiError("Network Error happened", patterns);
    expect(error?.code).toBe("network_error");
  });

  it("maps captcha", () => {
    const error = detectUiError("Please verify you are human", patterns);
    expect(error?.code).toBe("captcha");
  });

  it("maps auth required", () => {
    const error = detectUiError("Sign in to continue", patterns);
    expect(error?.code).toBe("auth_required");
  });

  it("returns null on no match", () => {
    const error = detectUiError("All good", patterns);
    expect(error).toBeNull();
  });
});
