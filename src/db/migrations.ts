export interface Migration {
  id: string;
  sql: string;
}

export const migrations: Migration[] = [
  {
    id: '001-initial',
    sql: `
CREATE TABLE transfers (
    id TEXT PRIMARY KEY,
    share_key TEXT NOT NULL UNIQUE,
    text_content TEXT,
    status TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('ready', 'downloading')),
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    claim_started_at INTEGER
);

CREATE INDEX idx_transfers_expires_at ON transfers (expires_at);
CREATE INDEX idx_transfers_status ON transfers (status);

CREATE TABLE transfer_files (
    id TEXT PRIMARY KEY,
    transfer_id TEXT NOT NULL
        REFERENCES transfers (id) ON DELETE CASCADE,
    original_name TEXT NOT NULL,
    stored_name TEXT NOT NULL,
    mime_type TEXT,
    size INTEGER NOT NULL
);

CREATE INDEX idx_transfer_files_transfer_id ON transfer_files (transfer_id);
`,
  },
];
