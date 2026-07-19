CREATE TABLE IF NOT EXISTS records (
  data_type TEXT NOT NULL,
  record_id TEXT NOT NULL,
  record_date TEXT,
  start_datetime TEXT,
  end_datetime TEXT,
  payload_json TEXT NOT NULL,
  synced_at TEXT NOT NULL,
  PRIMARY KEY (data_type, record_id)
);

CREATE INDEX IF NOT EXISTS idx_records_type_date
  ON records(data_type, record_date);

CREATE INDEX IF NOT EXISTS idx_records_start_datetime
  ON records(start_datetime);

CREATE TABLE IF NOT EXISTS oauth_tokens (
  account_id TEXT PRIMARY KEY,
  access_token_ciphertext TEXT NOT NULL,
  refresh_token_ciphertext TEXT NOT NULL,
  expires_at TEXT,
  scope TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_states (
  state_hash TEXT PRIMARY KEY,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,
  details TEXT
);

CREATE TABLE IF NOT EXISTS webhook_events (
  event_id TEXT PRIMARY KEY,
  received_at TEXT NOT NULL,
  processed_at TEXT,
  payload_json TEXT NOT NULL
);
