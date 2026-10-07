import { Router } from 'express';
import type { Config } from '../config/env.js';
import { createRateLimiter } from '../middleware/rate-limit.js';
import type { FileStorage } from '../storage/file-storage.js';
import { createTransferController } from './controller.js';
import type { TransferService } from './service.js';

export interface TransfersRouterDeps {
  config: Config;
  service: TransferService;
  storage: FileStorage;
}

/**
 * Transfer API routes, all behind the per-IP rate limiter (health checks
 * live outside this router and are never limited).
 *
 *   POST   /api/transfers              create (multipart: files[] + text)
 *   GET    /api/transfers/:key         metadata (non-consuming)
 *   GET    /api/transfers/:key/download claim + stream (consumes)
 *   DELETE /api/transfers/:key         cancel before download
 */
export function createTransfersRouter(deps: TransfersRouterDeps): Router {
  const { config } = deps;
  const controller = createTransferController(deps);
  const limiter = createRateLimiter({
    windowMs: config.rateLimitWindowMs,
    max: config.rateLimitMaxRequests,
  });

  const router = Router();
  router.post('/', limiter, controller.upload, controller.create);
  router.get('/:key/download', limiter, controller.download);
  router.get('/:key', limiter, controller.metadata);
  router.delete('/:key', limiter, controller.cancel);
  return router;
}
