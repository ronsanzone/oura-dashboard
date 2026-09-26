import { describe, expect, it } from "vitest"
import { shiftDay } from "../src/index"
import { compareContext, contextInterval, contextPairs, stressSignal, type ContextPair } from "../src/signals"
import { contextTopics, type ContextRevision, type ContextLabels } from "../src/context"

describe("independent context evidence", () => {
  it("uses only prior 28 days, requires 14 measurements, and preserves real zero", () => {
    const points = Array.from({ length: 14 }, (_, i) => ({ day: shiftDay("2026-03-01", i), stressHours: 1 }))
    points.push({ day: "2026-01-01", stressHours: 99 }, { day: "2026-03-15", stressHours: 2 }, { day: "2026-03-16", stressHours: 99 })
    expect(stressSignal(points, "2026-03-15")).toMatchObject({ baseline: 1, n: 14, threshold: 1.5, elevated: true })
    expect(stressSignal(points.filter(p => p.day !== "2026-03-01"), "2026-03-15").threshold).toBeNull()
    expect(stressSignal([...points.filter(p => p.day !== "2026-03-15"), { day: "2026-03-15", stressHours: 0 }], "2026-03-15")).toMatchObject({ value: 0, elevated: false })
  })
  it("pairs exposure to declared next day across DST; unknown/conflicting are never controls", () => {
    const labels = Object.fromEntries(Object.keys(contextTopics).map(k => [k, "unknown"])) as ContextLabels
    const context = [{ day: "2026-03-07", version: 2, labels: { ...labels, evening_work: "present" } }, { day: "2026-03-08", version: 1, labels: { ...labels, evening_work: "absent" } }, { day: "2026-03-10", version: 1, labels: { ...labels, evening_work: "conflicting" } }] as ContextRevision[]
    const points = [{ day: "2026-03-07", stressHours: 20 }, { day: "2026-03-08", stressHours: 3 }, { day: "2026-03-09", stressHours: 0 }, { day: "2026-03-10", stressHours: 99 }]
    const pairs = contextPairs(points, context, "2026-03-07", "2026-03-10", "evening_work", 1)
    expect(pairs.map(r => [r.day, r.outcomeDay, r.value])).toEqual([["2026-03-07", "2026-03-08", 3], ["2026-03-08", "2026-03-09", 0], ["2026-03-09", "2026-03-10", 99], ["2026-03-10", "2026-03-11", undefined]])
    expect(compareContext(pairs)).toMatchObject({ present: 1, absent: 1, presentMean: 3, absentMean: 0, difference: 3, unknown: 1, conflicting: 1, missing: 1 })
    expect(contextInterval(pairs)).toBeNull()
    expect(compareContext(contextPairs(points, context, "2026-03-07", "2026-03-10", "evening_work", 0)).difference).toBe(17)
  })
  it("withholds sparse intervals and resamples paired rows with a reproducible signed difference", () => {
    const rows: ContextPair[] = Array.from({ length: 56 }, (_, i) => ({ day: shiftDay("2026-01-01", i), outcomeDay: shiftDay("2026-01-01", i), label: i % 2 ? "present" : "absent", value: i % 2 ? 4 : 1, weekend: false, travel: "unknown" }))
    // Every nonempty comparison, independently of which blocks are drawn, is 4−1=3.
    expect(contextInterval(rows)).toEqual([3, 3])
    const varying = rows.map((r, i) => ({ ...r, value: r.value! + Math.floor(i / 7) / 3 }))
    const interval = contextInterval(varying)!
    expect(interval[0]).toBeLessThan(3); expect(interval[1]).toBeGreaterThan(3)
    const translated = contextInterval(varying.map(r => ({ ...r, value: r.value! + 10 })))!
    expect(translated[0]).toBeCloseTo(interval[0], 10); expect(translated[1]).toBeCloseTo(interval[1], 10)
    expect(contextInterval(varying)).toEqual(interval)
    expect(contextInterval(rows.slice(0, 27))).toBeNull()
    expect(contextInterval(rows.map((r, i) => ({ ...r, label: i < 6 ? "absent" : "present" })))).toBeNull()
  })
})
