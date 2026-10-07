import type { Database } from '../db/database.js';
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
  constructor(private readonly db: Database) {}

  /** Inserts the transfer row plus its file rows (caller owns the transaction). */
  insert(transfer: TransferRecord, files: TransferFileRecord[]): void {
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
    const row = this.db.raw
      .prepare('SELECT * FROM transfers WHERE share_key = ?')
      .get(shareKey) as unknown as TransferRow | undefined;
    return row === undefined ? null : toTransfer(row);
  }

  findById(id: string): TransferRecord | null {
    const row = this.db.raw.prepare('SELECT * FROM transfers WHERE id = ?').get(id) as unknown as
      TransferRow | undefined;
    return row === undefined ? null : toTransfer(row);
  }

  filesByTransferId(transferId: string): TransferFileRecord[] {
    // rowid order = insertion order = upload order (stored-name padding
    // would sort wrong once a transfer holds 100+ files).
    const rows = this.db.raw
      .prepare('SELECT * FROM transfer_files WHERE transfer_id = ? ORDER BY rowid')
      .all(transferId) as unknown as TransferFileRow[];
    return rows.map(toFile);
  }

  /**
   * Atomic claim: only a `ready`, not-yet-expired row can transition to
   * `downloading`, so exactly one caller can ever win (`changes === 1`).
   */
  claim(id: string, now: number): boolean {
    const result = this.db.raw
      .prepare(
        `UPDATE transfers SET status = 'downloading', claim_started_at = ?
         WHERE id = ? AND status = 'ready' AND expires_at > ?`,
      )
      .run(now, id, now);
    return result.changes === 1;
  }

  /** Hands a claimed transfer back to `ready` (stream closed without finishing). */
  release(id: string): boolean {
    const result = this.db.raw
      .prepare(
        `UPDATE transfers SET status = 'ready', claim_started_at = NULL
         WHERE id = ? AND status = 'downloading'`,
      )
      .run(id);
    return result.changes === 1;
  }

  /** Deletes the transfer row; file rows cascade via the foreign key. */
  delete(id: string): boolean {
    return this.db.raw.prepare('DELETE FROM transfers WHERE id = ?').run(id).changes === 1;
  }

  listExpired(now: number): TransferRecord[] {
    const rows = this.db.raw
      .prepare('SELECT * FROM transfers WHERE expires_at <= ? ORDER BY expires_at')
      .all(now) as unknown as TransferRow[];
    return rows.map(toTransfer);
  }

  /** Download claims older than `cutoff`; `null` matches every lingering claim. */
  listStaleClaims(cutoff: number | null): TransferRecord[] {
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
    return rows.map(toTransfer);
  }

  listAll(): TransferRecord[] {
    const rows = this.db.raw
      .prepare('SELECT * FROM transfers ORDER BY created_at')
      .all() as unknown as TransferRow[];
    return rows.map(toTransfer);
  }

  /** Every transfer with its file count — used to spot rows whose dir vanished. */
  listAllWithFileCounts(): Array<TransferRecord & { fileCount: number }> {
    const rows = this.db.raw
      .prepare(
        `SELECT t.*, COUNT(f.id) AS file_count
         FROM transfers t
         LEFT JOIN transfer_files f ON f.transfer_id = t.id
         GROUP BY t.id
         ORDER BY t.created_at`,
      )
      .all() as unknown as TransferWithCountRow[];
    return rows.map((row) => ({ ...toTransfer(row), fileCount: row.file_count }));
  }
}
