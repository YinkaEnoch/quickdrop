import type { Database } from '../db/database.js';
import type { Logger } from '../lib/logger.js';
import { noopLogger } from '../lib/logger.js';
import type { TransferFileRecord, TransferRecord, TransferStatus } from './transfer.types.js';

interface TransferRow {
  id: string;
  share_key: string;
  text_content: string | null;
  status: string;
  created_at: number;
  expires_at: number;
  claim_started_at: number | null;
}

interface TransferFileRow {
  id: string;
  transfer_id: string;
  original_name: string;
  stored_name: string;
  mime_type: string | null;
  size: number;
}

interface TransferWithCountRow extends TransferRow {
  file_count: number;
}

function toTransfer(row: TransferRow): TransferRecord {
  return {
    id: row.id,
    shareKey: row.share_key,
    textContent: row.text_content,
    status: row.status as TransferStatus,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    claimStartedAt: row.claim_started_at,
  };
}

function toFile(row: TransferFileRow): TransferFileRecord {
  return {
    id: row.id,
    transferId: row.transfer_id,
    originalName: row.original_name,
    storedName: row.stored_name,
    mimeType: row.mime_type,
    size: row.size,
  };
}

/**
 * All transfer SQL lives here — no business logic and no filesystem access.
 * Mutating sequences are wrapped by callers via `db.transaction`.
 */
export class TransferRepository {
  constructor(
    private readonly db: Database,
    private readonly logger: Logger = noopLogger,
  ) {}

  /** Inserts the transfer row plus its file rows (caller owns the transaction). */
  insert(transfer: TransferRecord, files: TransferFileRecord[]): void {
    this.logger.debug('repository inserting transfer', {
      transferId: transfer.id,
      fileCount: files.length,
    });
    this.db.raw
      .prepare(
        `INSERT INTO transfers (id, share_key, text_content, status, created_at, expires_at, claim_started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        transfer.id,
        transfer.shareKey,
        transfer.textContent,
        transfer.status,
        transfer.createdAt,
        transfer.expiresAt,
        transfer.claimStartedAt,
      );
    for (const file of files) {
      this.db.raw
        .prepare(
          `INSERT INTO transfer_files (id, transfer_id, original_name, stored_name, mime_type, size)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          file.id,
          file.transferId,
          file.originalName,
          file.storedName,
          file.mimeType,
          file.size,
        );
    }
  }

  findByKey(shareKey: string): TransferRecord | null {
    this.logger.debug('repository lookup by key');
    const row = this.db.raw
      .prepare('SELECT * FROM transfers WHERE share_key = ?')
      .get(shareKey) as unknown as TransferRow | undefined;
    const found = row !== undefined;
    this.logger.debug('repository lookup by key complete', { found });
    return row === undefined ? null : toTransfer(row);
  }

  findById(id: string): TransferRecord | null {
    this.logger.debug('repository lookup by id', { transferId: id });
    const row = this.db.raw.prepare('SELECT * FROM transfers WHERE id = ?').get(id) as unknown as
      TransferRow | undefined;
    this.logger.debug('repository lookup by id complete', {
      transferId: id,
      found: row !== undefined,
    });
    return row === undefined ? null : toTransfer(row);
  }

  filesByTransferId(transferId: string): TransferFileRecord[] {
    this.logger.debug('repository listing files', { transferId });
    // rowid order = insertion order = upload order (stored-name padding
    // would sort wrong once a transfer holds 100+ files).
    const rows = this.db.raw
      .prepare('SELECT * FROM transfer_files WHERE transfer_id = ? ORDER BY rowid')
      .all(transferId) as unknown as TransferFileRow[];
    this.logger.debug('repository files listed', { transferId, fileCount: rows.length });
    return rows.map(toFile);
  }

  /**
   * Atomic claim: only a `ready`, not-yet-expired row can transition to
   * `downloading`, so exactly one caller can ever win (`changes === 1`).
   */
  claim(id: string, now: number): boolean {
    this.logger.debug('repository claiming transfer', { transferId: id });
    const result = this.db.raw
      .prepare(
        `UPDATE transfers SET status = 'downloading', claim_started_at = ?
         WHERE id = ? AND status = 'ready' AND expires_at > ?`,
      )
      .run(now, id, now);
    const claimed = result.changes === 1;
    this.logger.debug('repository claim result', { transferId: id, claimed });
    return claimed;
  }

  /** Hands a claimed transfer back to `ready` (stream closed without finishing). */
  release(id: string): boolean {
    this.logger.debug('repository releasing transfer', { transferId: id });
    const result = this.db.raw
      .prepare(
        `UPDATE transfers SET status = 'ready', claim_started_at = NULL
         WHERE id = ? AND status = 'downloading'`,
      )
      .run(id);
    const released = result.changes === 1;
    this.logger.debug('repository release result', { transferId: id, released });
    return released;
  }

  /** Deletes the transfer row; file rows cascade via the foreign key. */
  delete(id: string): boolean {
    this.logger.debug('repository deleting transfer', { transferId: id });
    const deleted = this.db.raw.prepare('DELETE FROM transfers WHERE id = ?').run(id).changes === 1;
    this.logger.debug('repository delete result', { transferId: id, deleted });
    return deleted;
  }

  listExpired(now: number): TransferRecord[] {
    this.logger.debug('repository listing expired transfers');
    const rows = this.db.raw
      .prepare('SELECT * FROM transfers WHERE expires_at <= ? ORDER BY expires_at')
      .all(now) as unknown as TransferRow[];
    this.logger.debug('repository expired listed', { count: rows.length });
    return rows.map(toTransfer);
  }

  /** Download claims older than `cutoff`; `null` matches every lingering claim. */
  listStaleClaims(cutoff: number | null): TransferRecord[] {
    this.logger.debug('repository listing stale claims', { releaseAll: cutoff === null });
    const base = "status = 'downloading' AND claim_started_at IS NOT NULL";
    const rows =
      cutoff === null
        ? (this.db.raw
            .prepare(`SELECT * FROM transfers WHERE ${base} ORDER BY claim_started_at`)
            .all() as unknown as TransferRow[])
        : (this.db.raw
            .prepare(
              `SELECT * FROM transfers WHERE ${base} AND claim_started_at < ?
               ORDER BY claim_started_at`,
            )
            .all(cutoff) as unknown as TransferRow[]);
    this.logger.debug('repository stale claims listed', { count: rows.length });
    return rows.map(toTransfer);
  }

  listAll(): TransferRecord[] {
    this.logger.debug('repository listing all transfers');
    const rows = this.db.raw
      .prepare('SELECT * FROM transfers ORDER BY created_at')
      .all() as unknown as TransferRow[];
    this.logger.debug('repository transfers listed', { count: rows.length });
    return rows.map(toTransfer);
  }

  /** Every transfer with its file count — used to spot rows whose dir vanished. */
  listAllWithFileCounts(): Array<TransferRecord & { fileCount: number }> {
    this.logger.debug('repository listing transfers with file counts');
    const rows = this.db.raw
      .prepare(
        `SELECT t.*, COUNT(f.id) AS file_count
         FROM transfers t
         LEFT JOIN transfer_files f ON f.transfer_id = t.id
         GROUP BY t.id
         ORDER BY t.created_at`,
      )
      .all() as unknown as TransferWithCountRow[];
    const mapped = rows.map((row) => ({ ...toTransfer(row), fileCount: row.file_count }));
    this.logger.debug('repository transfers with counts listed', { count: mapped.length });
    return mapped;
  }
}
