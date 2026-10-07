# QuickDrop

Ephemeral, single-use file and text transfers between devices. No accounts, no durable storage — everything is deleted after the first download or when it expires.

A small Node.js/Express app with a vanilla-JS web UI, SQLite persistence, and automatic cleanup.

## Features

- **Send** upload files and/or text; receive with a short 8-character key.
- No sign-up or accounts; transfers are single-use and deletable as soon as they have been downloaded once.
- Configurable limits: max file size, max files per transfer, max text length, and transfer lifetime.
- Automatic cleanup sweeps expired or idle transfers on an interval.
- Rate limiting, security headers, and a strict content-security-policy.

## Project layout

```text
src/
  app.ts              Express app factory (routes, views, static)
  server.ts           Production entry point (config → db → storage → listen)
  config/env.ts       Config loading + validation from environment variables
  db/                 SQLite database setup and migrations
  lib/                Helpers: keys, errors, logger, paths
  middleware/         Security headers, rate limiter, error handler
  storage/            File storage (per-transfer directories + upload)
  transfers/          Service, controller, repository, routes
views/                EJS templates (the UI)
public/               Static UI assets
tests/                Integration & unit tests
```

## Getting started

### Prerequisites

- Node.js `>= 22.22.0`

### Install

```bash
npm ci
```

### Run in development

```bash
npm run dev
```

The server starts on `http://localhost:3000` (override with `PORT`).

### Run in production

```bash
npm run build
npm start
```

### Test

```bash
npm test
```

Type-check both the app and tests:

```bash
npm run typecheck
```

Format:

```bash
npm run format
```

## Configuration

Copy `.env.example` to `.env` and adjust. All values are optional; defaults are shown.

```ini
# Runtime
NODE_ENV=production
PORT=3000
HOST=0.0.0.0

# Persistence (relative to the working directory)
DATABASE_PATH=./data/app.db
STORAGE_PATH=./storage

# Upload limits
MAX_FILE_SIZE_MB=2048
MAX_FILES_PER_TRANSFER=20
MAX_TEXT_LENGTH_KB=512

# Transfer lifetime (minutes) — also surfaced in the page footer
TRANSFER_EXPIRATION_MINUTES=60

# Cleanup sweep interval (ms)
CLEANUP_INTERVAL_MS=60000

# Rate limiting (per IP, applied to transfer API endpoints)
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX_REQUESTS=30

# Number of trusted reverse-proxy hops in front of the app (0 = none).
# Set to 1 when running behind nginx/Caddy so rate limiting + IP tracking
# see the real client IP.
TRUST_PROXY=0

# Logging: debug | info | warn | error
LOG_LEVEL=info
```

## API

All transfer endpoints are rate-limited per IP. Health checks (`GET /api/health`) are not.

| Method | Path                          | Description                               |
| ------ | ----------------------------- | ----------------------------------------- |
| `POST` | `/api/transfers`              | Create a transfer (multipart: `files[]` + `text`) |
| `GET`  | `/api/transfers/:key`         | Metadata of a transfer (non-consuming)    |
| `GET`  | `/api/transfers/:key/download`| Claim and stream the transfer (consumes)  |
| `DELETE`| `/api/transfers/:key`        | Cancel a transfer before download         |

### Example: upload

```bash
curl -X POST http://localhost:3000/api/transfers \
  -F "files=@hello.txt" \
  -F "text=Hello world"
```

#### Response

```json
{
  "key": "7K4P9XQM",
  "keyUrl": "/api/transfers/7K4P9XQM",
  "downloadUrl": "/api/transfers/7K4P9XQM/download",
  "expiresAt": "2026-10-08T12:34:56.000Z",
  "files": [],
  "text": "Hello world"
}
```

### Example: retrieve metadata

```bash
curl http://localhost:3000/api/transfers/7K4P9XQM
```

### Example: download

```bash
curl -OJ http://localhost:3000/api/transfers/7K4P9XQM/download
```

The download endpoint consumes the transfer: the first successful download deletes it.

### Error responses

| Status | Meaning                     |
| ------ | --------------------------- |
| 400    | Validation payload error    |
| 404    | Not found (unknown, expired, or already deleted) |
| 409    | Transfer is being downloaded |
| 413    | Payload too large           |
| 429    | Too many requests (with `Retry-After`) |
| 500    | Internal error              |

## Database

SQLite (`better-sqlite3`-backed, per `src/db/database.ts`). Migrations live in `src/db/migrations.ts` and run automatically on startup at the configured `DATABASE_PATH`.

## Testing

The test suite lives in `tests/` and is run with Node's built-in test runner via `tsx`:

```bash
npm test
```

## Security

- Strict CSP (self-hosted assets only; no inline scripts or styles).
- `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`.
- Per-IP rate limiting on transfer endpoints.
- Generic 404s for unknown/invalid keys (no key enumeration).
- `.env` is gitignored; never commit secrets.

## License

See repository for details.
