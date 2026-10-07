import { formatShareKey } from '../lib/keys.js';

/**
 * Transfer domain records, DTOs, and download planning.
 *
 * Only two statuses ever persist: `ready` and `downloading`. Every terminal
 * outcome (completed, expired, cancelled) is realized as row deletion, so the
 * database never grows a third state.
 */
export type TransferStatus = 'ready' | 'downloading';

/** Row shape of `transfers` (camelCase). */
export interface TransferRecord {
  id: string;
  shareKey: string;
  textContent: string | null;
  status: TransferStatus;
  createdAt: number;
  expiresAt: number;
  claimStartedAt: number | null;
}

/**
 * Row shape of `transfer_files` (camelCase). `originalName` is display data
 * only — it never participates in filesystem paths (stored names do).
 */
export interface TransferFileRecord {
  id: string;
  transferId: string;
  originalName: string;
  storedName: string;
  mimeType: string | null;
  size: number;
}

/** A transfer and its files, fetched as one unit. */
export interface TransferBundle {
  transfer: TransferRecord;
  files: TransferFileRecord[];
}

export interface TransferFileDto {
  name: string;
  size: number;
  mimeType: string | null;
}

/** JSON view served by the non-consuming metadata endpoint. */
export interface TransferMetadataDto {
  /** Display form XXXX-XXXX — the canonical key never leaves the server. */
  key: string;
  createdAt: number;
  expiresAt: number;
  text: string | null;
  files: TransferFileDto[];
}

export function toMetadataDto(bundle: TransferBundle): TransferMetadataDto {
  const { transfer, files } = bundle;
  return {
    key: formatShareKey(transfer.shareKey),
    createdAt: transfer.createdAt,
    expiresAt: transfer.expiresAt,
    text: transfer.textContent,
    files: files.map((file) => ({
      name: file.originalName,
      size: file.size,
      mimeType: file.mimeType,
    })),
  };
}

/** One staged file as handed over by the upload middleware. */
export interface StagedFileInput {
  originalName: string;
  /** On-disk name inside the staging directory (storage-generated, not user input). */
  stagedName: string;
  size: number;
  mimeType: string | null;
}

export interface CreateTransferInput {
  stagingPath: string;
  text: string | null;
  files: StagedFileInput[];
}

/** Zip entry name used when a transfer's text rides along with its files. */
export const ZIP_TEXT_ENTRY_NAME = 'text.txt';

/**
 * What a claimed download should stream. A transfer always downloads in one
 * shot: text alone, a single file alone, or a zip of all files (plus the
 * text as `text.txt` when both are present).
 */
export type DownloadPlan =
  | { kind: 'text'; transferId: string; text: string }
  | { kind: 'file'; transferId: string; file: TransferFileRecord }
  | { kind: 'zip'; transferId: string; files: TransferFileRecord[]; text: string | null };
