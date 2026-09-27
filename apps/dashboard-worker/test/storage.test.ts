import { describe, expect, it } from "vitest"
import { dailySummaries, InvalidRecordsCursorError, records, selectedDay, status, upsertRecords } from "../src/storage.js"
import type { AppEnv } from "../src/types.js"
import { DatabaseSync } from "node:sqlite"
import { readFileSync } from "node:fs"
import { effectiveDay } from "@oura/shared"

class FakeStatement {
  readonly bindings: unknown[] = []

  constructor(readonly sql: string) {}

  bind(...values: unknown[]): this {
    this.bindings.push(...values)
    return this
  }
}

describe("record storage", () => {
  const initialMigration = readFileSync(new URL("../../../migrations/0001_initial.sql", import.meta.url), "utf8")
  const effectiveDateMigration = readFileSync(new URL("../../../migrations/0005_records_effective_date.sql", import.meta.url), "utf8")
  const database = () => {
    const db = new DatabaseSync(":memory:")
    db.exec(initialMigration)
    db.exec(effectiveDateMigration)
    const queries: string[] = []
    const env = { DEPLOYMENT_MODE: "local", DB: { prepare(sql: string) {
      queries.push(sql)
      const statement = db.prepare(sql)
      let bindings: (string | number | null)[] = []
      return { bind(...values: typeof bindings) { bindings = values; return this },
        async all() { return { results: statement.all(...bindings) } },
        async first() { return statement.get(...bindings) ?? null }
      }
    } } } as unknown as AppEnv
    const insert = (id: string, date: string | null, start: string | null, payload: Record<string, unknown> = {}, type = "heart_rate") => {
      const timestamp = start ?? [payload.timestamp, payload.bedtime_start].find((value): value is string => typeof value === "string") ?? null
      const effective = effectiveDay({ record_date: date, start_datetime: timestamp, payload })
      db.prepare(`INSERT INTO records (
        data_type, record_id, record_date, start_datetime, end_datetime, payload_json, synced_at, effective_date
      ) VALUES (?, ?, ?, ?, NULL, ?, '2026-09-26T00:00:00Z', ?)`)
        .run(type, id, date, start, JSON.stringify(payload), effective)
    }
    return { db, env, insert, queries }
  }

  it("filters on materialized Eastern effective dates rather than leaking unrelated HR", async () => {
    const { db, env, insert } = database()
    try {
      insert("before", null, "2026-09-20T03:59:59Z")
      insert("start", null, "2026-09-20T00:00:00-04:00")
      insert("payload", null, null, { timestamp: "2026-09-26T23:59:59-04:00" })
      insert("after", null, "2026-09-27T04:00:00Z")
      insert("undated", null, null)
      insert("daily", "2026-09-20", "2026-09-19T23:00:00Z")
      insert("tag", null, null, { start_day: "2026-09-21" })
      expect((await records(env, { start: "2026-09-20", end: "2026-09-26" })).records.map((r) => r.record_id).sort()).toEqual(["daily", "payload", "start", "tag"])
    } finally { db.close() }
  })

  it("returns every record across pages, beyond the old silent 25k cap", async () => {
    const { db, env, insert } = database()
    try {
      db.exec("BEGIN")
      for (let i = 0; i < 25003; i++) insert(String(i), null, "2026-09-20T12:00:00Z")
      db.exec("COMMIT")
      const ids: string[] = []
      let cursor: string | null = null
      do {
        const page = await records(env, { start: "2026-09-20", end: "2026-09-20", cursor: cursor ?? undefined })
        expect(page.records.length).toBeLessThanOrEqual(2000)
        ids.push(...page.records.map((r) => r.record_id)); cursor = page.nextCursor
      } while (cursor !== null)
      expect(ids.length).toBe(25003)
      expect(new Set(ids).size).toBe(25003)
    } finally { db.close() }
  }, 30_000)

  it("advances across empty filtered keyset pages before returning valid rows", async () => {
    const { db, env } = database()
    try {
      const insert = db.prepare(`INSERT INTO records (
        data_type, record_id, record_date, start_datetime, end_datetime, payload_json, synced_at, effective_date
      ) VALUES ('heart_rate', ?, NULL, ?, NULL, '{}', '2026-09-26T00:00:00Z', ?)`)
      db.exec("BEGIN")
      for (let i = 0; i < 2001; i++) insert.run(`excluded-${String(i).padStart(4, "0")}`, "2026-09-19T03:00:00Z", "2026-09-19")
      insert.run("valid", "2026-09-20T12:00:00-04:00", "2026-09-20")
      db.exec("COMMIT")

      const first = await records(env, { start: "2026-09-20", end: "2026-09-20" })
      expect(first.records).toEqual([])
      expect(first.nextCursor).not.toBeNull()
      const second = await records(env, { start: "2026-09-20", end: "2026-09-20", cursor: first.nextCursor! })
      expect(second.records.map((record) => record.record_id)).toEqual(["valid"])
      expect(second.nextCursor).toBeNull()
    } finally { db.close() }
  })

  it("uses an exclusive keyset boundary and rejects malformed cursors", async () => {
    const { db, env, insert } = database()
    try {
      db.exec("BEGIN")
      for (let i = 0; i < 2002; i++) insert(String(i).padStart(4, "0"), "2026-09-20", null)
      db.exec("COMMIT")
      const first = await records(env, { start: "2026-09-20", end: "2026-09-20" })
      const second = await records(env, { start: "2026-09-20", end: "2026-09-20", cursor: first.nextCursor! })
      expect(first.records).toHaveLength(2000)
      expect(second.records.map((record) => record.record_id)).toEqual(["2000", "2001"])
      expect(second.nextCursor).toBeNull()
      await expect(records(env, { cursor: "not-a-cursor" })).rejects.toBeInstanceOf(InvalidRecordsCursorError)
    } finally { db.close() }
  })

  it("returns compact daily values with gaps omitted and bounds selected-day detail", async () => {
    const { db, env, insert } = database()
    try {
      insert("sleep-short", "2026-09-20", "2026-09-20T01:00:00-04:00", { day: "2026-09-20", total_sleep_duration: 1800, average_hrv: 10 }, "sleep")
      insert("sleep-main", "2026-09-20", "2026-09-19T23:00:00-04:00", { day: "2026-09-20", bedtime_end: "2026-09-20T06:30:00-04:00", total_sleep_duration: 25200, average_hrv: 42 }, "sleep")
      insert("activity", "2026-09-20", null, { day: "2026-09-20", steps: 0 }, "daily_activity")
      insert("hr-prior-evening", null, "2026-09-19T19:00:00-04:00", { bpm: 61 }, "heart_rate")
      insert("hr-selected", null, "2026-09-20T12:00:00-04:00", { bpm: 75 }, "heart_rate")
      insert("hr-old", null, "2026-09-18T12:00:00-04:00", { bpm: 80 }, "heart_rate")

      const summary = await dailySummaries(env, { start: "2026-09-19", end: "2026-09-20" })
      expect(summary.days).toEqual([expect.objectContaining({ day: "2026-09-20", averageHrv: 42, totalSleepHours: 7, steps: 0, bedtimeStart: "2026-09-19T23:00:00-04:00" })])
      expect(summary.days[0]).not.toHaveProperty("sleepScore")
      const detail = await selectedDay(env, "2026-09-20")
      expect(detail.records.map((record) => record.record_id)).toEqual(expect.arrayContaining(["hr-prior-evening", "hr-selected", "sleep-main", "activity"]))
      expect(detail.records.map((record) => record.record_id)).not.toContain("hr-old")
    } finally { db.close() }
  })

  it("backfills canonical days, keeps old-writer updates compatible and installs indexes", () => {
    const db = new DatabaseSync(":memory:")
    try {
      db.exec(initialMigration)
      db.prepare("INSERT INTO records VALUES (?, ?, ?, ?, ?, ?, ?)").run("daily_sleep", "daily", "2026-09-20", null, null, "{}", "2026-09-20T12:00:00Z")
      db.prepare("INSERT INTO records VALUES (?, ?, ?, ?, ?, ?, ?)").run("heart_rate", "hr", null, "2026-09-19T23:30:00-04:00", null, "{}", "2026-09-20T12:00:00Z")
      db.prepare("INSERT INTO records VALUES (?, ?, ?, ?, ?, ?, ?)").run("daily_activity", "conflict", "2026-09-23", null, null, JSON.stringify({ day: "2026-09-20", start_day: "2026-09-21", date: "2026-09-22" }), "2026-09-20T12:00:00Z")
      db.prepare("INSERT INTO records VALUES (?, ?, ?, ?, ?, ?, ?)").run("heart_rate", "utc", null, "2026-09-20T03:59:59Z", null, "{}", "2026-09-20T12:00:00Z")
      db.prepare("INSERT INTO records VALUES (?, ?, ?, ?, ?, ?, ?)").run("heart_rate", "offset", null, "2026-09-20T00:30:00+02:00", null, "{}", "2026-09-20T12:00:00Z")
      db.exec(effectiveDateMigration)
      db.prepare(`INSERT INTO records (
        data_type, record_id, record_date, start_datetime, end_datetime, payload_json, synced_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run("daily_activity", "legacy-write", "2026-09-21", null, null, "{}", "2026-09-21T12:00:00Z")
      expect(db.prepare("SELECT record_id, effective_date FROM records ORDER BY record_id").all()).toEqual([
        { record_id: "conflict", effective_date: "2026-09-20" },
        { record_id: "daily", effective_date: "2026-09-20" },
        { record_id: "hr", effective_date: "2026-09-19" },
        { record_id: "legacy-write", effective_date: "2026-09-21" },
        { record_id: "offset", effective_date: "2026-09-19" },
        { record_id: "utc", effective_date: "2026-09-19" }
      ])

      db.prepare(`INSERT INTO records (
        data_type, record_id, record_date, start_datetime, end_datetime, payload_json, synced_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(data_type, record_id) DO UPDATE SET
        record_date = excluded.record_date,
        start_datetime = excluded.start_datetime,
        end_datetime = excluded.end_datetime,
        payload_json = excluded.payload_json,
        synced_at = excluded.synced_at`)
        .run("daily_activity", "legacy-write", "2026-09-30", null, null, JSON.stringify({ day: "2026-09-24", start_day: "2026-09-25" }), "2026-09-27T12:00:00Z")
      expect(db.prepare("SELECT effective_date FROM records WHERE record_id = 'legacy-write'").get()).toEqual({ effective_date: "2026-09-24" })
      expect(db.prepare("SELECT record_count, day_count, first_date, last_date, last_sync FROM record_status").get()).toEqual({
        record_count: 6, day_count: 3, first_date: "2026-09-19", last_date: "2026-09-24", last_sync: "2026-09-27T12:00:00Z"
      })
      expect(db.prepare("SELECT record_count, first_date, last_date FROM record_dataset_status WHERE data_type = 'daily_activity'").get()).toEqual({
        record_count: 2, first_date: "2026-09-20", last_date: "2026-09-24"
      })
      db.prepare(`INSERT INTO records (
        data_type, record_id, record_date, start_datetime, end_datetime, payload_json, synced_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(data_type, record_id) DO UPDATE SET
        record_date = excluded.record_date,
        start_datetime = excluded.start_datetime,
        end_datetime = excluded.end_datetime,
        payload_json = excluded.payload_json,
        synced_at = excluded.synced_at`)
        .run("daily_activity", "legacy-write", "2026-09-30", null, null, JSON.stringify({ day: "2026-09-24", score: 80 }), "2026-09-28T12:00:00Z")
      expect(db.prepare("SELECT record_count, day_count, last_sync FROM record_status").get()).toEqual({
        record_count: 6, day_count: 3, last_sync: "2026-09-28T12:00:00Z"
      })
      const indexes = db.prepare("PRAGMA index_list(records)").all().map((row) => String(row.name))
      expect(indexes).toEqual(expect.arrayContaining(["idx_records_effective_date_keyset", "idx_records_type_effective_date_keyset", "idx_records_synced_at"]))
      const plan = db.prepare(`EXPLAIN QUERY PLAN
        SELECT data_type, record_id FROM records
        WHERE effective_date >= ? AND effective_date <= ?
        ORDER BY effective_date, data_type, record_id LIMIT 2001
      `).all("2026-09-01", "2026-09-30").map((row) => String(row.detail)).join("\n")
      expect(plan).toContain("idx_records_effective_date_keyset")
      expect(plan).not.toContain("USE TEMP B-TREE")

      db.prepare("DELETE FROM records WHERE data_type = 'daily_activity' AND record_id = 'legacy-write'").run()
      expect(db.prepare("SELECT record_count, day_count, first_date, last_date, last_sync FROM record_status").get()).toEqual({
        record_count: 5, day_count: 2, first_date: "2026-09-19", last_date: "2026-09-20", last_sync: "2026-09-20T12:00:00Z"
      })
      expect(db.prepare("SELECT record_count, first_date, last_date FROM record_dataset_status WHERE data_type = 'daily_activity'").get()).toEqual({
        record_count: 1, first_date: "2026-09-20", last_date: "2026-09-20"
      })
    } finally { db.close() }
  })

  it("reports partial sync issues independently of record freshness", async () => {
    const { db, env, insert, queries } = database()
    try {
      insert("old", "2026-09-20", null)
      db.prepare("INSERT INTO sync_log (started_at, finished_at, status, details) VALUES (?, ?, ?, ?)")
        .run("2026-09-26T12:00:00Z", "2026-09-26T12:01:00Z", "partial", JSON.stringify({ skipped: { heart_rate: "HTTP 403" } }))
      const result = await status(env)
      expect(result.connected).toBe(false)
      expect(result.sync).toMatchObject({ status: "partial", skipped: { heart_rate: "HTTP 403" } })
      expect(result.last_sync).toBe("2026-09-26T00:00:00Z")
      expect(result).toMatchObject({ records: 1, days: 1, first_date: "2026-09-20", last_date: "2026-09-20" })
      expect(result.datasets).toEqual([{ data_type: "heart_rate", count: 1, first_date: "2026-09-20", last_date: "2026-09-20" }])
      expect(queries.every((sql) => !/\bFROM\s+records\b/i.test(sql))).toBe(true)
      const statusPlan = db.prepare("EXPLAIN QUERY PLAN SELECT record_count FROM record_status WHERE singleton = 1").all()
        .map((row) => String(row.detail)).join("\n")
      const datasetsPlan = db.prepare("EXPLAIN QUERY PLAN SELECT data_type FROM record_dataset_status ORDER BY data_type").all()
        .map((row) => String(row.detail)).join("\n")
      expect(statusPlan).toContain("INTEGER PRIMARY KEY")
      expect(datasetsPlan).toContain("record_dataset_status")
      expect(datasetsPlan).not.toContain("records")
    } finally { db.close() }
  })

  it("guards conflict updates when the payload is unchanged", async () => {
    const statements: FakeStatement[] = []
    const env = {
      DB: {
        prepare(sql: string): FakeStatement {
          const statement = new FakeStatement(sql)
          statements.push(statement)
          return statement
        },
        batch(): Promise<unknown[]> {
          return Promise.resolve([])
        }
      }
    } as unknown as AppEnv

    await upsertRecords(env, "daily_sleep", [{ id: "sleep-1", day: "2026-09-04", start_day: "2026-09-05", date: "2026-09-06", score: 90 }])

    expect(statements[0]?.sql).toContain("WHERE records.payload_json IS NOT excluded.payload_json")
    expect(statements[0]?.bindings[2]).toBe("2026-09-04")
    expect(statements[0]?.bindings.at(-1)).toBe("2026-09-04")
  })
})
