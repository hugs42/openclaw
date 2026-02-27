import { createHmac } from "node:crypto";
import { writeFileSync } from "node:fs";
import { BridgeError } from "../errors.js";

export interface ExtractOptions {
  uiLabelRegenerate: string;
  uiLabelContinue: string;
}

export function makeMarker(requestId: string, secret: string): string {
  const sig = createHmac("sha256", secret).update(requestId).digest("base64url").slice(0, 16);
  return `[[OC=${requestId}.${sig}]]`;
}

const BRIDGE_MARKER_EXACT_REGEX = /^\[\[\s*(?:OC|OPENCLAW_RID)=[^[\]\n]+\]\]$/i;
const BRIDGE_MARKER_IN_TEXT_REGEX = /\[\[\s*(?:OC|OPENCLAW_RID)=[^[\]\n]+\]\]/i;
const BRIDGE_MARKER_GLOBAL_REGEX = /\[\[\s*(?:OC|OPENCLAW_RID)=[^[\]\n]+\]\]/gi;
const NON_MEANINGFUL_GLYPHS_REGEX = /[\uFFFC\u200B-\u200F\u2060\uFEFF]/g;

// Known toolbar / chrome labels to strip from extracted response.
const UI_NOISE_LABELS = [
  "Activer/Désactiver La Barre Latérale",
  "Nouveau chat",
  "Partager",
  "Déplacer vers une nouvelle fenêtre",
  "Toggle sidebar",
  "New chat",
  "Share",
  "Move to new window",
];

// AX/UI snippets that are not model answers and can appear in ChatGPT Pro UI.
const UI_NOISE_LINES = new Set([
  "pro",
  "affordance",
  "writing tools",
  "outils d'écriture",
  "outils d’ecriture",
]);

// AX role-description artefacts
const AX_DECORATION_LABELS = new Set(["texte", "text", "static text"]);

// ChatGPT "Thinking" section labels (expandable reasoning block)
const THINKING_PATTERNS = [
  /^\s*Thinking\s*$/i,
  /^\s*Réflexion\s*$/i,
  /^\s*Thinking\s+for\s+\d+\s+seconds?\s*$/i,
  /^\s*Réflexion\s+pendant\s+\d+\s+secondes?\s*$/i,
  /^\s*Thought\s+for\s+\d+\s+seconds?\s*$/i,
  /^\s*A\s+réfléchi\s+pendant\s+\d+\s+secondes?\s*$/i,
];

function normalizeLine(line: string): string {
  return stripNonMeaningfulGlyphs(line).trim().toLowerCase().replace(/\s+/g, " ");
}

function isUiNoiseLine(line: string): boolean {
  return UI_NOISE_LINES.has(normalizeLine(line));
}

function normalizeForEchoCompare(value: string): string {
  return stripNonMeaningfulGlyphs(value).replace(/\r\n/g, "\n").replace(/\s+/g, " ").trim();
}

function stripNonMeaningfulGlyphs(value: string): string {
  return value.replace(NON_MEANINGFUL_GLYPHS_REGEX, "");
}

function isBridgeFileContextLine(line: string): boolean {
  const trimmed = line.trim();
  const lowered = normalizeLine(trimmed);
  return (
    lowered === "[file_context]"
    || lowered === "[/file_context]"
    || lowered.startsWith("the following file contents were injected by the local bridge")
    || lowered.startsWith("treat them as authoritative snapshots of the local filesystem")
    || /^files:\s*\d+$/i.test(trimmed)
    || isBridgeFileBeginLine(trimmed)
    || isBridgeFileEndLine(trimmed)
    || /^path:\s+/i.test(trimmed)
  );
}

function isBridgeFileBeginLine(line: string): boolean {
  return /^---\s*begin file:/i.test(line.trim());
}

function isBridgeFileEndLine(line: string): boolean {
  return /^---\s*end file:/i.test(line.trim());
}

function stripLeadingPromptEcho(text: string, sentPrompt: string): string {
  const promptLineSet = new Set(
    sentPrompt
      .split("\n")
      .map((line) => normalizeLine(line))
      .filter((line) => line.length > 0),
  );

  const lines = text.split("\n");
  let start = 0;
  let removedPromptLikeLines = 0;
  let removedArtifactLines = 0;
  let inEchoFileBlock = false;

  while (start < lines.length) {
    const raw = lines[start];
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      start++;
      continue;
    }

    const normalized = normalizeLine(trimmed);

    if (inEchoFileBlock) {
      if (isBridgeFileEndLine(trimmed)) {
        inEchoFileBlock = false;
        removedArtifactLines++;
      }
      start++;
      continue;
    }

    if (promptLineSet.has(normalized)) {
      removedPromptLikeLines++;
      start++;
      continue;
    }

    if (isBridgeFileBeginLine(trimmed)) {
      inEchoFileBlock = true;
      removedArtifactLines++;
      start++;
      continue;
    }

    if (isBridgeFileContextLine(trimmed)) {
      removedArtifactLines++;
      start++;
      continue;
    }

    break;
  }

  if (removedArtifactLines > 0 || removedPromptLikeLines >= 2) {
    return lines.slice(start).join("\n").trim();
  }

  return text.trim();
}

function isLikelyPromptEcho(text: string, sentPrompt: string): boolean {
  const candidate = text.trim();
  const prompt = sentPrompt.trim();
  if (candidate.length === 0 || prompt.length === 0) {
    return false;
  }

  // Long extracted segments that are contained in the prompt are prompt echoes.
  const normalizedCandidate = normalizeForEchoCompare(candidate);
  const normalizedPrompt = normalizeForEchoCompare(prompt);
  if (
    normalizedPrompt.includes(normalizedCandidate)
    && (normalizedCandidate.length >= 120 || candidate.includes("\n"))
  ) {
    return true;
  }

  const promptLineSet = new Set(
    prompt
      .split("\n")
      .map((line) => normalizeLine(line))
      .filter((line) => line.length > 0),
  );
  const candidateLines = candidate
    .split("\n")
    .map((line) => normalizeLine(line))
    .filter((line) => line.length > 0);

  if (candidateLines.length < 3) {
    return false;
  }

  let overlapCount = 0;
  for (const line of candidateLines) {
    if (promptLineSet.has(line)) {
      overlapCount++;
    }
  }

  return overlapCount / candidateLines.length >= 0.8;
}

function isMeaningfulExtractedText(text: string, sentPrompt: string): boolean {
  const trimmed = stripNonMeaningfulGlyphs(text).trim();
  if (trimmed.length === 0) {
    return false;
  }

  if (trimmed === stripNonMeaningfulGlyphs(sentPrompt).trim()) {
    return false;
  }

  if (isLikelyPromptEcho(trimmed, sentPrompt)) {
    return false;
  }

  // Any leaked marker in extracted payload indicates we did not isolate a clean
  // assistant response segment for the current request.
  if (BRIDGE_MARKER_IN_TEXT_REGEX.test(trimmed)) {
    return false;
  }

  const lines = trimmed.split("\n").map((l) => normalizeLine(l)).filter((l) => l.length > 0);
  if (lines.length === 0) {
    return false;
  }

  const allNoiseLines = lines.every((line) => UI_NOISE_LINES.has(line));
  return !allNoiseLines;
}

function stripUiNoise(text: string, options: ExtractOptions): string {
  let cleaned = text;
  for (const label of UI_NOISE_LABELS) {
    cleaned = cleaned.replaceAll(label, "");
  }
  cleaned = cleaned
    .replaceAll("Regenerate response", "")
    .replaceAll(options.uiLabelRegenerate, "")
    .replaceAll(options.uiLabelContinue, "")
    .replaceAll("▍", "");
  cleaned = cleaned.replace(/\bChatGPT\s+\d+\.\d+\b/g, "");
  cleaned = cleaned
    .split("\n")
    .filter((l) => !AX_DECORATION_LABELS.has(l.trim().toLowerCase()))
    .filter((l) => !isUiNoiseLine(l))
    .filter((l) => !THINKING_PATTERNS.some((p) => p.test(l)))
    .join("\n");
  cleaned = stripNonMeaningfulGlyphs(cleaned);
  return cleaned.replace(/[ \t]{2,}/g, " ").trim();
}

function finalizeExtractedCandidate(candidate: string, sentPrompt: string): string {
  const withoutLeadingEcho = stripLeadingPromptEcho(candidate, sentPrompt);
  return deduplicateAxText(withoutLeadingEcho).trim();
}

function deduplicateAxText(text: string): string {
  const trimmed = text.trim();
  const mid = Math.floor(trimmed.length / 2);
  if (mid > 0) {
    const firstHalf = trimmed.slice(0, mid).trim();
    const secondHalf = trimmed.slice(mid).trim();
    if (firstHalf === secondHalf) return firstHalf;
  }
  const lines = trimmed.split("\n");
  if (lines.length < 4) return trimmed;
  for (let offset = -2; offset <= 2; offset++) {
    const split = Math.floor(lines.length / 2) + offset;
    if (split <= 0 || split >= lines.length) continue;
    const firstHalf = lines.slice(0, split).join("\n").trim();
    const secondHalf = lines.slice(split).join("\n").trim();
    if (firstHalf === secondHalf) return firstHalf;
  }
  return trimmed;
}

function dumpScrapedText(fullText: string, sentPrompt: string): void {
  try {
    writeFileSync("/tmp/bridge-scraped-text.txt", `sentPrompt: ${sentPrompt.slice(0, 300)}\n---\n${fullText}`);
  } catch {
    // ignore
  }
}

function resolveBridgeMarker(anchor: string): string | null {
  const trimmed = anchor.trim();
  if (BRIDGE_MARKER_EXACT_REGEX.test(trimmed)) {
    return trimmed;
  }
  const matches = anchor.match(BRIDGE_MARKER_GLOBAL_REGEX);
  if (!matches || matches.length === 0) {
    return null;
  }
  return matches[matches.length - 1].trim();
}

export function hasBridgeMarkerInAnchor(anchor: string): boolean {
  return resolveBridgeMarker(anchor) !== null;
}

export interface ExtractWithSnapshotFallbackOptions {
  previousFullText: string;
}

export interface ExtractWithSnapshotFallbackResult {
  text: string;
  mode: "marker" | "snapshot_delta";
}

function longestCommonPrefixLength(left: string, right: string): number {
  const max = Math.min(left.length, right.length);
  let index = 0;
  while (index < max && left[index] === right[index]) {
    index += 1;
  }
  return index;
}

function extractSnapshotDelta(fullText: string, previousFullText: string): string {
  if (previousFullText.length === 0) {
    return fullText;
  }

  const tail = previousFullText.slice(-1024);
  if (tail.length >= 128) {
    const tailIndex = fullText.lastIndexOf(tail);
    if (tailIndex >= 0) {
      return fullText.slice(tailIndex + tail.length);
    }
  }

  const prefixLength = longestCommonPrefixLength(fullText, previousFullText);
  return fullText.slice(prefixLength);
}

export function extractAfterMarkerWithSnapshotFallback(
  fullText: string,
  marker: string,
  options: ExtractOptions,
  fallback: ExtractWithSnapshotFallbackOptions,
): ExtractWithSnapshotFallbackResult {
  const bridgeMarker = resolveBridgeMarker(marker);

  try {
    const markerText = extractAfterMarker(fullText, marker, options);
    return { text: markerText, mode: "marker" };
  } catch (error) {
    const bridgeError = error instanceof BridgeError ? error : null;
    const isUiExtractionError = bridgeError?.code === "ui_error";

    // Strict mode for bridge markers: never fallback to snapshot delta.
    // A marker-backed request is only complete when extraction succeeds after
    // the current marker.
    if (bridgeMarker) {
      throw error;
    }

    if (!isUiExtractionError) {
      throw error;
    }

    if (fallback.previousFullText.trim().length === 0) {
      throw error;
    }

    const delta = extractSnapshotDelta(fullText, fallback.previousFullText);
    const cleaned = stripUiNoise(delta, options);
    const result = finalizeExtractedCandidate(cleaned, marker);
    if (isMeaningfulExtractedText(result, marker)) {
      return { text: result, mode: "snapshot_delta" };
    }

    throw new BridgeError("ui_error", "Response delta after snapshot is not ready", {
      reason: "response_not_ready",
      extractionMode: "snapshot_delta",
    });
  }
}

/**
 * Extract ChatGPT's response from the scraped AX tree text.
 *
 * In plain-text mode the "marker" parameter is the sent prompt itself.
 * The AX tree (desc + axdesc) typically contains:
 *   <sent prompt>          (desc copy)
 *   <sent prompt>          (axdesc duplicate)
 *   <ChatGPT response>    (desc copy)
 *   <ChatGPT response>    (axdesc duplicate)
 *   <toolbar labels>
 *
 * We find the last occurrence of the sent prompt and take everything
 * after it, then strip UI noise and deduplicate.
 */
export function extractAfterMarker(fullText: string, marker: string, options: ExtractOptions): string {
  const sentPrompt = marker;
  const bridgeMarker = resolveBridgeMarker(marker);

  if (bridgeMarker) {
    const lastMarkerIndex = fullText.lastIndexOf(bridgeMarker);
    if (lastMarkerIndex < 0) {
      throw new BridgeError("ui_error", "Current marker not yet visible in scraped text", {
        reason: "marker_not_found",
      });
    }

    const afterMarker = fullText.slice(lastMarkerIndex + bridgeMarker.length);
    const cleaned = stripUiNoise(afterMarker, options);
    const result = finalizeExtractedCandidate(cleaned, sentPrompt);
    if (isMeaningfulExtractedText(result, sentPrompt)) {
      return result;
    }

    throw new BridgeError("ui_error", "Response after current marker is not ready", {
      reason: "response_not_ready",
    });
  }

  // Find the LAST occurrence of the sent prompt — the AX tree may
  // include it twice (desc + axdesc), so lastIndexOf skips the first copy.
  const lastPromptIndex = fullText.lastIndexOf(sentPrompt);

  if (lastPromptIndex >= 0) {
    const afterPrompt = fullText.slice(lastPromptIndex + sentPrompt.length);
    const cleaned = stripUiNoise(afterPrompt, options);
    const result = finalizeExtractedCandidate(cleaned, sentPrompt);
    if (isMeaningfulExtractedText(result, sentPrompt)) {
      return result;
    }
  }

  // Fallback: find first occurrence
  const firstPromptIndex = fullText.indexOf(sentPrompt);
  if (firstPromptIndex >= 0) {
    const afterPrompt = fullText.slice(firstPromptIndex + sentPrompt.length);
    const cleaned = stripUiNoise(afterPrompt, options);
    // Strip any remaining echo of the prompt
    const withoutEcho = cleaned.replace(sentPrompt, "").trim();
    const result = finalizeExtractedCandidate(withoutEcho.length > 0 ? withoutEcho : cleaned, sentPrompt);
    if (isMeaningfulExtractedText(result, sentPrompt)) {
      return result;
    }
  }

  // Last resort: walk backwards from end, collect non-noise text,
  // stop when we hit a line that matches (part of) the sent prompt.
  {
    const lines = fullText.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
    const noiseSet = new Set(UI_NOISE_LABELS.map((l) => l.toLowerCase()));
    // Use the first line of the prompt as a stop marker
    const promptFirstLine = sentPrompt.split("\n")[0].trim();
    const meaningful: string[] = [];
    for (let i = lines.length - 1; i >= 0; i--) {
      const lower = lines[i].toLowerCase();
      if (noiseSet.has(lower) || AX_DECORATION_LABELS.has(lower) || isUiNoiseLine(lower)) continue;
      if (/^chatgpt\s+\d+\.\d+$/i.test(lines[i])) continue;
      if (isBridgeFileContextLine(lines[i])) continue;
      // Stop at prompt boundary
      if (promptFirstLine.length > 10 && lines[i].includes(promptFirstLine)) break;
      if (lines[i] === sentPrompt) break;
      meaningful.unshift(lines[i]);
    }
    const cleaned = stripUiNoise(meaningful.join("\n"), options);
    const result = finalizeExtractedCandidate(cleaned, sentPrompt);
    if (isMeaningfulExtractedText(result, sentPrompt)) {
      return result;
    }
  }

  dumpScrapedText(fullText, sentPrompt);
  throw new BridgeError("ui_error", "Could not extract response from scraped text", {
    reason: "extraction_failed",
    textLength: fullText.length,
  });
}
