import type { Response } from "express";

export interface SseChunkPayload {
  id: string;
  object: "chat.completion.chunk";
  choices: Array<{
    index: number;
    delta: {
      role?: "assistant";
      content?: string;
    };
  }>;
}

export function setupSseHeaders(res: Response): void {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
}

export function writeSseData(res: Response, payload: SseChunkPayload | "[DONE]"): void {
  if (payload === "[DONE]") {
    res.write("data: [DONE]\n\n");
    return;
  }

  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}
