import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { runAppleScript } from "run-applescript";
import { BridgeError } from "../errors.js";

const ACCESSIBILITY_PATTERNS = [
  "not authorized",
  "not permitted",
  "assistive access",
  "accessibility",
  "osadefaults",
  "-25211",
  "acces d'aide",
  "acces d aide",
  "n'est pas autorise",
];

function normalizeErrorMessage(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[’]/g, "'");
}

function mapAppleScriptError(error: unknown): BridgeError {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = normalizeErrorMessage(message);
  const timedOut = normalized.includes("timed out")
    || normalized.includes("etimedout")
    || normalized.includes("sigterm")
    || (typeof error === "object"
      && error !== null
      && ("killed" in error)
      && (error as { killed?: boolean }).killed === true);

  if (timedOut) {
    return new BridgeError("timeout", "AppleScript execution timed out", {
      rawMessage: message,
    });
  }

  if (ACCESSIBILITY_PATTERNS.some((pattern) => normalized.includes(pattern))) {
    return new BridgeError("accessibility_denied", "Accessibility permission denied", {
      rawMessage: message,
    });
  }

  if (normalized.includes("application process \"chatgpt\" doesn't exist")) {
    return new BridgeError("app_not_running", "ChatGPT app is not running", {
      rawMessage: message,
    });
  }

  return new BridgeError("ui_error", "AppleScript execution failed", {
    rawMessage: message,
  });
}

export interface RunAppleScriptOptions {
  timeoutMs?: number;
}

const execFileAsync = promisify(execFile);

async function runAppleScriptWithTimeout(script: string, timeoutMs: number): Promise<string> {
  const { stdout } = await execFileAsync("osascript", ["-e", script], {
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout.trim();
}

export async function runAppleScriptStrict(script: string, options: RunAppleScriptOptions = {}): Promise<string> {
  try {
    if (options.timeoutMs && options.timeoutMs > 0) {
      return await runAppleScriptWithTimeout(script, options.timeoutMs);
    }
    return await runAppleScript(script);
  } catch (error) {
    throw mapAppleScriptError(error);
  }
}

export function escapeAppleScriptString(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\r/g, "")
    .replace(/\n/g, "\\n")
    .replace(/"/g, '\\"');
}
