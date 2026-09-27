-- Canonical record day: payload.day > payload.start_day > payload.date >
-- record_date > first available instant interpreted in America/New_York.
-- Materializing it avoids JSON expressions and full-table sorts on reads.
ALTER TABLE records ADD COLUMN effective_date TEXT NOT NULL DEFAULT '';

CREATE VIEW record_canonical_days AS
SELECT data_type, record_id, COALESCE(
  NULLIF(json_extract(payload_json, '$.day'), ''),
  NULLIF(json_extract(payload_json, '$.start_day'), ''),
  NULLIF(json_extract(payload_json, '$.date'), ''),
  NULLIF(record_date, ''),
  CASE
    WHEN datetime(source_timestamp) IS NULL THEN NULL
    -- US Eastern DST: second Sunday in March at 07:00 UTC through the
    -- first Sunday in November at 06:00 UTC (current Oura data era).
    WHEN datetime(source_timestamp) >= datetime(
      strftime('%Y', datetime(source_timestamp)) || '-03-01',
      'weekday 0', '+7 days', '+7 hours'
    ) AND datetime(source_timestamp) < datetime(
      strftime('%Y', datetime(source_timestamp)) || '-11-01',
      'weekday 0', '+6 hours'
    ) THEN date(source_timestamp, '-4 hours')
    ELSE date(source_timestamp, '-5 hours')
  END,
  ''
) AS canonical_day
FROM (
  SELECT data_type, record_id, record_date, payload_json, COALESCE(
    NULLIF(start_datetime, ''),
    NULLIF(json_extract(payload_json, '$.timestamp'), ''),
    NULLIF(json_extract(payload_json, '$.bedtime_start'), ''),
    NULLIF(json_extract(payload_json, '$.start_time'), '')
  ) AS source_timestamp
  FROM records
);

UPDATE records
SET effective_date = (
  SELECT canonical_day FROM record_canonical_days
  WHERE record_canonical_days.data_type = records.data_type
    AND record_canonical_days.record_id = records.record_id
);

CREATE INDEX idx_records_effective_date_keyset
  ON records(effective_date, data_type, record_id);

CREATE INDEX idx_records_type_effective_date_keyset
  ON records(data_type, effective_date, record_id);

CREATE INDEX idx_records_synced_at
  ON records(synced_at);

-- Status reads these compact tables instead of aggregating the records table.
-- The day counter table also lets mutation triggers update distinct-day totals.
CREATE TABLE record_status (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  record_count INTEGER NOT NULL CHECK (record_count >= 0),
  day_count INTEGER NOT NULL CHECK (day_count >= 0),
  first_date TEXT,
  last_date TEXT,
  last_sync TEXT
);

CREATE TABLE record_dataset_status (
  data_type TEXT PRIMARY KEY,
  record_count INTEGER NOT NULL CHECK (record_count >= 0),
  first_date TEXT,
  last_date TEXT
);

CREATE TABLE record_day_counts (
  effective_date TEXT PRIMARY KEY,
  record_count INTEGER NOT NULL CHECK (record_count >= 0)
);

INSERT INTO record_day_counts (effective_date, record_count)
SELECT effective_date, COUNT(*) FROM records
WHERE effective_date <> '' GROUP BY effective_date;

INSERT INTO record_status (singleton, record_count, day_count, first_date, last_date, last_sync)
SELECT 1, COUNT(*), COUNT(DISTINCT NULLIF(effective_date, '')),
       MIN(NULLIF(effective_date, '')), MAX(NULLIF(effective_date, '')), MAX(synced_at)
FROM records;

INSERT INTO record_dataset_status (data_type, record_count, first_date, last_date)
SELECT data_type, COUNT(*), MIN(NULLIF(effective_date, '')), MAX(NULLIF(effective_date, ''))
FROM records GROUP BY data_type;

CREATE TRIGGER records_metadata_after_insert
AFTER INSERT ON records
BEGIN
  INSERT INTO record_day_counts (effective_date, record_count)
  SELECT NEW.effective_date, 1 WHERE NEW.effective_date <> ''
  ON CONFLICT(effective_date) DO UPDATE SET record_count = record_count + 1;

  UPDATE record_status SET
    record_count = record_count + 1,
    day_count = day_count + CASE
      WHEN NEW.effective_date <> ''
       AND (SELECT record_count FROM record_day_counts WHERE effective_date = NEW.effective_date) = 1
      THEN 1 ELSE 0 END,
    first_date = (SELECT MIN(effective_date) FROM record_day_counts),
    last_date = (SELECT MAX(effective_date) FROM record_day_counts),
    last_sync = CASE WHEN last_sync IS NULL OR NEW.synced_at > last_sync THEN NEW.synced_at ELSE last_sync END
  WHERE singleton = 1;

  INSERT INTO record_dataset_status (data_type, record_count, first_date, last_date)
  SELECT NEW.data_type, 1, NULLIF(effective_date, ''), NULLIF(effective_date, '')
  FROM records WHERE data_type = NEW.data_type AND record_id = NEW.record_id
  ON CONFLICT(data_type) DO UPDATE SET
    record_count = record_count + 1,
    first_date = CASE
      WHEN excluded.first_date IS NULL THEN first_date
      WHEN first_date IS NULL OR excluded.first_date < first_date THEN excluded.first_date
      ELSE first_date END,
    last_date = CASE
      WHEN excluded.last_date IS NULL THEN last_date
      WHEN last_date IS NULL OR excluded.last_date > last_date THEN excluded.last_date
      ELSE last_date END;
END;

CREATE TRIGGER records_metadata_after_update
AFTER UPDATE OF effective_date, synced_at ON records
WHEN OLD.effective_date IS NOT NEW.effective_date OR OLD.synced_at IS NOT NEW.synced_at
BEGIN
  UPDATE record_day_counts SET record_count = record_count - 1
  WHERE OLD.effective_date IS NOT NEW.effective_date
    AND effective_date = OLD.effective_date AND OLD.effective_date <> '';
  DELETE FROM record_day_counts WHERE record_count = 0;
  INSERT INTO record_day_counts (effective_date, record_count)
  SELECT NEW.effective_date, 1 WHERE OLD.effective_date IS NOT NEW.effective_date AND NEW.effective_date <> ''
  ON CONFLICT(effective_date) DO UPDATE SET record_count = record_count + 1;

  UPDATE record_status SET
    day_count = day_count
      - CASE WHEN OLD.effective_date IS NOT NEW.effective_date AND OLD.effective_date <> ''
              AND NOT EXISTS (SELECT 1 FROM record_day_counts WHERE effective_date = OLD.effective_date)
             THEN 1 ELSE 0 END
      + CASE WHEN OLD.effective_date IS NOT NEW.effective_date AND NEW.effective_date <> ''
              AND (SELECT record_count FROM record_day_counts WHERE effective_date = NEW.effective_date) = 1
             THEN 1 ELSE 0 END,
    first_date = (SELECT MIN(effective_date) FROM record_day_counts),
    last_date = (SELECT MAX(effective_date) FROM record_day_counts),
    last_sync = CASE
      WHEN last_sync IS NULL OR NEW.synced_at >= last_sync THEN NEW.synced_at
      WHEN OLD.synced_at = last_sync AND OLD.synced_at IS NOT NEW.synced_at THEN (SELECT MAX(synced_at) FROM records)
      ELSE last_sync END
  WHERE singleton = 1;

  UPDATE record_dataset_status SET
    first_date = (SELECT MIN(effective_date) FROM records WHERE data_type = NEW.data_type AND effective_date <> ''),
    last_date = (SELECT MAX(effective_date) FROM records WHERE data_type = NEW.data_type AND effective_date <> '')
  WHERE data_type = NEW.data_type AND OLD.effective_date IS NOT NEW.effective_date;
END;

CREATE TRIGGER records_metadata_after_delete
AFTER DELETE ON records
BEGIN
  UPDATE record_day_counts SET record_count = record_count - 1
  WHERE effective_date = OLD.effective_date AND OLD.effective_date <> '';
  DELETE FROM record_day_counts WHERE record_count = 0;

  UPDATE record_status SET
    record_count = record_count - 1,
    day_count = day_count - CASE
      WHEN OLD.effective_date <> '' AND NOT EXISTS (
        SELECT 1 FROM record_day_counts WHERE effective_date = OLD.effective_date
      ) THEN 1 ELSE 0 END,
    first_date = (SELECT MIN(effective_date) FROM record_day_counts),
    last_date = (SELECT MAX(effective_date) FROM record_day_counts),
    last_sync = (SELECT MAX(synced_at) FROM records)
  WHERE singleton = 1;

  UPDATE record_dataset_status SET
    record_count = record_count - 1,
    first_date = (SELECT MIN(effective_date) FROM records WHERE data_type = OLD.data_type AND effective_date <> ''),
    last_date = (SELECT MAX(effective_date) FROM records WHERE data_type = OLD.data_type AND effective_date <> '')
  WHERE data_type = OLD.data_type;
  DELETE FROM record_dataset_status WHERE data_type = OLD.data_type AND record_count = 0;
END;

-- Keep migration-first rollout compatible with the old Worker. It omits the
-- new column on insert and on conflict updates. UPDATE is guarded so the
-- compatibility write neither recurses nor touches already-canonical rows.
CREATE TRIGGER records_effective_date_after_insert
AFTER INSERT ON records
WHEN NEW.effective_date = ''
BEGIN
  UPDATE records SET effective_date = (
    SELECT canonical_day FROM record_canonical_days
    WHERE data_type = NEW.data_type AND record_id = NEW.record_id
  )
  WHERE data_type = NEW.data_type AND record_id = NEW.record_id;
END;

CREATE TRIGGER records_effective_date_after_update
AFTER UPDATE OF record_date, start_datetime, payload_json ON records
WHEN NEW.effective_date IS OLD.effective_date
 AND NEW.effective_date IS NOT (
   SELECT canonical_day FROM record_canonical_days
   WHERE data_type = NEW.data_type AND record_id = NEW.record_id
 )
BEGIN
  UPDATE records SET effective_date = (
    SELECT canonical_day FROM record_canonical_days
    WHERE data_type = NEW.data_type AND record_id = NEW.record_id
  )
  WHERE data_type = NEW.data_type AND record_id = NEW.record_id;
END;
