import { describe, expect, it, vi } from "vitest"
import { baselineFor, buildDailyPoints, dayStart, effectiveDay, indexRecordRange, indexRecords, localDay, mainSleep, pearson, recordLocalDay, recordsOfTypes, type OuraRecord } from "../src/index.js"

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
    expect(localDay(new Date("2026-03-08T04:59:59Z"))).toBe("2026-03-07")
    expect(localDay(new Date("2026-03-09T03:59:59Z"))).toBe("2026-03-08")
    expect(localDay(new Date("2026-11-02T04:59:59Z"))).toBe("2026-11-01")
    expect(dayStart("2026-03-08")).toBe("2026-03-08T05:00:00.000Z")
    expect(dayStart("2026-03-09")).toBe("2026-03-09T04:00:00.000Z")
    expect(dayStart("2026-11-01")).toBe("2026-11-01T04:00:00.000Z")
    expect(dayStart("2026-11-02")).toBe("2026-11-02T05:00:00.000Z")
  })

  it("uses one canonical day precedence and converts fallback instants to Eastern", () => {
    const conflicting = record("daily_activity", "2026-09-23", { day: "2026-09-20", start_day: "2026-09-21", date: "2026-09-22", steps: 10 })
    expect(effectiveDay(conflicting)).toBe("2026-09-20")
    expect(buildDailyPoints([conflicting])).toEqual([expect.objectContaining({ day: "2026-09-20", steps: 10 })])
    expect(effectiveDay({ payload: {}, record_date: null, start_datetime: "2026-09-20T03:59:59Z" })).toBe("2026-09-19")
    expect(effectiveDay({ payload: { timestamp: "2026-09-20T00:30:00+02:00" }, record_date: null, start_datetime: null })).toBe("2026-09-19")
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

describe("record index", () => {
  const timedRecord = (id: string, data_type: string, start_datetime: string | null, payload: Record<string, unknown> = {}): OuraRecord => ({
    data_type,
    record_id: id,
    record_date: null,
    start_datetime,
    end_datetime: null,
    payload,
    synced_at: "2026-07-18T00:00:00Z"
  })

  it("resolves explicit dates before timestamps and uses Eastern time at DST boundaries", () => {
    expect(recordLocalDay(timedRecord("explicit", "tag", "2026-03-08T04:30:00Z", { day: "2026-03-09", start_day: "2026-03-10" }))).toBe("2026-03-09")
    expect(recordLocalDay(timedRecord("start-day", "tag", "2026-03-08T04:30:00Z", { start_day: "2026-03-08" }))).toBe("2026-03-08")
    expect(recordLocalDay({ ...timedRecord("record-date", "sleep", "2026-03-08T04:30:00Z"), record_date: "2026-03-07" })).toBe("2026-03-07")
    expect(recordLocalDay(timedRecord("spring-before-midnight", "heart_rate", "2026-03-08T04:30:00Z"))).toBe("2026-03-07")
    expect(recordLocalDay(timedRecord("spring-after-midnight", "heart_rate", "2026-03-08T05:30:00Z"))).toBe("2026-03-08")
    expect(recordLocalDay(timedRecord("fall-before-midnight", "heart_rate", "2026-11-02T04:30:00Z"))).toBe("2026-11-01")
    expect(recordLocalDay(timedRecord("fall-after-midnight", "heart_rate", "2026-11-02T05:30:00Z"))).toBe("2026-11-02")
  })

  it("indexes day and type once, preserves source order, and reuses the derivation for ranges", () => {
    const before = timedRecord("before", "heart_rate", "2026-03-08T04:30:00Z")
    const tag = timedRecord("tag", "tag", null, { start_day: "2026-03-08" })
    const after = timedRecord("after", "heart_rate", "2026-03-08T05:30:00Z")
    const unknown = timedRecord("unknown", "workout", null)
    const index = indexRecords([before, tag, after, unknown])

    expect(index.byDay.get("2026-03-07")).toEqual([before])
    expect(index.byDayAndType.get("2026-03-08")?.get("heart_rate")).toEqual([after])
    expect(index.byType.get("heart_rate")).toEqual([before, after])
    expect(recordsOfTypes(index, ["tag", "heart_rate"])).toEqual([before, tag, after])

    before.start_datetime = "2026-12-31T12:00:00Z"
    before.data_type = "changed"
    const range = indexRecordRange(index, "2026-03-07", "2026-03-08")
    expect(range.records).toEqual([before, tag, after])
    expect(range.dayByRecord.get(before)).toBe("2026-03-07")
    expect(range.byType.get("heart_rate")).toEqual([before, after])
    expect(range.byType.has("changed")).toBe(false)
  })

  it("reuses initialized Intl formatters while deriving and indexing records", () => {
    const constructor = vi.spyOn(Intl, "DateTimeFormat")
    try {
      const records = Array.from({ length: 20 }, (_, index) =>
        timedRecord(String(index), "heart_rate", `2026-03-08T${String(index).padStart(2, "0")}:30:00Z`))
      const index = indexRecords(records)
      indexRecordRange(index, "2026-03-07", "2026-03-08")
      dayStart("2026-03-08")
      expect(constructor).not.toHaveBeenCalled()
    } finally {
      constructor.mockRestore()
    }
  })
})
