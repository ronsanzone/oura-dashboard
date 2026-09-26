import { describe, expect, it } from "vitest"
import { records, status, upsertRecords } from "../src/storage.js"
import type { AppEnv } from "../src/types.js"
import { DatabaseSync } from "node:sqlite"
import { readFileSync } from "node:fs"

class FakeStatement {
  readonly bindings: unknown[] = []

  constructor(readonly sql: string) {}

  bind(...values: unknown[]): this {
    this.bindings.push(...values)
    return this
  }
}

describe("record storage", () => {
  const database = () => {
    const db = new DatabaseSync(":memory:")
    db.exec(readFileSync(new URL("../../../migrations/0001_initial.sql", import.meta.url), "utf8"))
    const env = { DEPLOYMENT_MODE: "local", DB: { prepare(sql: string) {
      const statement = db.prepare(sql)
      let bindings: (string | number | null)[] = []
      return { bind(...values: typeof bindings) { bindings = values; return this },
        async all() { return { results: statement.all(...bindings) } },
        async first() { return statement.get(...bindings) ?? null }
      }
    } } } as unknown as AppEnv
    const insert = (id: string, date: string | null, start: string | null, payload = {}) => db.prepare("INSERT INTO records VALUES ('heart_rate', ?, ?, ?, NULL, ?, '2026-09-26T00:00:00Z')").run(id, date, start, JSON.stringify(payload))
    return { db, env, insert }
  }

  it("filters null dates by instant with exclusive Eastern end boundary, rather than leaking all HR", async () => {
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
      let offset: number | null = 0
      while (offset !== null) {
        const page = await records(env, { start: "2026-09-20", end: "2026-09-20", offset })
        expect(page.records.length).toBeLessThanOrEqual(2000)
        ids.push(...page.records.map((r) => r.record_id)); offset = page.nextOffset
      }
      expect(ids.length).toBe(25003)
      expect(new Set(ids).size).toBe(25003)
    } finally { db.close() }
  })

  it("reports partial sync issues independently of record freshness", async () => {
    const { db, env, insert } = database()
    try {
      insert("old", "2026-09-20", null)
      db.prepare("INSERT INTO sync_log (started_at, finished_at, status, details) VALUES (?, ?, ?, ?)")
        .run("2026-09-26T12:00:00Z", "2026-09-26T12:01:00Z", "partial", JSON.stringify({ skipped: { heart_rate: "HTTP 403" } }))
      const result = await status(env)
      expect(result.connected).toBe(false)
      expect(result.sync).toMatchObject({ status: "partial", skipped: { heart_rate: "HTTP 403" } })
      expect(result.last_sync).toBe("2026-09-26T00:00:00Z")
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

    await upsertRecords(env, "daily_sleep", [{ id: "sleep-1", day: "2026-09-04", score: 90 }])

    expect(statements[0]?.sql).toContain("WHERE records.payload_json IS NOT excluded.payload_json")
  })
})
