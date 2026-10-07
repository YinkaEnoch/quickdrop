/**
 * Framework-neutral application error. Anything that is an AppError is safe
 * to show its `userMessage` to the client; everything else must surface as a
 * generic 500 (see middleware/error-handler).
 */
export class AppError extends Error {
  readonly status: number;
  readonly userMessage: string;

  constructor(status: number, userMessage: string, options?: { cause?: unknown }) {
    super(userMessage, options);
    this.name = 'AppError';
    this.status = status;
    this.userMessage = userMessage;
  }
}

export function badRequest(message: string): AppError {
  return new AppError(400, message);
}

/** One generic message for unknown, malformed, and expired keys (no enumeration). */
export function transferNotFound(): AppError {
  return new AppError(404, 'Transfer not found or expired.');
}

export function transferBusy(): AppError {
  return new AppError(409, 'This transfer is currently being downloaded.');
}

export function payloadTooLarge(message: string): AppError {
  return new AppError(413, message);
}

export function tooManyRequests(): AppError {
  return new AppError(429, 'Too many requests. Please try again later.');
}

export function internalError(cause?: unknown): AppError {
  return new AppError(500, 'The transfer could not be completed. Please try again.', { cause });
}
