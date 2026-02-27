export interface RateLimitDecision {
  allowed: boolean;
  retryAfterSec: number;
  remainingTokens: number;
}

export interface RateLimiter {
  consume(tokens?: number): RateLimitDecision;
}

export interface TokenBucketOptions {
  rpm: number;
  burst: number;
  now?: () => number;
}

export class TokenBucketRateLimiter implements RateLimiter {
  private readonly capacity: number;
  private readonly refillPerSecond: number;
  private readonly now: () => number;
  private tokens: number;
  private lastRefill: number;

  public constructor(options: TokenBucketOptions) {
    this.capacity = options.burst;
    this.refillPerSecond = options.rpm / 60;
    this.now = options.now ?? (() => Date.now());
    this.tokens = this.capacity;
    this.lastRefill = this.now();
  }

  public consume(requestedTokens = 1): RateLimitDecision {
    this.refill();

    if (this.tokens >= requestedTokens) {
      this.tokens -= requestedTokens;
      return {
        allowed: true,
        retryAfterSec: 0,
        remainingTokens: this.tokens,
      };
    }

    const needed = requestedTokens - this.tokens;
    const retryAfterSec = this.refillPerSecond > 0 ? Math.max(1, Math.ceil(needed / this.refillPerSecond)) : 60;

    return {
      allowed: false,
      retryAfterSec,
      remainingTokens: this.tokens,
    };
  }

  private refill(): void {
    const now = this.now();
    const elapsedSeconds = Math.max(0, (now - this.lastRefill) / 1000);
    this.lastRefill = now;

    if (elapsedSeconds <= 0) {
      return;
    }

    this.tokens = Math.min(this.capacity, this.tokens + elapsedSeconds * this.refillPerSecond);
  }
}
