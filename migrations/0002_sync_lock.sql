CREATE TABLE IF NOT EXISTS sync_locks (
  lock_name TEXT PRIMARY KEY,
  owner_token TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
