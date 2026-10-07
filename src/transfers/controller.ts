import { randomUUID } from 'node:crypto';
import { createReadStream, statSync } from 'node:fs';
import { ZipArchive } from 'archiver';
import type { Request, RequestHandler } from 'express';
import multer from 'multer';
import type { Config } from '../config/env.js';
import { badRequest, payloadTooLarge } from '../lib/errors.js';
import { formatShareKey } from '../lib/keys.js';
import type { FileStorage } from '../storage/file-storage.js';
import { toMetadataDto, ZIP_TEXT_ENTRY_NAME, type DownloadPlan } from './transfer.types.js';
import type { TransferService } from './service.js';

/** Request augmented with the per-upload staging dir chosen by multer. */
interface StagedRequest extends Request {
  stagingDir?: string;
}

/**
 * Flattens a user-provided name into something safe for a zip entry or a
 * Content-Disposition header: no path separators, no control characters
 * (header injection), no dot-only names, bounded length.
 */
function safeName(raw: string): string {
  const flattened = raw.replace(/[\\/]/g, '_').replace(/[\x00-\x1f\x7f"']/g, '');
  const trimmed = flattened.replace(/^\.+/, '').trim();
  return trimmed.length > 0 ? trimmed.slice(0, 200) : 'file';
}

/** RFC 6266 attachment header with an ASCII fallback + UTF-8 variant. */
function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_');
  const encoded = encodeURIComponent(filename).replace(
    /['()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

function mapMulterError(error: unknown, config: Config): unknown {
  if (!(error instanceof multer.MulterError)) return error;
  switch (error.code) {
    case 'LIMIT_FILE_SIZE':
      return payloadTooLarge('A file exceeds the size limit.');
    case 'LIMIT_FILE_COUNT':
      return badRequest(`A transfer can contain at most ${config.maxFilesPerTransfer} files.`);
    case 'LIMIT_FIELD_VALUE':
      return payloadTooLarge(
        `Text exceeds the ${Math.floor(config.maxTextLengthBytes / 1024)} KB limit.`,
      );
    case 'LIMIT_UNEXPECTED_FILE':
      return badRequest('Unexpected file field.');
    case 'LIMIT_FIELD_COUNT':
      return badRequest('The upload request has too many fields.');
    default:
      return error;
  }
}

/** Route param as a plain string (Express 5 types params loosely). */
function keyParam(req: Request): string {
  return typeof req.params.key === 'string' ? req.params.key : '';
}

export interface TransferControllerDeps {
  config: Config;
  service: TransferService;
  storage: FileStorage;
}

/**
 * HTTP handlers for the transfer lifecycle. Owns the upload pipeline:
 * multer stages files under uuid names in a per-request staging dir, the
 * service renames/moves them, and the staging dir is swept here on every
 * exit path (success moves it away; failure removes leftovers).
 */
export function createTransferController(deps: TransferControllerDeps) {
  const { config, service, storage } = deps;

  const uploadMw = multer({
    storage: multer.diskStorage({
      destination: (req, _file, cb) => {
        const staged = req as StagedRequest;
        try {
          if (staged.stagingDir === undefined) {
            staged.stagingDir = storage.createStagingDir();
          }
          cb(null, staged.stagingDir);
        } catch (error) {
          cb(error as Error, '');
        }
      },
      filename: (_req, _file, cb) => {
        cb(null, randomUUID());
      },
    }),
    limits: {
      fileSize: config.maxFileSizeBytes,
      files: config.maxFilesPerTransfer,
      fields: 10,
      fieldSize: config.maxTextLengthBytes,
    },
  }).array('files');

  function sweepStaging(req: Request): void {
    const dir = (req as StagedRequest).stagingDir;
    if (dir !== undefined) storage.removeDir(dir);
  }

  /** Multer wrapper: on error, remove partial uploads before forwarding. */
  const upload: RequestHandler = (req, res, next) => {
    uploadMw(req, res, (error) => {
      if (error) {
        sweepStaging(req);
        next(mapMulterError(error, config));
        return;
      }
      next();
    });
  };

  const create: RequestHandler = (req, res, next) => {
    try {
      const files = (req.files as Express.Multer.File[] | undefined) ?? [];
      const rawText = req.body?.text;
      const text = typeof rawText === 'string' ? rawText : null;
      const bundle = service.create(
        {
          stagingPath: (req as StagedRequest).stagingDir ?? storage.stagingDir,
          text,
          files: files.map((file) => ({
            originalName: file.originalname,
            stagedName: file.filename,
            size: file.size,
            mimeType: file.mimetype.length > 0 ? file.mimetype : null,
          })),
        },
        Date.now(),
      );
      res.status(201).json({ key: formatShareKey(bundle.transfer.shareKey) });
    } catch (error) {
      next(error);
    } finally {
      // Success moved the staging dir away (this is then an idempotent
      // no-op that also clears the active-set entry); failure removes the
      // leftovers. Service-side rollback already handled the final dir.
      sweepStaging(req);
    }
  };

  const metadata: RequestHandler = (req, res, next) => {
    try {
      // Non-consuming: works for ready and currently-downloading transfers.
      res.json(toMetadataDto(service.get(keyParam(req))));
    } catch (error) {
      next(error);
    }
  };

  const cancel: RequestHandler = (req, res, next) => {
    try {
      service.cancel(keyParam(req));
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  };

  /**
   * Claim → stream → finish deletes / close-without-finish releases.
   * Pre-headers stream failures release the claim explicitly and fall
   * through to the error handler; post-headers failures destroy the
   * response and let the close handler release.
   */
  const download: RequestHandler = (req, res, next) => {
    let plan: DownloadPlan;
    try {
      plan = service.prepareDownload(keyParam(req), Date.now());
    } catch (error) {
      next(error);
      return;
    }

    let settled = false;
    const settle = (action: 'finalize' | 'release'): void => {
      if (settled) return;
      settled = true;
      if (action === 'finalize') service.finalize(plan.transferId);
      else service.release(plan.transferId);
    };

    res.on('finish', () => settle('finalize'));
    res.on('close', () => {
      if (!res.writableEnded) settle('release');
    });
    res.on('error', () => settle('release'));

    const fail = (error: unknown): void => {
      if (res.headersSent) {
        res.destroy(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      settle('release');
      next(error);
    };

    try {
      switch (plan.kind) {
        case 'text': {
          res.status(200);
          res.setHeader('Content-Type', 'text/plain; charset=utf-8');
          res.setHeader('Content-Disposition', 'attachment; filename="quickdrop.txt"');
          res.setHeader('Content-Length', String(Buffer.byteLength(plan.text)));
          res.end(plan.text);
          break;
        }
        case 'file': {
          const filePath = storage.fileIn(
            storage.transferDir(plan.transferId),
            plan.file.storedName,
          );
          res.setHeader('Content-Type', 'application/octet-stream');
          res.setHeader(
            'Content-Disposition',
            contentDisposition(safeName(plan.file.originalName)),
          );
          res.setHeader('Content-Length', String(statSync(filePath).size));
          const stream = createReadStream(filePath);
          stream.on('error', fail);
          stream.pipe(res);
          break;
        }
        case 'zip': {
          res.setHeader('Content-Type', 'application/zip');
          res.setHeader('Content-Disposition', 'attachment; filename="quickdrop.zip"');
          const zip = new ZipArchive({ zlib: { level: 6 } });
          zip.on('error', fail);
          zip.pipe(res);
          const dir = storage.transferDir(plan.transferId);
          for (const file of plan.files) {
            zip.file(storage.fileIn(dir, file.storedName), {
              name: safeName(file.originalName),
            });
          }
          if (plan.text !== null) zip.append(plan.text, { name: ZIP_TEXT_ENTRY_NAME });
          void zip.finalize().catch(fail);
          break;
        }
      }
    } catch (error) {
      fail(error);
    }
  };

  return { upload, create, metadata, download, cancel };
}
