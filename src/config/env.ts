import { existsSync } from 'node:fs';
import path from 'node:path';
import type { LogLevel } from '../lib/logger.js';
import { projectRoot } from './paths.js';

export type NodeEnv = 'development' | 'production' | 'test';

export interface Config {
  nodeEnv: NodeEnv;
  port: number;
  host: string;
  databasePath: string;
  storagePath: string;
  maxFileSizeBytes: number;
  maxFilesPerTransfer: number;
  maxTextLengthBytes: number;
  transferExpirationMinutes: number;
  cleanupIntervalMs: number;
  rateLimitWindowMs: number;
  rateLimitMaxRequests: number;
  trustProxy: number;
  logLevel: LogLevel;
}

let dotEnvLoaded = false;

function loadDotEnv(): void {
  if (dotEnvLoaded) return;
  dotEnvLoaded = true;
  const envPath = path.join(projectRoot, '.env');
  if (existsSync(envPath)) {
    try {
      process.loadEnvFile(envPath);
    } catch {
      // A malformed .env must not crash startup; explicit env vars still apply.
    }
  }
}

function readInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max} (got "${raw}")`);
  }
  return value;
}

function readString(name: string, fallback: string): string {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  return raw.trim();
}

function readEnum<T extends string>(name: string, fallback: T, allowed: readonly T[]): T {
  const raw = readString(name, fallback);
  if (!allowed.includes(raw as T)) {
    throw new Error(`${name} must be one of: ${allowed.join(', ')} (got "${raw}")`);
  }
  return raw as T;
}

/**
 * Build a validated, frozen config from environment variables, then apply
 * `overrides` (trusted, not re-validated — used by tests for temp paths and
 * tight limits). Invalid env values fail fast with a clear message.
 */
export function loadConfig(overrides: Partial<Config> = {}): Config {
  loadDotEnv();

  const maxFileMb = readInt('MAX_FILE_SIZE_MB', 2048, 1, 1_048_576);
  const maxTextKb = readInt('MAX_TEXT_LENGTH_KB', 512, 1, 1_048_576);

  const config: Config = {
    nodeEnv: readEnum<NodeEnv>('NODE_ENV', 'development', ['development', 'production', 'test']),
    port: readInt('PORT', 3000, 0, 65535),
    host: readString('HOST', '0.0.0.0'),
    databasePath: path.resolve(readString('DATABASE_PATH', './data/app.db')),
    storagePath: path.resolve(readString('STORAGE_PATH', './storage')),
    maxFileSizeBytes: maxFileMb * 1024 * 1024,
    maxFilesPerTransfer: readInt('MAX_FILES_PER_TRANSFER', 20, 1, 1000),
    maxTextLengthBytes: maxTextKb * 1024,
    transferExpirationMinutes: readInt('TRANSFER_EXPIRATION_MINUTES', 60, 1, 525_600),
    cleanupIntervalMs: readInt('CLEANUP_INTERVAL_MS', 60_000, 1000, 3_600_000),
    rateLimitWindowMs: readInt('RATE_LIMIT_WINDOW_MS', 60_000, 100, 3_600_000),
    rateLimitMaxRequests: readInt('RATE_LIMIT_MAX_REQUESTS', 30, 1, 1_000_000),
    trustProxy: readInt('TRUST_PROXY', 0, 0, 10),
    logLevel: readEnum<LogLevel>('LOG_LEVEL', 'info', ['debug', 'info', 'warn', 'error']),
  };

  return Object.freeze({ ...config, ...overrides });
}
