import { Router } from 'express';
import type { Config } from '../config/env.js';
import type { Logger } from '../lib/logger.js';
import { noopLogger } from '../lib/logger.js';
import { createRateLimiter } from '../middleware/rate-limit.js';
import type { FileStorage } from '../storage/file-storage.js';
import { createTransferController } from './controller.js';
import type { TransferService } from './service.js';

export interface TransfersRouterDeps {
  config: Config;
  service: TransferService;
  storage: FileStorage;
  logger?: Logger;
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
  const { config, service, storage } = deps;
  const logger = deps.logger ?? noopLogger;
  logger.debug('transfers router initializing');
  const controller = createTransferController({ config, service, storage, logger });
  const limiter = createRateLimiter(
    {
      windowMs: config.rateLimitWindowMs,
      max: config.rateLimitMaxRequests,
    },
    logger,
  );

  const router = Router();
  router.post('/', limiter, controller.upload, controller.create);
  router.get('/:key/download', limiter, controller.download);
  router.get('/:key', limiter, controller.metadata);
  router.delete('/:key', limiter, controller.cancel);
  logger.debug('transfers router initialized');
  return router;
}
