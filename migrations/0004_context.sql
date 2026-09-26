-- Model proposals and human corrections are separate, append-only records.
CREATE TABLE context_proposals (
  id TEXT PRIMARY KEY,
  document_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE context_revisions (
  day TEXT NOT NULL,
  version INTEGER NOT NULL,
  proposal_id TEXT NOT NULL REFERENCES context_proposals(id),
  labels_json TEXT NOT NULL,
  reason TEXT NOT NULL,
  saved_at TEXT NOT NULL,
  PRIMARY KEY (day, version)
);
