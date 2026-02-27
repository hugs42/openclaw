import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileSessionBindingStore } from "../src/session/store.js";

const tempDirs: string[] = [];

async function createStoreFilePath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "bridge-bindings-"));
  tempDirs.push(dir);
  return join(dir, "session-bindings.json");
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("FileSessionBindingStore", () => {
  it("returns empty bindings when file does not exist", async () => {
    const filePath = await createStoreFilePath();
    const store = new FileSessionBindingStore(filePath);
    await store.load();

    expect(store.get("default")).toBeUndefined();
  });

  it("persists and reloads slot bindings", async () => {
    const filePath = await createStoreFilePath();
    const first = new FileSessionBindingStore(filePath);
    await first.load();
    await first.set("default", "Project Alpha");
    await first.set(" Team-A ", "Project Beta");

    const second = new FileSessionBindingStore(filePath);
    await second.load();

    expect(second.get("default")).toBe("Project Alpha");
    expect(second.get("team-a")).toBe("Project Beta");
  });

  it("deletes a stored binding", async () => {
    const filePath = await createStoreFilePath();
    const store = new FileSessionBindingStore(filePath);
    await store.load();
    await store.set("default", "Project Alpha");
    await store.delete("default");

    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as { bindings: Record<string, string> };
    expect(parsed.bindings.default).toBeUndefined();
  });

  it("writes atomically without leaving temporary files", async () => {
    const filePath = await createStoreFilePath();
    const store = new FileSessionBindingStore(filePath);
    await store.load();

    await Promise.all([
      store.set("slot-1", "Conversation 1"),
      store.set("slot-2", "Conversation 2"),
      store.set("slot-3", "Conversation 3"),
    ]);

    const dirEntries = await readdir(dirname(filePath));
    expect(dirEntries.some((name) => name.endsWith(".tmp"))).toBe(false);
  });
});
