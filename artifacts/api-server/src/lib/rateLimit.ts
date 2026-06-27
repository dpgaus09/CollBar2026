import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import type { Request, Response } from "express";

// ---------------------------------------------------------------------------
// Shared rate-limit helpers.
//
// Every limiter keys clients the IPv6-safe way: prefer the authenticated
// session user id, otherwise fall back to express-rate-limit's ipKeyGenerator
// (which normalizes IPv6 addresses to a /64 so a single client can't trivially
// rotate through addresses in its subnet). Using ipKeyGenerator also avoids the
// express-rate-limit ValidationError that fires when a custom keyGenerator
// touches req.ip directly.
// ---------------------------------------------------------------------------

function clientKey(req: Request): string {
  return req.session?.userId != null
    ? String(req.session.userId)
    : ipKeyGenerator(req.ip ?? "");
}

interface LimiterOptions {
  windowMs: number;
  limit: number;
  message: string;
  /** Only count failed (4xx/5xx) responses against the limit. */
  skipSuccessfulRequests?: boolean;
}

export function createRateLimiter({
  windowMs,
  limit,
  message,
  skipSuccessfulRequests = false,
}: LimiterOptions) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests,
    keyGenerator: clientKey,
    handler: (_req: Request, res: Response) => {
      res.status(429).json({ error: message });
    },
  });
}

// Login: tight window, and only failed attempts count toward the limit so a
// legitimate user who signs in correctly is never throttled. Brute-force
// guessing (which produces 401s) trips it quickly. This complements the
// existing per-IP / per-account lockout logic in routes/auth.ts.
export const loginLimiter = createRateLimiter({
  windowMs: 15 * 60_000,
  limit: 10,
  skipSuccessfulRequests: true,
  message: "Too many login attempts. Please wait a few minutes and try again.",
});

// Expensive admin operations: extraction triggers, crawls, syncs, uploads,
// bulk imports. These each spawn heavy work (Claude Vision, child processes,
// object-storage writes), so cap how often they can be fired per client.
export const heavyAdminLimiter = createRateLimiter({
  windowMs: 60_000,
  limit: 20,
  message: "Too many requests in a short time. Please wait a moment and try again.",
});
