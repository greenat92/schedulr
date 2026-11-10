import type { Request, RequestHandler } from "express";

export interface RateLimitOptions {
  windowMs: number;
  max: number;
  /** Bucket key; defaults to the client IP. */
  key?: (req: Request) => string;
  /** Return true to bypass the limiter (e.g. health checks). */
  skip?: (req: Request) => boolean;
  /** Above this many buckets, expired entries are swept. */
  sweepThreshold?: number;
}

interface Bucket {
  count: number;
  resetAt: number;
}

/**
 * Fixed-window, in-memory rate limiter. Deliberately simple: it protects a
 * single process from abuse. A horizontally-scaled deployment would move this
 * to a shared store (e.g. Redis) - noted in the roadmap.
 */
export function createRateLimiter(options: RateLimitOptions): RequestHandler {
  const buckets = new Map<string, Bucket>();
  const keyOf = options.key ?? ((req: Request) => req.ip ?? "unknown");
  const skip = options.skip ?? (() => false);
  const sweepThreshold = options.sweepThreshold ?? 10_000;

  return (req, res, next) => {
    if (skip(req)) {
      return next();
    }

    const now = Date.now();
    const key = keyOf(req);
    let bucket = buckets.get(key);

    if (bucket === undefined || now >= bucket.resetAt) {
      bucket = { count: 0, resetAt: now + options.windowMs };
      buckets.set(key, bucket);
    }

    bucket.count += 1;
    if (bucket.count > options.max) {
      res.setHeader("Retry-After", String(Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))));
      return res.status(429).json({ error: "rate limit exceeded" });
    }

    if (buckets.size > sweepThreshold) {
      for (const [candidateKey, candidate] of buckets) {
        if (now >= candidate.resetAt) buckets.delete(candidateKey);
      }
    }

    return next();
  };
}
