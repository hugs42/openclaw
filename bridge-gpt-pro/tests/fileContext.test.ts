import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { BridgeError } from "../src/errors.js";
import { expandPromptWithBridgeFiles } from "../src/http/fileContext.js";

function makeConfig(overrides: Record<string, string> = {}) {
  return loadConfig({
    ...process.env,
    MARKER_SECRET: "secret",
    ...overrides,
  });
}

describe("expandPromptWithBridgeFiles", () => {
  it("returns prompt unchanged when no files are provided", () => {
    const config = makeConfig();
    const result = expandPromptWithBridgeFiles("hello", undefined, config);

    expect(result.prompt).toBe("hello");
    expect(result.files).toHaveLength(0);
    expect(result.diagnostics).toEqual({
      bridgeFilesBlocksDetected: 0,
      bridgeFilesBlockAccepted: false,
      bridgeFilesIgnoredNonTerminalCount: 0,
      bridgeFilesInjectedCount: 0,
    });
  });

  it("injects file content into FILE_CONTEXT block", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bridge-file-context-"));
    const filePath = path.join(dir, "note.txt");
    writeFileSync(filePath, "line 1\nline 2", "utf8");

    const config = makeConfig();
    const result = expandPromptWithBridgeFiles(
      "Summarize the file.",
      [{ path: filePath, label: "note.txt" }],
      config,
    );

    expect(result.files).toHaveLength(1);
    expect(result.prompt).toContain("[FILE_CONTEXT]");
    expect(result.prompt).toContain("line 1\nline 2");
    expect(result.prompt).toContain("note.txt");
    expect(result.diagnostics).toEqual({
      bridgeFilesBlocksDetected: 0,
      bridgeFilesBlockAccepted: false,
      bridgeFilesIgnoredNonTerminalCount: 0,
      bridgeFilesInjectedCount: 1,
    });
  });

  it("injects files declared directly inside a [BRIDGE_FILES] prompt block", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bridge-file-context-inline-"));
    const filePath = path.join(dir, "note.txt");
    writeFileSync(filePath, "line 1\nline 2", "utf8");

    const config = makeConfig();
    const result = expandPromptWithBridgeFiles(
      `Summarize the file.\n[BRIDGE_FILES]\n${filePath} | inline-note.txt\n[/BRIDGE_FILES]`,
      undefined,
      config,
    );

    expect(result.files).toHaveLength(1);
    expect(result.prompt).toContain("[FILE_CONTEXT]");
    expect(result.prompt).toContain("line 1\nline 2");
    expect(result.prompt).toContain("inline-note.txt");
    expect(result.prompt).not.toContain("[BRIDGE_FILES]");
    expect(result.diagnostics).toEqual({
      bridgeFilesBlocksDetected: 1,
      bridgeFilesBlockAccepted: true,
      bridgeFilesIgnoredNonTerminalCount: 0,
      bridgeFilesInjectedCount: 1,
    });
  });

  it("supports JSON payloads inside [BRIDGE_FILES] prompt blocks", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bridge-file-context-json-"));
    const filePath = path.join(dir, "note.txt");
    writeFileSync(filePath, "json file", "utf8");

    const config = makeConfig();
    const payload = JSON.stringify([{ path: filePath, label: "json-note.txt" }], null, 2);
    const result = expandPromptWithBridgeFiles(
      `Summarize the file.\n[BRIDGE_FILES]\n${payload}\n[/BRIDGE_FILES]`,
      undefined,
      config,
    );

    expect(result.files).toHaveLength(1);
    expect(result.prompt).toContain("[FILE_CONTEXT]");
    expect(result.prompt).toContain("json file");
    expect(result.prompt).toContain("json-note.txt");
    expect(result.diagnostics).toEqual({
      bridgeFilesBlocksDetected: 1,
      bridgeFilesBlockAccepted: true,
      bridgeFilesIgnoredNonTerminalCount: 0,
      bridgeFilesInjectedCount: 1,
    });
  });

  it("ignores a non-terminal [BRIDGE_FILES] block", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bridge-file-context-non-terminal-"));
    const filePath = path.join(dir, "note.txt");
    writeFileSync(filePath, "line 1\nline 2", "utf8");

    const config = makeConfig();
    const prompt = `Use this maybe.\n[BRIDGE_FILES]\n${filePath} | inline-note.txt\n[/BRIDGE_FILES]\nStill drafting instructions.`;
    const result = expandPromptWithBridgeFiles(prompt, undefined, config);

    expect(result.files).toHaveLength(0);
    expect(result.prompt).toBe(prompt);
    expect(result.prompt).not.toContain("[FILE_CONTEXT]");
    expect(result.diagnostics).toEqual({
      bridgeFilesBlocksDetected: 1,
      bridgeFilesBlockAccepted: false,
      bridgeFilesIgnoredNonTerminalCount: 1,
      bridgeFilesInjectedCount: 0,
    });
  });

  it("injects only the last terminal [BRIDGE_FILES] block", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bridge-file-context-last-terminal-"));
    const fileA = path.join(dir, "a.txt");
    const fileB = path.join(dir, "b.txt");
    writeFileSync(fileA, "file A", "utf8");
    writeFileSync(fileB, "file B", "utf8");

    const config = makeConfig();
    const result = expandPromptWithBridgeFiles(
      [
        "Review context.",
        "[BRIDGE_FILES]",
        `${fileA} | first.txt`,
        "[/BRIDGE_FILES]",
        "Quoted from earlier run:",
        "[BRIDGE_FILES]",
        `${fileB} | second.txt`,
        "[/BRIDGE_FILES]",
      ].join("\n"),
      undefined,
      config,
    );

    expect(result.files).toHaveLength(1);
    expect(result.prompt).toContain("[FILE_CONTEXT]");
    expect(result.prompt).toContain("file B");
    expect(result.prompt).toContain("second.txt");
    expect(result.prompt).not.toContain("file A");
    expect(result.prompt).toContain("first.txt");
    expect(result.diagnostics).toEqual({
      bridgeFilesBlocksDetected: 2,
      bridgeFilesBlockAccepted: true,
      bridgeFilesIgnoredNonTerminalCount: 1,
      bridgeFilesInjectedCount: 1,
    });
  });

  it("does not activate on inline [BRIDGE_FILES] mentions without a block", () => {
    const config = makeConfig();
    const prompt = "Explain why the token [BRIDGE_FILES] exists.";
    const result = expandPromptWithBridgeFiles(prompt, undefined, config);

    expect(result.files).toHaveLength(0);
    expect(result.prompt).toBe(prompt);
    expect(result.prompt).not.toContain("[FILE_CONTEXT]");
    expect(result.diagnostics).toEqual({
      bridgeFilesBlocksDetected: 0,
      bridgeFilesBlockAccepted: false,
      bridgeFilesIgnoredNonTerminalCount: 0,
      bridgeFilesInjectedCount: 0,
    });
  });

  it("rejects malformed JSON in [BRIDGE_FILES] prompt blocks", () => {
    const config = makeConfig();

    expect(() =>
      expandPromptWithBridgeFiles(
        "hello\n[BRIDGE_FILES]\n[{\"path\":\"/tmp/a.txt\",]\n[/BRIDGE_FILES]",
        undefined,
        config,
      ),
    ).toThrowError(BridgeError);

    try {
      expandPromptWithBridgeFiles(
        "hello\n[BRIDGE_FILES]\n[{\"path\":\"/tmp/a.txt\",]\n[/BRIDGE_FILES]",
        undefined,
        config,
      );
    } catch (error) {
      const bridgeError = error as BridgeError;
      expect(bridgeError.code).toBe("file_context_invalid");
    }
  });

  it("rejects relative paths", () => {
    const config = makeConfig();

    expect(() =>
      expandPromptWithBridgeFiles(
        "hello",
        [{ path: "./relative.txt" }],
        config,
      ),
    ).toThrowError(BridgeError);
  });

  it("enforces FILE_CONTEXT_ALLOWED_ROOTS", () => {
    const allowedDir = mkdtempSync(path.join(tmpdir(), "bridge-allowed-"));
    const blockedDir = mkdtempSync(path.join(tmpdir(), "bridge-blocked-"));
    const blockedFile = path.join(blockedDir, "blocked.txt");
    writeFileSync(blockedFile, "blocked", "utf8");

    const config = makeConfig({
      FILE_CONTEXT_ALLOWED_ROOTS: allowedDir,
    });

    expect(() =>
      expandPromptWithBridgeFiles(
        "hello",
        [{ path: blockedFile }],
        config,
      ),
    ).toThrowError(BridgeError);

    try {
      expandPromptWithBridgeFiles("hello", [{ path: blockedFile }], config);
    } catch (error) {
      const bridgeError = error as BridgeError;
      expect(bridgeError.code).toBe("file_context_access_denied");
    }
  });

  it("rejects binary file payloads", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bridge-binary-"));
    const filePath = path.join(dir, "binary.bin");
    writeFileSync(filePath, Buffer.from([0x68, 0x69, 0x00, 0x01]));

    const config = makeConfig();
    expect(() =>
      expandPromptWithBridgeFiles(
        "hello",
        [{ path: filePath }],
        config,
      ),
    ).toThrowError(BridgeError);

    try {
      expandPromptWithBridgeFiles("hello", [{ path: filePath }], config);
    } catch (error) {
      const bridgeError = error as BridgeError;
      expect(bridgeError.code).toBe("file_context_unsupported");
    }
  });

  it("enforces FILE_CONTEXT_MAX_FILES", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bridge-max-files-"));
    const fileA = path.join(dir, "a.txt");
    const fileB = path.join(dir, "b.txt");
    writeFileSync(fileA, "a", "utf8");
    writeFileSync(fileB, "b", "utf8");

    const config = makeConfig({ FILE_CONTEXT_MAX_FILES: "1" });

    expect(() =>
      expandPromptWithBridgeFiles(
        "hello",
        [{ path: fileA }, { path: fileB }],
        config,
      ),
    ).toThrowError(BridgeError);
  });

  it("enforces FILE_CONTEXT_MAX_TOTAL_CHARS", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bridge-max-total-"));
    const filePath = path.join(dir, "big.txt");
    writeFileSync(filePath, "abcdef", "utf8");

    const config = makeConfig({ FILE_CONTEXT_MAX_TOTAL_CHARS: "4" });

    expect(() =>
      expandPromptWithBridgeFiles(
        "hello",
        [{ path: filePath }],
        config,
      ),
    ).toThrowError(BridgeError);

    try {
      expandPromptWithBridgeFiles("hello", [{ path: filePath }], config);
    } catch (error) {
      const bridgeError = error as BridgeError;
      expect(bridgeError.code).toBe("prompt_too_large");
    }
  });
});
