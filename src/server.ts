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

  const db = openDatabase(config.databasePath, logger);
  const repository = new TransferRepository(db);
  const storage = new FileStorage(config.storagePath);
  storage.init();

  const service = new TransferService({ db, repository, storage, logger, config });
  const cleanup = new TransferCleanup({
    repository,
    storage,
    logger,
    activeDownloads: service.activeDownloadIds,
    intervalMs: config.cleanupIntervalMs,
  });

  const app = createApp({ config, logger, service, storage });

  // Startup sweep first: releases claims left by a crashed predecessor.
  cleanup.start();

  const server = app.listen(config.port, config.host);
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
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('shutting down', { signal });
    cleanup.stop();
    server.close(() => {
      db.close();
      process.exit(0);
    });
    server.closeIdleConnections(); // keep-alive sockets must not delay exit
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

startServer();
