import type { ErrorRequestHandler } from 'express';
import { AppError } from '../lib/errors.js';
import type { Logger } from '../lib/logger.js';
import { sanitizePath } from './security.js';

/** Same wording as internalError() — nothing about the failure leaks. */
const GENERIC_MESSAGE = 'The transfer could not be completed. Please try again.';

/**
 * Final error boundary: AppError → its userMessage as JSON; anything else →
 * a generic 500 with the details logged server-side only. Paths are
 * sanitized so share keys never reach the logs.
 */
export function errorHandler(logger: Logger): ErrorRequestHandler {
  return (error, req, res, next): void => {
    if (res.headersSent) {
      // Mid-stream failure: let Express tear the connection down; the
      // controller's close handler has already released the claim.
      next(error);
      return;
    }

    const fields = { method: req.method, path: sanitizePath(req.path) };
    if (error instanceof AppError) {
      logger.warn('request rejected', { ...fields, status: error.status });
      res.status(error.status).json({ error: error.userMessage });
      return;
    }

    logger.error('unhandled error', { ...fields, error });
    res.status(500).json({ error: GENERIC_MESSAGE });
  };
}
