import { describe, expect, it } from "vitest"
import { buildDailyPoints, pearson, type OuraRecord } from "../src/index.js"

const record = (data_type: string, day: string, payload: Record<string, unknown>): OuraRecord => ({
  data_type,
  record_id: `${data_type}-${day}`,
  record_date: day,
  start_datetime: null,
  end_datetime: null,
  payload: { day, ...payload },
  synced_at: "2026-07-18T00:00:00Z"
})

describe("daily telemetry", () => {
  it("merges API documents and chooses the longest sleep", () => {
    const points = buildDailyPoints([
      record("daily_sleep", "2026-07-17", { score: 88, contributors: { deep_sleep: 91 } }),
      record("sleep", "2026-07-17", { total_sleep_duration: 1800, average_hrv: 10 }),
      record("sleep", "2026-07-17", { total_sleep_duration: 25200, average_hrv: 42, deep_sleep_duration: 5400 }),
      record("daily_activity", "2026-07-17", { score: 90, steps: 12345 })
    ])

    expect(points).toHaveLength(1)
    expect(points[0]).toMatchObject({ sleepScore: 88, averageHrv: 42, totalSleepHours: 7, steps: 12345 })
    expect(points[0]?.["sleepContributor.deep_sleep"]).toBe(91)
  })

  it("computes Pearson correlation only with sufficient overlap", () => {
    expect(pearson([1, 2, 3], [2, 4, 6])).toBeCloseTo(1)
    expect(pearson([1, undefined], [2, 4])).toBeUndefined()
  })
})
