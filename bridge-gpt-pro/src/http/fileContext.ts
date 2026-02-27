import { TextDecoder } from "node:util";
import { readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import type { BridgeConfig } from "../config.js";
import { BridgeError } from "../errors.js";

export interface BridgeFileReference {
  path: string;
  label?: string;
  encoding?: string;
}

export interface ResolvedBridgeFile {
  path: string;
  label: string;
  content: string;
  chars: number;
}

export interface FileContextResult {
  prompt: string;
  files: ResolvedBridgeFile[];
  diagnostics: FileContextDiagnostics;
}

export interface FileContextDiagnostics {
  bridgeFilesBlocksDetected: number;
  bridgeFilesBlockAccepted: boolean;
  bridgeFilesIgnoredNonTerminalCount: number;
  bridgeFilesInjectedCount: number;
}

interface NormalizedFileReference {
  path: string;
  label: string;
  encoding: string;
}

const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const BRIDGE_FILES_BLOCK_RE = /\[BRIDGE_FILES\]([\s\S]*?)\[\/BRIDGE_FILES\]/gi;

interface PromptBridgeFileExtractionResult {
  prompt: string;
  references: BridgeFileReference[];
  diagnostics: Omit<FileContextDiagnostics, "bridgeFilesInjectedCount">;
}

function stripWrappingQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith("\"") && trimmed.endsWith("\"")) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function parseJsonBridgeFileReference(entry: unknown, source: string): BridgeFileReference {
  if (typeof entry === "string") {
    return { path: stripWrappingQuotes(entry) };
  }
  if (!entry || typeof entry !== "object") {
    throw new BridgeError("file_context_invalid", `Invalid ${source} entry: expected object or string path`);
  }
  const record = entry as { path?: unknown; label?: unknown; encoding?: unknown };
  if (typeof record.path !== "string" || !record.path.trim()) {
    throw new BridgeError("file_context_invalid", `Invalid ${source} entry: missing path`);
  }

  const ref: BridgeFileReference = { path: stripWrappingQuotes(record.path) };
  if (typeof record.label === "string" && record.label.trim()) {
    ref.label = stripWrappingQuotes(record.label);
  }
  if (typeof record.encoding === "string" && record.encoding.trim()) {
    ref.encoding = record.encoding.trim();
  }
  return ref;
}

function parsePromptBridgeFilesBlock(blockBody: string): BridgeFileReference[] {
  const trimmed = blockBody.trim();
  if (!trimmed) {
    return [];
  }

  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      throw new BridgeError("file_context_invalid", "Invalid [BRIDGE_FILES] JSON block", {
        cause: (error as Error).message,
      });
    }

    const entries = Array.isArray(parsed) ? parsed : [parsed];
    return entries.map((entry) => parseJsonBridgeFileReference(entry, "[BRIDGE_FILES] JSON"));
  }

  const refs: BridgeFileReference[] = [];
  for (const rawLine of blockBody.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line) {
      continue;
    }
    line = line.replace(/^[-*]\s+/, "").trim();
    if (!line || line.startsWith("#") || line.startsWith("//")) {
      continue;
    }

    if (line.startsWith("{") && line.endsWith("}")) {
      let parsedLine: unknown;
      try {
        parsedLine = JSON.parse(line);
      } catch (error) {
        throw new BridgeError("file_context_invalid", "Invalid JSON line in [BRIDGE_FILES] block", {
          line,
          cause: (error as Error).message,
        });
      }
      refs.push(parseJsonBridgeFileReference(parsedLine, "[BRIDGE_FILES] line"));
      continue;
    }

    const separatorIndex = line.indexOf("|");
    const pathPart = separatorIndex >= 0 ? line.slice(0, separatorIndex).trim() : line;
    const labelPart = separatorIndex >= 0 ? line.slice(separatorIndex + 1).trim() : "";
    const ref: BridgeFileReference = { path: stripWrappingQuotes(pathPart) };
    if (labelPart) {
      ref.label = stripWrappingQuotes(labelPart);
    }
    refs.push(ref);
  }

  return refs;
}

function extractPromptBridgeFileReferences(prompt: string): PromptBridgeFileExtractionResult {
  const matches: Array<{ start: number; end: number; body: string }> = [];
  BRIDGE_FILES_BLOCK_RE.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = BRIDGE_FILES_BLOCK_RE.exec(prompt)) !== null) {
    const fullMatch = String(match[0] ?? "");
    matches.push({
      start: match.index,
      end: match.index + fullMatch.length,
      body: String(match[1] ?? ""),
    });
  }

  if (matches.length === 0) {
    return {
      prompt,
      references: [],
      diagnostics: {
        bridgeFilesBlocksDetected: 0,
        bridgeFilesBlockAccepted: false,
        bridgeFilesIgnoredNonTerminalCount: 0,
      },
    };
  }

  const lastMatch = matches[matches.length - 1];
  const trailing = prompt.slice(lastMatch.end);
  const isTerminalBlock = trailing.trim().length === 0;

  if (!isTerminalBlock) {
    return {
      prompt,
      references: [],
      diagnostics: {
        bridgeFilesBlocksDetected: matches.length,
        bridgeFilesBlockAccepted: false,
        bridgeFilesIgnoredNonTerminalCount: matches.length,
      },
    };
  }

  const references = parsePromptBridgeFilesBlock(lastMatch.body);
  const promptWithoutTerminalDirective = `${prompt.slice(0, lastMatch.start)}${prompt.slice(lastMatch.end)}`;
  return {
    prompt: promptWithoutTerminalDirective.replace(/\n{3,}/g, "\n\n").trimEnd(),
    references,
    diagnostics: {
      bridgeFilesBlocksDetected: matches.length,
      bridgeFilesBlockAccepted: true,
      bridgeFilesIgnoredNonTerminalCount: Math.max(0, matches.length - 1),
    },
  };
}

function isPathUnderRoot(targetPath: string, rootPath: string): boolean {
  const relative = path.relative(rootPath, targetPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function normalizeFileReference(ref: BridgeFileReference): NormalizedFileReference {
  const inputPath = String(ref.path ?? "").trim();
  if (!inputPath) {
    throw new BridgeError("file_context_invalid", "bridge_files[].path is required");
  }

  if (!path.isAbsolute(inputPath)) {
    throw new BridgeError("file_context_invalid", "bridge_files[].path must be absolute", {
      path: inputPath,
    });
  }

  const label = String(ref.label ?? inputPath).trim();
  if (!label) {
    throw new BridgeError("file_context_invalid", "bridge_files[].label cannot be empty", {
      path: inputPath,
    });
  }

  const encoding = String(ref.encoding ?? "utf8").trim().toLowerCase();
  if (encoding !== "utf8" && encoding !== "utf-8") {
    throw new BridgeError("file_context_unsupported", "Only utf8 encoding is supported for bridge_files", {
      path: inputPath,
      encoding,
    });
  }

  return {
    path: inputPath,
    label,
    encoding: "utf8",
  };
}

function resolveAllowedRoots(rawRoots: string[]): string[] {
  return rawRoots
    .map((rootPath) => String(rootPath).trim())
    .filter((rootPath) => rootPath.length > 0)
    .map((rootPath) => {
      const expanded = path.resolve(rootPath);
      try {
        return realpathSync(expanded);
      } catch {
        return expanded;
      }
    });
}

function enforceAllowedRoots(targetPath: string, allowedRoots: string[]): void {
  if (allowedRoots.length === 0) {
    return;
  }

  const allowed = allowedRoots.some((rootPath) => isPathUnderRoot(targetPath, rootPath));
  if (!allowed) {
    throw new BridgeError(
      "file_context_access_denied",
      "bridge_files path is outside FILE_CONTEXT_ALLOWED_ROOTS",
      { path: targetPath },
    );
  }
}

function loadFile(pathInput: string): { canonicalPath: string; content: string } {
  const resolvedPath = path.resolve(pathInput);
  let canonicalPath = resolvedPath;
  try {
    canonicalPath = realpathSync(resolvedPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new BridgeError("file_context_not_found", "bridge_files path does not exist", {
        path: resolvedPath,
      });
    }
    if (code === "EACCES" || code === "EPERM") {
      throw new BridgeError("file_context_access_denied", "bridge_files path cannot be accessed", {
        path: resolvedPath,
      });
    }
    throw new BridgeError("file_context_invalid", "Failed to resolve bridge_files path", {
      path: resolvedPath,
      code,
    });
  }

  let stats;
  try {
    stats = statSync(canonicalPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new BridgeError("file_context_not_found", "bridge_files path does not exist", {
        path: canonicalPath,
      });
    }
    if (code === "EACCES" || code === "EPERM") {
      throw new BridgeError("file_context_access_denied", "bridge_files path cannot be stat'ed", {
        path: canonicalPath,
      });
    }
    throw new BridgeError("file_context_invalid", "Failed to stat bridge_files path", {
      path: canonicalPath,
      code,
    });
  }

  if (!stats.isFile()) {
    throw new BridgeError("file_context_invalid", "bridge_files path must target a file", {
      path: canonicalPath,
    });
  }

  let raw: Buffer;
  try {
    raw = readFileSync(canonicalPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new BridgeError("file_context_not_found", "bridge_files path does not exist", {
        path: canonicalPath,
      });
    }
    if (code === "EACCES" || code === "EPERM") {
      throw new BridgeError("file_context_access_denied", "bridge_files path cannot be read", {
        path: canonicalPath,
      });
    }
    throw new BridgeError("file_context_invalid", "Failed to read bridge_files path", {
      path: canonicalPath,
      code,
    });
  }

  if (raw.includes(0)) {
    throw new BridgeError("file_context_unsupported", "bridge_files binary content is not supported", {
      path: canonicalPath,
    });
  }

  let decoded: string;
  try {
    decoded = UTF8_DECODER.decode(raw);
  } catch {
    throw new BridgeError("file_context_unsupported", "bridge_files content is not valid utf8", {
      path: canonicalPath,
    });
  }

  return {
    canonicalPath,
    content: decoded.replace(/\r\n/g, "\n"),
  };
}

export function expandPromptWithBridgeFiles(
  prompt: string,
  files: BridgeFileReference[] | undefined,
  config: BridgeConfig,
): FileContextResult {
  const normalizedPrompt = String(prompt ?? "");
  const extractedPromptFiles = extractPromptBridgeFileReferences(normalizedPrompt);
  const requestedFiles = [...(files ?? []), ...extractedPromptFiles.references];

  if (requestedFiles.length === 0) {
    return {
      prompt: extractedPromptFiles.prompt,
      files: [],
      diagnostics: {
        ...extractedPromptFiles.diagnostics,
        bridgeFilesInjectedCount: 0,
      },
    };
  }

  if (!config.fileContextEnabled) {
    throw new BridgeError("file_context_unsupported", "bridge_files is disabled by FILE_CONTEXT_ENABLED=false");
  }

  const allowedRoots = resolveAllowedRoots(config.fileContextAllowedRoots);
  const resolvedFiles: ResolvedBridgeFile[] = [];
  const seenCanonicalPaths = new Set<string>();
  let totalChars = 0;

  for (const ref of requestedFiles) {
    const normalized = normalizeFileReference(ref);
    const loaded = loadFile(normalized.path);
    enforceAllowedRoots(loaded.canonicalPath, allowedRoots);
    if (seenCanonicalPaths.has(loaded.canonicalPath)) {
      continue;
    }

    if (resolvedFiles.length >= config.fileContextMaxFiles) {
      throw new BridgeError("file_context_invalid", "Too many bridge_files entries", {
        maxFiles: config.fileContextMaxFiles,
        files: resolvedFiles.length + 1,
      });
    }

    if (loaded.content.length > config.fileContextMaxFileChars) {
      throw new BridgeError("prompt_too_large", "bridge_files file exceeds FILE_CONTEXT_MAX_FILE_CHARS", {
        path: loaded.canonicalPath,
        maxFileChars: config.fileContextMaxFileChars,
        fileChars: loaded.content.length,
      });
    }

    totalChars += loaded.content.length;
    if (totalChars > config.fileContextMaxTotalChars) {
      throw new BridgeError("prompt_too_large", "bridge_files payload exceeds FILE_CONTEXT_MAX_TOTAL_CHARS", {
        maxTotalChars: config.fileContextMaxTotalChars,
        totalChars,
      });
    }

    resolvedFiles.push({
      path: loaded.canonicalPath,
      label: normalized.label,
      content: loaded.content,
      chars: loaded.content.length,
    });
    seenCanonicalPaths.add(loaded.canonicalPath);
  }

  const fileBlocks = resolvedFiles
    .map((file) => {
      return [
        `--- BEGIN FILE: ${file.label} ---`,
        `path: ${file.path}`,
        file.content,
        `--- END FILE: ${file.label} ---`,
      ].join("\n");
    })
    .join("\n\n");

  const mergedPrompt = [
    extractedPromptFiles.prompt,
    "",
    "[FILE_CONTEXT]",
    "The following file contents were injected by the local bridge.",
    "Treat them as authoritative snapshots of the local filesystem.",
    `files: ${resolvedFiles.length}`,
    fileBlocks,
    "[/FILE_CONTEXT]",
  ].join("\n");

  return {
    prompt: mergedPrompt,
    files: resolvedFiles,
    diagnostics: {
      ...extractedPromptFiles.diagnostics,
      bridgeFilesInjectedCount: resolvedFiles.length,
    },
  };
}
