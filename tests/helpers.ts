import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Express } from 'express';
import AdmZip from 'adm-zip';
import { openDatabase, type Database } from '../src/db/database.js';
import type { Config } from '../src/config/env.js';
import { createLogger, type Logger } from '../src/lib/logger.js';
import { TransferRepository } from '../src/transfers/repository.js';
import { TransferService } from '../src/transfers/service.js';
import { TransferCleanup } from '../src/cleanup/cleanup.js';
import { FileStorage } from '../src/storage/file-storage.js';
import { createApp } from '../src/app.js';

export const TEST_ROOT = path.join(process.cwd(), '.tmp', 'test-data');

/** Tiny limits keep the suite fast; production defaults are never exercised here. */
export const TEST_LIMITS = {
  maxFileSizeBytes: 64 * 1024,
  maxFilesPerTransfer: 3,
  maxTextLengthBytes: 4 * 1024,
  transferExpirationMinutes: 60,
} as const;

export interface TestServer {
  base: string;
  config: Config;
  logger: Logger;
  logLines: string[];
  db: Database;
  repository: TransferRepository;
  service: TransferService;
  storage: FileStorage;
  cleanup: TransferCleanup;
  scratchDir: string;
  close(): Promise<void>;
}

let serverCounter = 0;

/** Full stack, isolated: fresh DB + storage per server, ephemeral port. */
export async function startTestServer(overrides: Partial<Config> = {}): Promise<TestServer> {
  mkdirSync(TEST_ROOT, { recursive: true });
  const id = `srv-${process.pid}-${serverCounter++}`;
  const scratchDir = mkdtempSync(path.join(TEST_ROOT, `${id}-`));

  const logLines: string[] = [];
  const logger = createLogger('debug', (line) => logLines.push(line));

  const config: Config = Object.freeze({
    nodeEnv: 'test' as const,
    port: 0,
    host: '127.0.0.1',
    databasePath: path.join(scratchDir, 'app.db'),
    storagePath: path.join(scratchDir, 'storage'),
    cleanupIntervalMs: 60_000,
    rateLimitWindowMs: 60_000,
    rateLimitMaxRequests: 1000,
    trustProxy: 0,
    logLevel: 'debug' as const,
    ...TEST_LIMITS,
    ...overrides,
  });

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
  const app: Express = createApp({ config, logger, service, storage });

  await new Promise<void>((resolve, reject) => {
    const server = app.listen(0, config.host, () => resolve());
    server.on('error', reject);
    (app as unknown as { __testServer: unknown }).__testServer = server;
  });
  const server = (app as unknown as { __testServer: import('node:http').Server }).__testServer;
  const { port } = server.address() as AddressInfo;

  return {
    base: `http://127.0.0.1:${port}`,
    config,
    logger,
    logLines,
    db,
    repository,
    service,
    storage,
    cleanup,
    scratchDir,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
      rmSync(scratchDir, { recursive: true, force: true });
    },
  };
}

export interface UploadFile {
  name: string;
  content: string | Buffer;
  type?: string;
}

/** Builds multipart bodies by hand — no extra deps, known CRLF layout. */
export function buildMultipart(
  files: UploadFile[],
  text?: string,
): { body: Buffer; boundary: string } {
  const boundary = `qd-test-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const chunks: Buffer[] = [];
  const push = (value: string | Buffer): void => {
    chunks.push(typeof value === 'string' ? Buffer.from(value, 'utf8') : value);
  };
  for (const file of files) {
    push(`--${boundary}\r\n`);
    push(
      `Content-Disposition: form-data; name="files"; filename="${file.name}"\r\n` +
        `Content-Type: ${file.type ?? 'application/octet-stream'}\r\n\r\n`,
    );
    push(typeof file.content === 'string' ? Buffer.from(file.content, 'utf8') : file.content);
    push('\r\n');
  }
  if (text !== undefined) {
    push(`--${boundary}\r\n`);
    push('Content-Disposition: form-data; name="text"\r\n\r\n');
    push(text);
    push('\r\n');
  }
  push(`--${boundary}--\r\n`);
  return { body: Buffer.concat(chunks), boundary };
}

export interface ApiError extends Error {
  status: number;
  body: unknown;
}

/** fetch wrapper: throws ApiError on non-2xx; streams callers read bodies themselves. */
export async function api(
  base: string,
  route: string,
  init: RequestInit = {},
): Promise<{ status: number; headers: Headers; json: () => Promise<unknown> }> {
  const response = await fetch(`${base}${route}`, init);
  if (!response.ok) {
    const text = await response.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      /* keep raw text */
    }
    const error = new Error(`HTTP ${response.status}`) as ApiError;
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return {
    status: response.status,
    headers: response.headers,
    json: () => response.json() as Promise<unknown>,
  };
}

/** Create a transfer; returns the display key (XXXX-XXXX). */
export async function createTransfer(
  base: string,
  files: UploadFile[] = [],
  text?: string,
): Promise<string> {
  const { body, boundary } = buildMultipart(files, text);
  const result = await api(base, '/api/transfers', {
    method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body,
  });
  const payload = (await result.json()) as { key: string };
  return payload.key;
}

/** Polls until `check` passes or the budget is exhausted. */
export async function waitFor(
  check: () => boolean | Promise<boolean>,
  timeoutMs = 5000,
  intervalMs = 50,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/** Returned names must never contradict what the filesystem actually holds. */
export function listFinalFiles(storage: FileStorage, transferId: string): string[] {
  const dir = storage.transferDir(transferId);
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}

export function asZip(buffer: Buffer): AdmZip {
  return new AdmZip(buffer);
}

export function tempPath(name: string): string {
  return path.join(tmpdir(), `quickdrop-test-${process.pid}-${name}`);
}

