import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { randomUUID } from 'node:crypto';
import type { Logger } from '../lib/logger.js';
import { sanitizePath } from './security.js';

/** Header carrying the request id back to the caller for correlation. */
export const REQUEST_ID_HEADER = 'x-request-id';

export interface RequestLoggingOptions {
  /** Skip noisy endpoints from the completed/failed logs (health checks). */
  skipPaths?: readonly string[];
}

interface TimedRequest extends Request {
  __qdRequestId?: string;
  __qdStartedAt?: number;
  __qdLogged?: boolean;
}

/**
 * Logging middleware for every request and response.
 *
 * Emits one `http request started` (debug) on entry and exactly one terminal
 * log on `finish`: `http request completed` (info for <400, warn for 4xx,
 * error for 5xx). Fields are privacy-safe: paths sanitized (share keys
 * collapsed), no headers/cookies/bodies logged — only method, path,
 * status, duration, sizes, and a random request id echoed back via
 * `x-request-id`.
 */
export function requestLogging(
  logger: Logger,
  options: RequestLoggingOptions = {},
): RequestHandler {
  const skip = new Set(options.skipPaths ?? ['/api/health']);
  logger.debug('request logging middleware initialized', {
    skippedPaths: [...skip],
  });

  return (req: Request, res: Response, next: NextFunction): void => {
    const timed = req as TimedRequest;
    const requestId = randomUUID();
    timed.__qdRequestId = requestId;
    timed.__qdStartedAt = Date.now();
    timed.__qdLogged = false;
    res.setHeader(REQUEST_ID_HEADER, requestId);

    const path = sanitizePath(req.originalUrl);
    logger.debug('http request started', { requestId, method: req.method, path });

    const logOnce = (failed: boolean, error?: unknown): void => {
      if (timed.__qdLogged) return;
      timed.__qdLogged = true;
      const durationMs = Date.now() - (timed.__qdStartedAt ?? Date.now());
      const status = res.statusCode;
      const fields = {
        requestId,
        method: req.method,
        path,
        status,
        durationMs,
        contentLength: res.getHeader('content-length') ?? null,
      };
      if (failed) {
        logger.error('http request failed', { ...fields, error });
        return;
      }
      if (skip.has(path) && status < 400) {
        logger.debug('http request completed', fields);
        return;
      }
      if (status >= 500) logger.error('http request completed', fields);
      else if (status >= 400) logger.warn('http request completed', fields);
      else logger.info('http request completed', fields);
    };

    res.on('finish', () => logOnce(false));
    res.on('close', () => {
      // Client disconnected before finish (aborted download/upload).
      if (!res.writableEnded) logOnce(true, new Error('connection closed prematurely'));
    });
    res.on('error', (error: unknown) => logOnce(true, error));

    next();
  };
}

/** Request id assigned by {@link requestLogging} (undefined outside HTTP). */
export function requestIdOf(req: Request): string | undefined {
  return (req as TimedRequest).__qdRequestId;
}
