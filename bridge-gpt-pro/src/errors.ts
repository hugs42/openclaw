export type BridgeErrorCode =
  | "app_not_running"
  | "accessibility_denied"
  | "ui_element_not_found"
  | "ui_reset_failed"
  | "ui_error"
  | "usage_cap"
  | "rate_limited_by_chatgpt"
  | "captcha"
  | "network_error"
  | "auth_required"
  | "conversation_not_found"
  | "file_context_invalid"
  | "file_context_access_denied"
  | "file_context_not_found"
  | "file_context_unsupported"
  | "prompt_too_large"
  | "queue_full"
  | "timeout"
  | "unknown";

export class BridgeError extends Error {
  public code: BridgeErrorCode;
  public details?: Record<string, unknown>;
  public retryAfterSec?: number;

  public constructor(
    code: BridgeErrorCode,
    message: string,
    details?: Record<string, unknown>,
    retryAfterSec?: number,
  ) {
    super(message);
    this.name = "BridgeError";
    this.code = code;
    this.details = details;
    this.retryAfterSec = retryAfterSec;
  }
}

export function isBridgeError(value: unknown): value is BridgeError {
  return value instanceof BridgeError;
}

export function toBridgeError(value: unknown, fallbackMessage = "Unknown bridge error"): BridgeError {
  if (isBridgeError(value)) {
    return value;
  }

  if (value instanceof Error) {
    return new BridgeError("unknown", value.message || fallbackMessage);
  }

  return new BridgeError("unknown", fallbackMessage, {
    value: typeof value === "string" ? value : JSON.stringify(value),
  });
}
