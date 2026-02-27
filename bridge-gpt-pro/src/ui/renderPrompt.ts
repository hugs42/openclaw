export type PromptRole = "system" | "user" | "assistant";

export interface PromptMessage {
  role: PromptRole;
  content: string;
}

const INTERNAL_CONTROL_PROMPT_PATTERNS = [
  /^agent-to-agent announce step\.?$/i,
  /^announce_skip$/i,
  /^reply_skip$/i,
];

export function isInternalControlPrompt(text: string): boolean {
  const collapsed = text.replace(/\r\n/g, "\n").trim().replace(/\s+/g, " ");
  if (collapsed.length === 0) {
    return false;
  }
  return INTERNAL_CONTROL_PROMPT_PATTERNS.some((pattern) => pattern.test(collapsed));
}

/**
 * Render messages into plain natural language — no markers, no role tags,
 * no system instructions.  Just the last user message, as if a human
 * typed it into ChatGPT.
 */
export function renderMessagesToPrompt(
  messages: PromptMessage[],
  _marker: string,
  _metaInstructions: string,
): string {
  // Take only the last user message — ChatGPT Desktop already has its
  // own system prompt and conversation context.
  const userMessages = messages.filter((m) => m.role === "user");
  if (userMessages.length === 0) return "";
  const last = userMessages[userMessages.length - 1];
  return stripSubagentMetadata(last.content.replace(/\r\n/g, "\n").trim());
}

/**
 * Strip OpenClaw subagent metadata injected into user message content.
 * These blocks are meant for the LLM system prompt, not for ChatGPT Desktop.
 */
function stripSubagentMetadata(text: string): string {
  let cleaned = text;
  // Remove classic "[Subagent Context] ... [Subagent Task]" preamble blocks.
  cleaned = cleaned.replace(
    /^\s*\[\s*Subagent Context[^\]]*\][\s\S]*?(?=^\s*(?:\[\s*Subagent Task\s*\]\s*:?\s*|#{1,6}\s*Subagent Task\b))/im,
    "",
  );
  // Remove markdown "## Subagent Context ... ## Subagent Task" preamble blocks.
  cleaned = cleaned.replace(
    /^\s*#{1,6}\s*Subagent Context\b[^\n]*\n[\s\S]*?(?=^\s*(?:\[\s*Subagent Task\s*\]\s*:?\s*|#{1,6}\s*Subagent Task\b))/im,
    "",
  );
  // Remove subagent task headers while preserving the natural language task body.
  cleaned = cleaned.replace(/^\s*\[\s*Subagent Task\s*\]\s*:?\s*/im, "");
  cleaned = cleaned.replace(/^\s*#{1,6}\s*Subagent Task\b\s*:?\s*/im, "");
  // Remove bridge markers if they leak into message content.
  cleaned = cleaned.replace(/\[\[\s*(?:OC|OPENCLAW_RID)=[^[\]\n]+\]\]/gi, "");
  // Remove timestamp headers like [Wed 2026-02-25 22:53 GMT+1]
  cleaned = cleaned.replace(/\[[A-Z][a-z]{2}\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+GMT[^\]]*\]\s*/g, "");

  // Final line-level pass: never forward subagent context/control lines.
  const keptLines: string[] = [];
  for (const line of cleaned.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      keptLines.push("");
      continue;
    }

    if (
      /^\[\s*Subagent Context[^\]]*\]/i.test(trimmed) ||
      /^#{1,6}\s*Subagent Context\b/i.test(trimmed) ||
      /^Subagent Context\b/i.test(trimmed)
    ) {
      continue;
    }

    const bracketTask = trimmed.match(/^\[\s*Subagent Task\s*\]\s*:?\s*(.*)$/i);
    if (bracketTask) {
      const rest = bracketTask[1]?.trim() ?? "";
      if (rest.length > 0) keptLines.push(rest);
      continue;
    }

    const headingTask = trimmed.match(/^#{1,6}\s*Subagent Task\b\s*:?\s*(.*)$/i);
    if (headingTask) {
      const rest = headingTask[1]?.trim() ?? "";
      if (rest.length > 0) keptLines.push(rest);
      continue;
    }

    const plainTask = trimmed.match(/^Subagent Task\b\s*:?\s*(.*)$/i);
    if (plainTask) {
      const rest = plainTask[1]?.trim() ?? "";
      if (rest.length > 0) keptLines.push(rest);
      continue;
    }

    keptLines.push(line);
  }

  cleaned = keptLines.join("\n").replace(/\n{3,}/g, "\n\n");
  return cleaned.trim();
}
