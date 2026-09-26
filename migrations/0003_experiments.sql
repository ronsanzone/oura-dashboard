-- Append-only revisions preserve plans, edits, check-ins and reflections.
CREATE TABLE experiment_revisions (
  experiment_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  document_json TEXT NOT NULL,
  saved_at TEXT NOT NULL,
  PRIMARY KEY (experiment_id, version)
);
CREATE TABLE experiment_snapshots (
  id TEXT PRIMARY KEY,
  experiment_id TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  saved_at TEXT NOT NULL
);
CREATE INDEX idx_experiment_snapshots ON experiment_snapshots(experiment_id, saved_at);
