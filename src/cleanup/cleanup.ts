import type { Logger } from '../lib/logger.js';
import type { TransferRepository } from '../transfers/repository.js';
import type { FileStorage } from '../storage/file-storage.js';

/** Transfer dirs without a row younger than this are kept (grace window). */
const ORPHAN_GRACE_MS = 60_000;
/** Non-active staging entries younger than this are kept as a safety net. */
const STAGING_GRACE_MS = 60_000;
/** Runtime claims younger than this are assumed to be a live stream. */
const STALE_CLAIM_GRACE_MS = 30_000;

export interface CleanupDeps {
  repository: TransferRepository;
  storage: FileStorage;
  logger: Logger;
  /** Service-owned ids streaming right now — cleanup never touches these. */
  activeDownloads: ReadonlySet<string>;
  intervalMs: number;
}

export interface SweepStats {
  expired: number;
  staleClaims: number;
  orphanDirs: number;
  staleStagingDirs: number;
  rowsMissingDirs: number;
  total: number;
}

export interface SweepOptions {
  /** Startup: no streams exist yet, so release every lingering claim. */
  releaseAllClaims?: boolean;
}

/**
 * Reconciles database and filesystem state:
 *
 *  - expired transfers → row + directory deleted
 *  - stale `downloading` claims → released back to `ready` (skipped if the
 *    id is in the service's active-download set)
 *  - orphan transfer directories (no row) → deleted after a grace window
 *  - stale staging directories (not owned by this process) → deleted
 *  - rows whose file-backed directory disappeared → row deleted
 *
 * Runs at startup (`start()` releases lingering claims from a crashed
 * predecessor) and on a configurable interval afterwards.
 */
export class TransferCleanup {
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: CleanupDeps) {}

  sweep(now = Date.now(), options: SweepOptions = {}): SweepStats {
    const { activeDownloads, repository, storage } = this.deps;
    const stats: SweepStats = {
      expired: 0,
      staleClaims: 0,
      orphanDirs: 0,
      staleStagingDirs: 0,
      rowsMissingDirs: 0,
      total: 0,
    };

    for (const transfer of repository.listExpired(now)) {
      repository.delete(transfer.id);
      storage.removeDir(storage.transferDir(transfer.id));
      stats.expired += 1;
    }

    const cutoff = options.releaseAllClaims === true ? null : now - STALE_CLAIM_GRACE_MS;
    for (const transfer of repository.listStaleClaims(cutoff)) {
      if (activeDownloads.has(transfer.id)) continue; // live stream in this process
      repository.release(transfer.id);
      stats.staleClaims += 1;
    }

    // create() is synchronous in a single process, so a just-moved dir always
    // has its row by the next tick; the mtime grace covers crash mid-create.
    for (const entry of storage.listTransferEntries()) {
      if (repository.findById(entry.name) !== null) continue;
      if (now - entry.mtimeMs < ORPHAN_GRACE_MS) continue;
      storage.removeDir(entry.path);
      stats.orphanDirs += 1;
    }

    // Entries absent from this process's staging set are crash leftovers.
    for (const entry of storage.listStaleStagingEntries()) {
      if (now - entry.mtimeMs < STAGING_GRACE_MS) continue;
      storage.removeDir(entry.path);
      stats.staleStagingDirs += 1;
    }

    for (const transfer of repository.listAllWithFileCounts()) {
      if (transfer.fileCount === 0) continue; // text-only transfers have no dir
      if (storage.exists(storage.transferDir(transfer.id))) continue;
      repository.delete(transfer.id);
      stats.rowsMissingDirs += 1;
    }

    stats.total =
      stats.expired +
      stats.staleClaims +
      stats.orphanDirs +
      stats.staleStagingDirs +
      stats.rowsMissingDirs;
    if (stats.total > 0) this.deps.logger.info('cleanup sweep', { ...stats });
    return stats;
  }

  /** Startup sweep (releasing lingering claims) followed by the interval sweep. */
  start(now = Date.now()): void {
    this.sweep(now, { releaseAllClaims: true });
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      try {
        this.sweep();
      } catch (error) {
        this.deps.logger.error('cleanup sweep failed', { error });
      }
    }, this.deps.intervalMs);
    this.timer.unref(); // never keeps the process alive on its own
  }

  stop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }
}
