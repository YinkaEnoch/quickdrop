import { randomUUID } from 'node:crypto';
import type { Config } from '../config/env.js';
import type { Database } from '../db/database.js';
import {
  badRequest,
  internalError,
  payloadTooLarge,
  transferBusy,
  transferNotFound,
} from '../lib/errors.js';
import { generateShareKey, normalizeShareKey } from '../lib/keys.js';
import type { Logger } from '../lib/logger.js';
import type { FileStorage } from '../storage/file-storage.js';
import type { TransferRepository } from './repository.js';
import type {
  CreateTransferInput,
  DownloadPlan,
  TransferBundle,
  TransferFileRecord,
  TransferRecord,
} from './transfer.types.js';

/**
 * Insert attempts before giving up on finding an unused 40-bit key.
 * A collision probability of ~1/8.5e11 per draw makes exhaustion
 * astronomically unlikely; 5 attempts keep the retry bounded regardless.
 */
const KEY_INSERT_ATTEMPTS = 5;

type ServiceConfig = Pick<
  Config,
  'maxFilesPerTransfer' | 'maxTextLengthBytes' | 'maxFileSizeBytes' | 'transferExpirationMinutes'
>;

export interface TransferServiceDeps {
  db: Database;
  repository: TransferRepository;
  storage: FileStorage;
  logger: Logger;
  config: ServiceConfig;
}

function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { errcode?: number; message?: string };
  return candidate.errcode === 2067 || /UNIQUE/i.test(candidate.message ?? '');
}

/**
 * Transfer use cases — owns the state machine:
 *
 *   create → ready --claim--> downloading --finalize--> deleted
 *                     ^              |
 *                     +---release----+     cancel / expiry / cleanup → deleted
 *
 * Keys are normalized inside the service so malformed, unknown, and expired
 * keys all answer with the identical generic 404 (no key enumeration).
 */
export class TransferService {
  /** Ids this process is streaming right now; cleanup must never touch them. */
  private readonly activeDownloads = new Set<string>();

  constructor(private readonly deps: TransferServiceDeps) {}

  get activeDownloadIds(): ReadonlySet<string> {
    return this.activeDownloads;
  }

  /**
   * Validate → rename staged files to generated `NN-file` names → move the
   * staging dir into place → insert with key-collision retry. Any failure
   * after the move rolls the directory back; a failed insert rolls the rows
   * back via the transaction. Staging cleanup on validation failure is the
   * caller's responsibility (controller sweeps after every attempt).
   */
  create(input: CreateTransferInput, now = Date.now()): TransferBundle {
    const { db, logger, repository, storage, config } = this.deps;

    const textContent = input.text !== null && input.text.length > 0 ? input.text : null;
    const files = input.files;

    if (files.length === 0 && textContent === null) {
      throw badRequest('Add at least one file or some text to share.');
    }
    if (files.length > config.maxFilesPerTransfer) {
      throw badRequest(`A transfer can contain at most ${config.maxFilesPerTransfer} files.`);
    }
    if (textContent !== null && Buffer.byteLength(textContent) > config.maxTextLengthBytes) {
      throw payloadTooLarge(
        `Text exceeds the ${Math.floor(config.maxTextLengthBytes / 1024)} KB limit.`,
      );
    }
    for (const file of files) {
      if (file.size > config.maxFileSizeBytes) {
        throw payloadTooLarge('A file exceeds the size limit.');
      }
      // Rejects path-like staged names before anything is touched; a throw
      // here means the upload middleware handed us a bad name (server bug).
      storage.fileIn(input.stagingPath, file.stagedName);
    }
    if (new Set(files.map((file) => file.stagedName)).size !== files.length) {
      throw badRequest('The upload contained duplicate files.');
    }

    const transferId = randomUUID();
    const finalDir = storage.transferDir(transferId);

    try {
      const tempNames: Array<{ tempName: string; record: TransferFileRecord }> = [];
      if (files.length > 0) {
        // Two-pass rename: everything first moves to a fresh uuid temp name,
        // then to its final `NN-file` name. Pass two is then collision-free
        // no matter what the upload middleware originally called the files.
        for (let index = 0; index < files.length; index += 1) {
          const file = files[index];
          if (file === undefined) continue;
          const tempName = `staging-${randomUUID()}`;
          storage.renameFile(
            storage.fileIn(input.stagingPath, file.stagedName),
            storage.fileIn(input.stagingPath, tempName),
          );
          tempNames.push({
            tempName,
            record: {
              id: randomUUID(),
              transferId,
              originalName: file.originalName,
              storedName: `${String(index + 1).padStart(2, '0')}-file`,
              mimeType: file.mimeType,
              size: file.size,
            },
          });
        }
        for (const { tempName, record } of tempNames) {
          storage.renameFile(
            storage.fileIn(input.stagingPath, tempName),
            storage.fileIn(input.stagingPath, record.storedName),
          );
        }
        storage.moveStagingToFinal(input.stagingPath, finalDir);
      }

      const transfer: TransferRecord = {
        id: transferId,
        shareKey: '',
        textContent,
        status: 'ready',
        createdAt: now,
        expiresAt: now + config.transferExpirationMinutes * 60_000,
        claimStartedAt: null,
      };
      const fileRecords = tempNames.map((entry) => entry.record);

      db.transaction(() => {
        for (let attempt = 0; attempt < KEY_INSERT_ATTEMPTS; attempt += 1) {
          transfer.shareKey = generateShareKey();
          try {
            repository.insert(transfer, fileRecords);
            return;
          } catch (error) {
            if (!isUniqueViolation(error) || attempt === KEY_INSERT_ATTEMPTS - 1) throw error;
            // Share-key collision: regenerate and retry inside the same
            // transaction (the failed statement rolled itself back only).
          }
        }
        throw internalError();
      });

      logger.info('transfer created', {
        transferId,
        fileCount: fileRecords.length,
        hasText: textContent !== null,
        totalBytes: fileRecords.reduce((sum, file) => sum + file.size, 0),
      });
      return { transfer, files: fileRecords };
    } catch (error) {
      // Rollback: never leave an orphan directory behind. Idempotent, and a
      // no-op when the move never happened (staging is swept by the caller).
      storage.removeDir(finalDir);
      throw error;
    }
  }

  /** Non-consuming lookup for the metadata endpoint; expired rows are deleted lazily. */
  get(rawKey: string, now = Date.now()): TransferBundle {
    const shareKey = normalizeShareKey(rawKey);
    const transfer = shareKey === null ? null : this.deps.repository.findByKey(shareKey);
    if (transfer === null) throw transferNotFound();
    if (transfer.expiresAt <= now) {
      this.delete(transfer.id);
      throw transferNotFound();
    }
    return { transfer, files: this.deps.repository.filesByTransferId(transfer.id) };
  }

  /**
   * Atomically claim a transfer and decide what to stream. The loser of a
   * concurrent claim gets 409. If a file-backed transfer's content vanished
   * from disk, the broken transfer is deleted — partial content is never
   * delivered — and the caller sees the generic 404.
   */
  prepareDownload(rawKey: string, now = Date.now()): DownloadPlan {
    const { logger, repository, storage } = this.deps;
    const { transfer, files } = this.get(rawKey, now);

    if (!repository.claim(transfer.id, now)) throw transferBusy();
    this.activeDownloads.add(transfer.id);

    try {
      if (files.length > 0) {
        const dir = storage.transferDir(transfer.id);
        const missing =
          !storage.exists(dir) ||
          files.some((file) => !storage.exists(storage.fileIn(dir, file.storedName)));
        if (missing) {
          logger.warn('transfer content missing on disk; removing transfer', {
            transferId: transfer.id,
          });
          this.delete(transfer.id);
          throw transferNotFound();
        }
      }

      const plan = this.buildPlan(transfer, files);
      logger.info('download claimed', { transferId: transfer.id, kind: plan.kind });
      return plan;
    } catch (error) {
      if (this.activeDownloads.has(transfer.id)) this.release(transfer.id);
      throw error;
    }
  }

  /** Stream finished successfully: consume the transfer (rows + directory). */
  finalize(transferId: string): void {
    this.delete(transferId);
    this.deps.logger.info('transfer consumed', { transferId });
  }

  /** Stream closed without finishing: hand the claim back so a retry works. */
  release(transferId: string): boolean {
    // Gated on membership so we never release a claim this process does not
    // own (e.g. one a cleanup pass already handled).
    if (!this.activeDownloads.delete(transferId)) return false;
    return this.deps.repository.release(transferId);
  }

  /** User-initiated delete before any download; busy while a download runs. */
  cancel(rawKey: string, now = Date.now()): void {
    const bundle = this.get(rawKey, now);
    if (bundle.transfer.status === 'downloading') throw transferBusy();
    this.delete(bundle.transfer.id);
    this.deps.logger.info('transfer cancelled', { transferId: bundle.transfer.id });
  }

  /** Terminal delete: row (files cascade) plus directory. Always idempotent. */
  delete(transferId: string): void {
    this.activeDownloads.delete(transferId);
    this.deps.repository.delete(transferId);
    this.deps.storage.removeDir(this.deps.storage.transferDir(transferId));
  }

  private buildPlan(transfer: TransferRecord, files: TransferFileRecord[]): DownloadPlan {
    if (files.length === 0) {
      // create() guarantees text accompanies every file-less transfer.
      if (transfer.textContent === null) throw internalError();
      return { kind: 'text', transferId: transfer.id, text: transfer.textContent };
    }
    const file = files[0];
    if (files.length === 1 && transfer.textContent === null && file !== undefined) {
      return { kind: 'file', transferId: transfer.id, file };
    }
    return { kind: 'zip', transferId: transfer.id, files, text: transfer.textContent };
  }
}
