import type { NextFunction, Request, RequestHandler, Response } from 'express';

/**
 * Strict CSP: self-hosted assets only, no inline scripts or styles (the UI
 * ships external files), no framing, no referrer leakage.
 */
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "img-src 'self' data:",
  "style-src 'self'",
  "script-src 'self'",
].join('; ');

/** Security headers applied to every response. */
export function securityHeaders(): RequestHandler {
  return (_req: Request, res: Response, next: NextFunction): void => {
    res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  };
}

/**
 * Makes a request path safe to log: query strings are dropped and everything
 * below /api/transfers/ (share keys!) is collapsed to `***`.
 */
export function sanitizePath(rawPath: string): string {
  const pathOnly = rawPath.split('?')[0]?.split('#')[0] ?? '/';
  return pathOnly.replace(/^(\/api\/transfers\/).+$/i, '$1***');
}
