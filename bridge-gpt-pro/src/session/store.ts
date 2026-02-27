import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname } from "node:path";

interface SessionBindingsFile {
  bindings: Record<string, string>;
}

export interface SessionBindingStore {
  load(): Promise<void>;
  get(slot: string): string | undefined;
  set(slot: string, conversationId: string): Promise<void>;
  delete(slot: string): Promise<void>;
}

export function normalizeSessionSlot(slot: string | undefined): string {
  const normalized = slot?.trim().toLowerCase();
  if (!normalized) {
    return "default";
  }
  return normalized;
}

export function normalizeConversationId(conversationId: string | undefined): string | undefined {
  const normalized = conversationId?.trim();
  if (!normalized) {
    return undefined;
  }
  return normalized;
}

function parseBindingsFile(raw: string): Record<string, string> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    const base =
      parsed && typeof parsed === "object" && !Array.isArray(parsed) && "bindings" in parsed
        ? (parsed as SessionBindingsFile).bindings
        : parsed;

    if (!base || typeof base !== "object" || Array.isArray(base)) {
      return {};
    }

    const output: Record<string, string> = {};
    for (const [slot, conversationId] of Object.entries(base as Record<string, unknown>)) {
      if (typeof conversationId !== "string") {
        continue;
      }
      const normalizedSlot = normalizeSessionSlot(slot);
      const normalizedConversationId = normalizeConversationId(conversationId);
      if (!normalizedConversationId) {
        continue;
      }
      output[normalizedSlot] = normalizedConversationId;
    }
    return output;
  } catch {
    return {};
  }
}

export class FileSessionBindingStore implements SessionBindingStore {
  private readonly bindings = new Map<string, string>();
  private loaded = false;
  private writeChain: Promise<void> = Promise.resolve();

  public constructor(private readonly filePath: string) {}

  public async load(): Promise<void> {
    if (this.loaded) {
      return;
    }

    let raw = "";
    try {
      raw = await fs.readFile(this.filePath, "utf8");
    } catch (error) {
      const withCode = error as NodeJS.ErrnoException;
      if (withCode.code === "ENOENT") {
        this.loaded = true;
        return;
      }
      throw error;
    }

    const parsed = parseBindingsFile(raw);
    for (const [slot, conversationId] of Object.entries(parsed)) {
      this.bindings.set(slot, conversationId);
    }
    this.loaded = true;
  }

  public get(slot: string): string | undefined {
    return this.bindings.get(normalizeSessionSlot(slot));
  }

  public async set(slot: string, conversationId: string): Promise<void> {
    const normalizedSlot = normalizeSessionSlot(slot);
    const normalizedConversationId = normalizeConversationId(conversationId);
    if (!normalizedConversationId) {
      await this.delete(normalizedSlot);
      return;
    }

    this.bindings.set(normalizedSlot, normalizedConversationId);
    await this.enqueuePersist();
  }

  public async delete(slot: string): Promise<void> {
    const normalizedSlot = normalizeSessionSlot(slot);
    const hadBinding = this.bindings.delete(normalizedSlot);
    if (!hadBinding) {
      return;
    }
    await this.enqueuePersist();
  }

  private async enqueuePersist(): Promise<void> {
    this.writeChain = this.writeChain.catch(() => undefined).then(() => this.persistToDisk());
    await this.writeChain;
  }

  private async persistToDisk(): Promise<void> {
    await fs.mkdir(dirname(this.filePath), { recursive: true });

    const payload: SessionBindingsFile = {
      bindings: Object.fromEntries(this.bindings.entries()),
    };

    const serialized = `${JSON.stringify(payload, null, 2)}\n`;
    const tmpPath = `${this.filePath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;

    await fs.writeFile(tmpPath, serialized, "utf8");
    await fs.rename(tmpPath, this.filePath);
  }
}

export class NoopSessionBindingStore implements SessionBindingStore {
  public async load(): Promise<void> {
    return;
  }

  public get(_slot: string): string | undefined {
    return undefined;
  }

  public async set(_slot: string, _conversationId: string): Promise<void> {
    return;
  }

  public async delete(_slot: string): Promise<void> {
    return;
  }
}
