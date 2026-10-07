import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { tooManyRequests } from '../lib/errors.js';

export interface RateLimiterOptions {
  windowMs: number;
  max: number;
}

interface Window {
  count: number;
  resetAt: number;
}

/** Safety valve: beyond this many tracked IPs, expired windows are evicted. */
const MAX_TRACKED_IPS = 10_000;

/**
 * Fixed-window counter per client IP. Config-driven; rejects with 429 +
 * Retry-After and drains any unread request body so the connection does not
 * stall. Health checks and static assets are not wired through this.
 */
export function createRateLimiter(options: RateLimiterOptions): RequestHandler {
  const { windowMs, max } = options;
  const windows = new Map<string, Window>();

  return (req: Request, res: Response, next: NextFunction): void => {
    const now = Date.now();

    if (windows.size >= MAX_TRACKED_IPS) {
      for (const [ip, window] of windows) {
        if (now >= window.resetAt) windows.delete(ip);
      }
      // Still full of live windows: reset rather than grow unbounded.
      if (windows.size >= MAX_TRACKED_IPS) windows.clear();
    }

    const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';
    let window = windows.get(ip);
    if (window === undefined || now >= window.resetAt) {
      window = { count: 0, resetAt: now + windowMs };
      windows.set(ip, window);
    }
    window.count += 1;

    if (window.count > max) {
      const retryAfter = Math.max(1, Math.ceil((window.resetAt - now) / 1000));
      res.setHeader('Retry-After', String(retryAfter));
      req.resume(); // drain an unread body before rejecting (POST uploads)
      next(tooManyRequests());
      return;
    }
    next();
  };
}
