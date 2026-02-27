import { beforeEach, describe, expect, it, vi } from "vitest";

const { runAppleScriptMock } = vi.hoisted(() => ({
  runAppleScriptMock: vi.fn<(script: string) => Promise<string>>(),
}));

vi.mock("run-applescript", () => ({
  runAppleScript: runAppleScriptMock,
}));

import { escapeAppleScriptString, runAppleScriptStrict } from "../src/ui/applescript.js";

describe("escapeAppleScriptString", () => {
  beforeEach(() => {
    runAppleScriptMock.mockReset();
  });

  it("escapes quotes, backslashes and newlines", () => {
    const input = 'A "quote" and \\ slash\nnext line';
    const escaped = escapeAppleScriptString(input);

    expect(escaped).toBe('A \\\"quote\\\" and \\\\ slash\\nnext line');
  });

  it("drops carriage returns and preserves unicode", () => {
    const input = "line1\r\nline2 π";
    const escaped = escapeAppleScriptString(input);

    expect(escaped).toBe("line1\\nline2 π");
  });

  it("maps localized -25211 errors to accessibility_denied", async () => {
    runAppleScriptMock.mockRejectedValueOnce(
      new Error("execution error: osascript n'est pas autorise a un acces d'aide. (-25211)"),
    );

    await expect(runAppleScriptStrict("return 1")).rejects.toMatchObject({
      code: "accessibility_denied",
      message: "Accessibility permission denied",
    });
  });

  it("maps non-accessibility failures to ui_error", async () => {
    runAppleScriptMock.mockRejectedValueOnce(new Error("execution error: some other failure"));

    await expect(runAppleScriptStrict("return 1")).rejects.toMatchObject({
      code: "ui_error",
      message: "AppleScript execution failed",
    });
  });

  it("maps timeout failures to timeout", async () => {
    runAppleScriptMock.mockRejectedValueOnce(new Error("Command failed: osascript timed out"));

    await expect(runAppleScriptStrict("return 1")).rejects.toMatchObject({
      code: "timeout",
      message: "AppleScript execution timed out",
    });
  });
});
