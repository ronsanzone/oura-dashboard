from __future__ import annotations

import json
import os
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable


DEFAULT_DB_PATH = Path(os.getenv("OURA_DB_PATH", "data/oura.db"))


def connect(path: str | Path = DEFAULT_DB_PATH) -> sqlite3.Connection:
    db_path = Path(path)
    db_path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(db_path)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA journal_mode=WAL")
    connection.execute("PRAGMA foreign_keys=ON")
    return connection


def initialize(connection: sqlite3.Connection) -> None:
    connection.executescript(
        """
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
        CREATE TABLE IF NOT EXISTS sync_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            started_at TEXT NOT NULL,
            finished_at TEXT,
            status TEXT NOT NULL,
            details TEXT
        );
        """
    )
    connection.commit()


def _record_id(data_type: str, item: dict[str, Any]) -> str:
    return str(
        item.get("id")
        or item.get("timestamp")
        or item.get("day")
        or item.get("start_datetime")
        or f"{data_type}-{abs(hash(json.dumps(item, sort_keys=True)))}"
    )


def upsert_records(
    connection: sqlite3.Connection,
    data_type: str,
    items: Iterable[dict[str, Any]],
) -> int:
    now = datetime.now(timezone.utc).isoformat()
    rows = []
    for item in items:
        rows.append(
            (
                data_type,
                _record_id(data_type, item),
                item.get("day") or item.get("date"),
                item.get("start_datetime") or item.get("bedtime_start") or item.get("timestamp"),
                item.get("end_datetime") or item.get("bedtime_end"),
                json.dumps(item, separators=(",", ":"), sort_keys=True),
                now,
            )
        )
    connection.executemany(
        """
        INSERT INTO records (
            data_type, record_id, record_date, start_datetime,
            end_datetime, payload_json, synced_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(data_type, record_id) DO UPDATE SET
            record_date=excluded.record_date,
            start_datetime=excluded.start_datetime,
            end_datetime=excluded.end_datetime,
            payload_json=excluded.payload_json,
            synced_at=excluded.synced_at
        """,
        rows,
    )
    connection.commit()
    return len(rows)


def load_records(
    connection: sqlite3.Connection,
    data_type: str | None = None,
    start_date: str | None = None,
    end_date: str | None = None,
) -> list[dict[str, Any]]:
    clauses, params = [], []
    if data_type:
        clauses.append("data_type = ?")
        params.append(data_type)
    if start_date:
        clauses.append("(record_date IS NULL OR record_date >= ?)")
        params.append(start_date)
    if end_date:
        clauses.append("(record_date IS NULL OR record_date <= ?)")
        params.append(end_date)
    where = " WHERE " + " AND ".join(clauses) if clauses else ""
    rows = connection.execute(
        f"SELECT data_type, payload_json FROM records{where} ORDER BY record_date, start_datetime",
        params,
    ).fetchall()
    return [dict(data_type=row["data_type"], **json.loads(row["payload_json"])) for row in rows]


def record_counts(connection: sqlite3.Connection) -> dict[str, int]:
    return {
        row["data_type"]: row["count"]
        for row in connection.execute(
            "SELECT data_type, COUNT(*) AS count FROM records GROUP BY data_type"
        )
    }


def database_status(connection: sqlite3.Connection) -> dict[str, Any]:
    row = connection.execute(
        """
        SELECT COUNT(*) AS records, COUNT(DISTINCT record_date) AS days,
               MIN(record_date) AS first_date, MAX(record_date) AS last_date,
               MAX(synced_at) AS last_sync
        FROM records
        """
    ).fetchone()
    return dict(row)
