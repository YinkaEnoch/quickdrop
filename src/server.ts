import { loadConfig } from './config/env.js';
import { openDatabase } from './db/database.js';
import { createLogger } from './lib/logger.js';
import { FileStorage } from './storage/file-storage.js';
import { TransferCleanup } from './cleanup/cleanup.js';
import { TransferRepository } from './transfers/repository.js';
import { TransferService } from './transfers/service.js';
import { createApp } from './app.js';

/**
 * Production entry point: config → db → storage → service → cleanup →
 * app → startup sweep → listen, with graceful shutdown on SIGINT/SIGTERM
 * (drain connections, then close the database; force-exit after 10s).
 */
export function startServer(): void {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  logger.debug('server boot started');

  const db = openDatabase(config.databasePath, logger);
  logger.debug('server database ready');
  const repository = new TransferRepository(db, logger);
  const storage = new FileStorage(config.storagePath, logger);
  storage.init();
  logger.debug('server storage ready');

  const service = new TransferService({ db, repository, storage, logger, config });
  logger.debug('server service ready');
  const cleanup = new TransferCleanup({
    repository,
    storage,
    logger,
    activeDownloads: service.activeDownloadIds,
    intervalMs: config.cleanupIntervalMs,
  });
  logger.debug('server cleanup ready');

  const app = createApp({ config, logger, service, storage });
  logger.debug('server app ready');

  // Startup sweep first: releases claims left by a crashed predecessor.
  cleanup.start();
  logger.debug('server startup sweep done');

  const server = app.listen(config.port, config.host);
  logger.debug('server listening socket opening', { host: config.host, port: config.port });
  server.on('listening', () => {
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : config.port;
    logger.info('server listening', { host: config.host, port });
  });
  server.on('error', (error) => {
    logger.error('server failed to start', { error });
    process.exit(1);
  });

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) {
      logger.debug('shutdown already in progress, ignoring signal', { signal });
      return;
    }
    shuttingDown = true;
    logger.info('shutting down', { signal });
    cleanup.stop();
    logger.debug('server connections draining');
    server.close(() => {
      logger.debug('server connections drained, closing database');
      db.close();
      logger.info('server stopped', { signal });
      process.exit(0);
    });
    server.closeIdleConnections(); // keep-alive sockets must not delay exit
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

startServer();
