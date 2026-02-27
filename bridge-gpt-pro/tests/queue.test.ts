import { describe, expect, it } from "vitest";
import { SingleFlightQueue } from "../src/utils/queue.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("SingleFlightQueue", () => {
  it("rejects when queue is full", async () => {
    const queue = new SingleFlightQueue({ maxSize: 1, defaultTimeoutMs: 500 });

    const running = queue.add(async () => {
      await sleep(50);
      return "first";
    });

    await expect(queue.add(async () => "second")).rejects.toMatchObject({ code: "queue_full" });
    await expect(running).resolves.toBe("first");
  });

  it("runs jobs in FIFO order", async () => {
    const queue = new SingleFlightQueue({ maxSize: 3, defaultTimeoutMs: 500 });
    const order: string[] = [];

    const first = queue.add(async () => {
      await sleep(30);
      order.push("first");
      return 1;
    });

    const second = queue.add(async () => {
      order.push("second");
      return 2;
    });

    await Promise.all([first, second]);
    expect(order).toEqual(["first", "second"]);
  });

  it("addIfIdle rejects immediate enqueue when a job is already running", async () => {
    const queue = new SingleFlightQueue({ maxSize: 3, defaultTimeoutMs: 500 });

    const first = queue.add(async () => {
      await sleep(50);
      return "first";
    });

    const second = queue.addIfIdle?.(async () => "second");
    expect(second).toBeNull();
    await expect(first).resolves.toBe("first");
  });

  it("times out long-running jobs", async () => {
    const queue = new SingleFlightQueue({ maxSize: 2, defaultTimeoutMs: 20 });

    await expect(
      queue.add(async () => {
        await sleep(100);
        return "late";
      }),
    ).rejects.toMatchObject({ code: "timeout" });
  });

  it("keeps single-flight semantics after timeout until long job ends", async () => {
    const queue = new SingleFlightQueue({ maxSize: 5, defaultTimeoutMs: 50 });
    const events: Array<{ name: string; t: number }> = [];
    const startedAt = Date.now();

    const longPromise = queue.add(
      async () => {
        events.push({ name: "long_start", t: Date.now() - startedAt });
        await sleep(200);
        events.push({ name: "long_end", t: Date.now() - startedAt });
        return "long";
      },
      50,
    );

    await expect(longPromise).rejects.toMatchObject({ code: "timeout" });

    const shortPromise = queue.add(async () => {
      events.push({ name: "short_start", t: Date.now() - startedAt });
      return "short";
    });

    await shortPromise;

    const longEnd = events.find((entry) => entry.name === "long_end");
    const shortStart = events.find((entry) => entry.name === "short_start");

    expect(longEnd).toBeDefined();
    expect(shortStart).toBeDefined();
    expect(shortStart!.t).toBeGreaterThanOrEqual(longEnd!.t);
  });

  it("times out caller quickly while queue stays occupied until real completion", async () => {
    const queue = new SingleFlightQueue({ maxSize: 5, defaultTimeoutMs: 50 });
    let releaseTask: (() => void) | undefined;
    const blocker = new Promise<void>((resolve) => {
      releaseTask = resolve;
    });

    const startedAt = Date.now();
    const timedPromise = queue.add(
      async () => {
        await blocker;
        return "done";
      },
      50,
    );

    const timeoutError = await timedPromise.catch((error) => error);
    const elapsedMs = Date.now() - startedAt;

    expect(timeoutError?.code).toBe("timeout");
    expect(elapsedMs).toBeGreaterThanOrEqual(35);
    expect(elapsedMs).toBeLessThan(200);
    expect(queue.getDepth()).toBe(1);

    releaseTask?.();
    await sleep(20);
    expect(queue.getDepth()).toBe(0);
  });

  it("emits late outcome callback when task resolves after timeout", async () => {
    const lateOutcomes: Array<{ outcome: string }> = [];
    const queue = new SingleFlightQueue({
      maxSize: 2,
      defaultTimeoutMs: 10,
      onLateOutcome: (event) => {
        lateOutcomes.push({ outcome: event.outcome });
      },
    });

    await expect(
      queue.add(async () => {
        await sleep(40);
        return "late-success";
      }, 10),
    ).rejects.toMatchObject({ code: "timeout" });

    await sleep(50);
    expect(lateOutcomes).toEqual([{ outcome: "resolved" }]);
  });
});
