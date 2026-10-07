export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

export type LogSink = (line: string) => void;

function serializeValue(value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  return value;
}

/**
 * Minimal structured JSON-line logger. Deliberately dependency-free.
 *
 * Callers must never pass share keys, transfer text, file contents, or
 * original file names as fields — use internal transfer ids and counts.
 */
export function createLogger(level: LogLevel = 'info', sink?: LogSink): Logger {
  const threshold = LEVEL_ORDER[level];
  const write: LogSink = sink ?? ((line) => process.stdout.write(`${line}\n`));

  function emit(entryLevel: LogLevel, message: string, fields?: LogFields): void {
    if (LEVEL_ORDER[entryLevel] < threshold) return;
    const normalized: Record<string, unknown> = {};
    if (fields) {
      for (const [key, value] of Object.entries(fields)) normalized[key] = serializeValue(value);
    }
    const entry = { ...normalized, time: new Date().toISOString(), level: entryLevel, message };
    let line: string;
    try {
      line = JSON.stringify(entry);
    } catch {
      line = JSON.stringify({
        time: entry.time,
        level: entryLevel,
        message,
        logError: 'unserializable fields omitted',
      });
    }
    write(line);
  }

  return {
    debug: (message, fields) => emit('debug', message, fields),
    info: (message, fields) => emit('info', message, fields),
    warn: (message, fields) => emit('warn', message, fields),
    error: (message, fields) => emit('error', message, fields),
  };
}
