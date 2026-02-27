import { BridgeError, toBridgeError } from "../errors.js";

interface QueueJob<T> {
  task: () => Promise<T>;
  timeoutMs: number;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

export interface LateOutcomeEvent {
  outcome: "resolved" | "rejected";
  timeoutMs: number;
  durationMs: number;
  errorCode?: string;
}

export interface QueueLike {
  add<T>(task: () => Promise<T>, timeoutMs?: number): Promise<T>;
  addIfIdle?<T>(task: () => Promise<T>, timeoutMs?: number): Promise<T> | null;
  getDepth(): number;
}

export interface SingleFlightQueueOptions {
  maxSize: number;
  defaultTimeoutMs: number;
  onLateOutcome?: (event: LateOutcomeEvent) => void;
}

export class SingleFlightQueue implements QueueLike {
  private readonly maxSize: number;
  private readonly defaultTimeoutMs: number;
  private readonly onLateOutcome?: (event: LateOutcomeEvent) => void;
  private readonly queue: Array<QueueJob<any>> = [];
  private running = false;

  public constructor(options: SingleFlightQueueOptions) {
    this.maxSize = options.maxSize;
    this.defaultTimeoutMs = options.defaultTimeoutMs;
    this.onLateOutcome = options.onLateOutcome;
  }

  public getDepth(): number {
    return this.queue.length + (this.running ? 1 : 0);
  }

  public async add<T>(task: () => Promise<T>, timeoutMs = this.defaultTimeoutMs): Promise<T> {
    return this.enqueue(task, timeoutMs);
  }

  public addIfIdle<T>(task: () => Promise<T>, timeoutMs = this.defaultTimeoutMs): Promise<T> | null {
    if (this.running || this.queue.length > 0) {
      return null;
    }

    return this.enqueue(task, timeoutMs);
  }

  private enqueue<T>(task: () => Promise<T>, timeoutMs: number): Promise<T> {
    if (this.getDepth() >= this.maxSize) {
      throw new BridgeError("queue_full", "Queue is full", { maxSize: this.maxSize }, 10);
    }

    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        task,
        timeoutMs,
        resolve,
        reject,
      });
      this.drain();
    });
  }

  private drain(): void {
    if (this.running) {
      return;
    }

    const job = this.queue.shift();
    if (!job) {
      return;
    }

    this.running = true;

    this.execute(job)
      .catch(() => {
        // Errors are already routed to the job promise.
      })
      .finally(() => {
        this.running = false;
        this.drain();
      });
  }

  private async execute<T>(job: QueueJob<T>): Promise<void> {
    const startedAt = Date.now();
    let settled = false;
    let timedOut = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

    try {
      timeoutHandle = setTimeout(() => {
        timedOut = true;

        if (settled) {
          return;
        }

        settled = true;
        job.reject(new BridgeError("timeout", "Job timed out", { timeoutMs: job.timeoutMs }));
      }, job.timeoutMs);

      const value = await Promise.resolve().then(job.task);

      if (!settled) {
        settled = true;
        job.resolve(value as T);
        return;
      }

      if (timedOut) {
        this.reportLateOutcome({
          outcome: "resolved",
          timeoutMs: job.timeoutMs,
          durationMs: Date.now() - startedAt,
        });
      }
    } catch (error) {
      const bridgeError = toBridgeError(error);

      if (!settled) {
        settled = true;
        job.reject(bridgeError);
        return;
      }

      if (timedOut) {
        this.reportLateOutcome({
          outcome: "rejected",
          timeoutMs: job.timeoutMs,
          durationMs: Date.now() - startedAt,
          errorCode: bridgeError.code,
        });
      }
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
  }

  private reportLateOutcome(event: LateOutcomeEvent): void {
    if (!this.onLateOutcome) {
      return;
    }

    try {
      this.onLateOutcome(event);
    } catch {
      // Keep queue execution isolated from observer errors.
    }
  }
}
