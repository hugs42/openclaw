import type { UiErrorPattern } from "../config.js";
import { BridgeError, type BridgeErrorCode } from "../errors.js";

function mapPatternCode(code: string): BridgeErrorCode | null {
  switch (code) {
    case "usage_cap":
      return "usage_cap";
    case "rate_limited":
    case "rate_limited_by_chatgpt":
      return "rate_limited_by_chatgpt";
    case "network_error":
      return "network_error";
    case "captcha":
      return "captcha";
    case "auth_required":
      return "auth_required";
    default:
      return null;
  }
}

export function detectUiError(fullText: string, patterns: UiErrorPattern[]): BridgeError | null {
  const haystack = fullText.toLowerCase();

  for (const pattern of patterns) {
    const mapped = mapPatternCode(pattern.code.toLowerCase());
    if (!mapped) continue;

    const matched = pattern.includes.some((needle) => haystack.includes(needle.toLowerCase()));
    if (!matched) continue;

    const retryAfterSec = mapped === "usage_cap" || mapped === "rate_limited_by_chatgpt" ? 60 : undefined;
    return new BridgeError(mapped, `Detected ChatGPT UI error: ${mapped}`, {
      pattern: pattern.code,
    }, retryAfterSec);
  }

  return null;
}
