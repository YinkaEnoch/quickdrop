import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Logger } from '../lib/logger.js';
import { migrations } from './migrations.js';

export interface Database {
  readonly raw: DatabaseSync;
  /**
   * Run `fn` inside BEGIN IMMEDIATE / COMMIT, rolling back on throw.
   * Nested calls join the outer transaction (node:sqlite is synchronous, so
   * no interleaving can occur mid-transaction in a single process).
   */
  transaction<T>(fn: () => T): T;
  close(): void;
}

export function openDatabase(databasePath: string, logger: Logger): Database {
  logger.debug('database opening', { databasePath });
  if (databasePath !== ':memory:') {
    mkdirSync(path.dirname(databasePath), { recursive: true });
  }

  const raw = new DatabaseSync(databasePath);
  raw.exec('PRAGMA journal_mode = WAL');
  raw.exec('PRAGMA foreign_keys = ON');
  raw.exec('PRAGMA busy_timeout = 5000');
  raw.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    )
  `);

  let transactionDepth = 0;
  const transaction = <T>(fn: () => T): T => {
    if (transactionDepth > 0) return fn();
    transactionDepth += 1;
    logger.debug('database transaction started');
    raw.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      raw.exec('COMMIT');
      logger.debug('database transaction committed');
      return result;
    } catch (error) {
      logger.warn('database transaction rolled back', { error });
      try {
        raw.exec('ROLLBACK');
      } catch {
        // Rollback failure must not mask the original error.
      }
      throw error;
    } finally {
      transactionDepth -= 1;
    }
  };

  const applied = new Set(
    (raw.prepare('SELECT id FROM schema_migrations').all() as unknown as Array<{ id: string }>).map(
      (row) => row.id,
    ),
  );

  for (const migration of migrations) {
    if (applied.has(migration.id)) continue;
    logger.debug('database migration applying', { migration: migration.id });
    transaction(() => {
      raw.exec(migration.sql);
      raw
        .prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)')
        .run(migration.id, Date.now());
    });
    logger.info('database migration applied', { migration: migration.id });
  }

  logger.debug('database opened', { databasePath, pendingMigrations: 0 });

  return {
    raw,
    transaction,
    close: () => {
      logger.debug('database closing');
      try {
        raw.close();
        logger.debug('database closed');
      } catch {
        // Already closed — close must be idempotent.
      }
    },
  };
}
