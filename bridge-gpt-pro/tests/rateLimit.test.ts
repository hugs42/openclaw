import { describe, expect, it } from "vitest";
import { TokenBucketRateLimiter } from "../src/utils/rateLimit.js";

describe("TokenBucketRateLimiter", () => {
  it("allows burst then rejects", () => {
    let nowMs = 0;
    const limiter = new TokenBucketRateLimiter({
      rpm: 60,
      burst: 2,
      now: () => nowMs,
    });

    expect(limiter.consume().allowed).toBe(true);
    expect(limiter.consume().allowed).toBe(true);

    const denied = limiter.consume();
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSec).toBeGreaterThan(0);

    nowMs += 1000;
    expect(limiter.consume().allowed).toBe(true);
  });
});
