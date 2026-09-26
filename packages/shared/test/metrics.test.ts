import { describe, expect, it } from "vitest"
import { baselineFor, buildDailyPoints, dayStart, localDay, mainSleep, pearson, type OuraRecord } from "../src/index.js"

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
  it("uses Eastern calendar dates and handles 23/25-hour DST days", () => {
    expect(localDay(new Date("2026-09-26T02:00:00Z"))).toBe("2026-09-25")
    expect(dayStart("2026-03-08")).toBe("2026-03-08T05:00:00.000Z")
    expect(dayStart("2026-03-09")).toBe("2026-03-09T04:00:00.000Z")
    expect(dayStart("2026-11-01")).toBe("2026-11-01T04:00:00.000Z")
    expect(dayStart("2026-11-02")).toBe("2026-11-02T05:00:00.000Z")
  })

  it("excludes the selected day, future days and old history from a sparse baseline", () => {
    const points = [
      { day: "2026-08-28", averageHrv: 999 },
      ...Array.from({ length: 7 }, (_, i) => ({ day: `2026-09-0${i + 1}`, averageHrv: 30 + i * 2 })),
      { day: "2026-09-09" }, { day: "2026-09-26", averageHrv: 200 }, { day: "2026-09-27", averageHrv: 888 }
    ]
    expect(baselineFor(points, "2026-09-26", "averageHrv")).toEqual({ count: 7, mean: 36 })
    expect(baselineFor(points.slice(2), "2026-09-26", "averageHrv")).toEqual({ count: 6, mean: undefined })
  })

  it("uses the longest sleep even when a later nap appears last", () => {
    const night = record("sleep", "2026-09-26", { total_sleep_duration: 25200, average_hrv: 52 })
    const nap = record("sleep", "2026-09-26", { total_sleep_duration: 1800, average_hrv: 15 })
    expect(mainSleep([night, nap])).toBe(night)
    expect(buildDailyPoints([night, nap])[0]?.averageHrv).toBe(52)
    expect(mainSleep([])).toBeUndefined()
  })

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
