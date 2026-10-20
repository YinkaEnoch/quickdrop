import ejs from 'ejs';
import express, { type Express } from 'express';
import type { Config } from './config/env.js';
import { packageVersion, publicDir, viewsDir } from './config/paths.js';
import { AppError } from './lib/errors.js';
import type { Logger } from './lib/logger.js';
import { errorHandler } from './middleware/error-handler.js';
import { requestLogging } from './middleware/request-logging.js';
import { sanitizePath, securityHeaders } from './middleware/security.js';
import type { FileStorage } from './storage/file-storage.js';
import type { TransferService } from './transfers/service.js';
import { createTransfersRouter } from './transfers/routes.js';

export interface AppDeps {
  config: Config;
  logger: Logger;
  service: TransferService;
  storage: FileStorage;
}

/**
 * Express app factory — no side effects, no listening socket, so tests can
 * mount it on port 0. Order: security headers → request logging → static →
 * health → index → transfer API → 404 → error boundary.
 */
export function createApp(deps: AppDeps): Express {
  const { config, logger, service, storage } = deps;
  logger.debug('app creating');
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);
  app.set('views', viewsDir);
  app.set('view engine', 'ejs');
  // ejs@7: default import; renderFile matches Express's engine signature.
  app.engine('ejs', ejs.renderFile);

  app.use(securityHeaders());
  app.use(requestLogging(logger));
  app.use('/public', express.static(publicDir, { index: false }));

  app.use((req, _res, next) => {
    logger.debug('request received', {
      method: req.method,
      path: sanitizePath(req.originalUrl),
    });
    next();
  });

  app.get('/api/health', (_req, res) => {
    logger.debug('health check');
    res.json({ status: 'ok', version: packageVersion() });
  });

  app.get('/', (_req, res) => {
    logger.debug('index page requested');
    res.render('index', {
      limits: {
        maxFileSizeMb: Math.floor(config.maxFileSizeBytes / (1024 * 1024)),
        maxFiles: config.maxFilesPerTransfer,
        maxTextKb: Math.floor(config.maxTextLengthBytes / 1024),
        expirationMinutes: config.transferExpirationMinutes,
      },
    });
  });

  app.use('/api/transfers', createTransfersRouter({ config, service, storage, logger }));

  app.use((req, _res, next) => {
    logger.debug('route not found', { method: req.method, path: sanitizePath(req.originalUrl) });
    next(new AppError(404, 'Not found.'));
  });

  app.use(errorHandler(logger));
  logger.debug('app created');
  return app;
}
