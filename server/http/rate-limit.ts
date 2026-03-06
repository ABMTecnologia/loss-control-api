import type { RequestHandler } from "express";
import { ApiError } from "./errors";

type RateLimitOptions = {
  windowMs: number;
  max: number;
};

type Bucket = {
  hits: number[];
};

export function createRateLimitMiddleware(options: RateLimitOptions): RequestHandler {
  const buckets = new Map<string, Bucket>();

  return (req, res, next) => {
    const now = Date.now();
    const key = req.ip || req.socket.remoteAddress || "unknown";
    const bucket = buckets.get(key) ?? { hits: [] };

    bucket.hits = bucket.hits.filter((ts) => now - ts < options.windowMs);
    if (bucket.hits.length >= options.max) {
      const oldest = bucket.hits[0];
      const retryAfterMs = Math.max(options.windowMs - (now - oldest), 0);
      const retryAfterSec = Math.ceil(retryAfterMs / 1000);
      res.setHeader("Retry-After", String(retryAfterSec));
      return next(new ApiError(429, "TOO_MANY_REQUESTS", "Too many requests"));
    }

    bucket.hits.push(now);
    buckets.set(key, bucket);
    next();
  };
}
