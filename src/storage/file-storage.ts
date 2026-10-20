import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import type { Logger } from '../lib/logger.js';
import { noopLogger } from '../lib/logger.js';

export interface EntryInfo {
  name: string;
  path: string;
  isDirectory: boolean;
  mtimeMs: number;
}

/**
 * Owns every filesystem interaction for transfers.
 *
 * Layout:
 *   <storage>/transfers/<transfer-id>/01-file, 02-file, ...  (final, DB-backed)
 *   <storage>/tmp/<staging-id>/01-file, ...                  (in-flight only)
 *
 * Uploaded content is never placed under a user-provided name; stored file
 * names are generated (`NN-file`) and original names live only in SQLite.
 * All deletes are idempotent (safe to run more than once).
 */
export class FileStorage {
  readonly transfersDir: string;
  readonly stagingDir: string;

  /** Staging dirs created by this live process — never treated as stale. */
  private readonly activeStagingDirs = new Set<string>();

  constructor(
    storagePath: string,
    private readonly logger: Logger = noopLogger,
  ) {
    this.transfersDir = path.join(storagePath, 'transfers');
    this.stagingDir = path.join(storagePath, 'tmp');
  }

  init(): void {
    this.logger.debug('storage initializing');
    mkdirSync(this.transfersDir, { recursive: true });
    mkdirSync(this.stagingDir, { recursive: true });
    this.logger.debug('storage initialized');
  }

  createStagingDir(): string {
    const dir = path.join(this.stagingDir, randomUUID());
    mkdirSync(dir, { recursive: false });
    this.activeStagingDirs.add(dir);
    this.logger.debug('staging dir created');
    return dir;
  }

  transferDir(transferId: string): string {
    return path.join(this.transfersDir, transferId);
  }

  /** Join a stored file name onto a directory, refusing anything path-like. */
  fileIn(dir: string, storedName: string): string {
    if (storedName.includes('/') || storedName.includes('\\') || storedName.includes('..')) {
      throw new Error('Invalid stored file name');
    }
    return path.join(dir, storedName);
  }

  moveStagingToFinal(stagingPath: string, finalPath: string): void {
    this.logger.debug('storage moving staging to final');
    renameSync(stagingPath, finalPath);
    this.activeStagingDirs.delete(stagingPath);
    this.logger.debug('storage move complete');
  }

  /** Rename a single file; used to give staged uploads their `NN-file` names. */
  renameFile(fromPath: string, toPath: string): void {
    this.logger.debug('storage renaming file');
    renameSync(fromPath, toPath);
  }

  removeDir(dir: string): void {
    this.logger.debug('storage removing dir');
    rmSync(dir, { recursive: true, force: true });
    this.activeStagingDirs.delete(dir);
  }

  exists(target: string): boolean {
    try {
      statSync(target);
      return true;
    } catch {
      return false;
    }
  }

  listTransferEntries(): EntryInfo[] {
    return this.listEntries(this.transfersDir);
  }

  /** Staging entries not owned by this process (crash leftovers). */
  listStaleStagingEntries(): EntryInfo[] {
    return this.listEntries(this.stagingDir).filter((entry) => !this.activeStagingDirs.has(entry.path));
  }

  private listEntries(dir: string): EntryInfo[] {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return [];
    }
    const entries: EntryInfo[] = [];
    for (const name of names) {
      const full = path.join(dir, name);
      try {
        const stats = statSync(full);
        entries.push({ name, path: full, isDirectory: stats.isDirectory(), mtimeMs: stats.mtimeMs });
      } catch {
        // Entry vanished mid-listing — nothing to report.
      }
    }
    return entries;
  }
}
