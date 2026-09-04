import { describe, expect, it } from "vitest"
import { upsertRecords } from "../src/storage.js"
import type { AppEnv } from "../src/types.js"

class FakeStatement {
  readonly bindings: unknown[] = []

  constructor(readonly sql: string) {}

  bind(...values: unknown[]): this {
    this.bindings.push(...values)
    return this
  }
}

describe("record storage", () => {
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
