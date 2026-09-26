import { describe, expect, it } from "vitest"
import { experimentEvidence, summarizeExperiment, validateExperiment, validExperimentDay, type Experiment } from "../src/experiments"
import type { OuraRecord } from "../src/index"

export const plan: Experiment = { question: "Does dinner timing change HRV?", habit: "Dinner before 7", primary: "averageHrv", supporting: ["stressHours"], rules: { followed: "Before 7", partly: "7–8", not_followed: "After 8" }, beforeStart: "2026-03-06", beforeEnd: "2026-03-07", start: "2026-03-08", end: "2026-03-11", afterStart: "2026-03-12", afterEnd: "2026-03-12", alignment: 1, state: "active", checkIns: {}, conclusion: "", revisionNote: "Initial plan" }
const record = (day: string, value: number): OuraRecord => ({ data_type: "sleep", record_id: day, record_date: day, start_datetime: null, end_datetime: null, synced_at: "2026-03-12T12:00:00Z", payload: { day, average_hrv: value, total_sleep_duration: 20000 } })

describe("experiment evidence", () => {
  it("pairs exposure with next calendar day across DST, retaining absent/partial/excluded and pending days", () => {
    const e = structuredClone(plan)
    e.checkIns = { "2026-03-08": { adherence: "followed", note: "", exclusion: "" }, "2026-03-09": { adherence: "partly", note: "travel", exclusion: "Travel" }, "2026-03-10": { adherence: "not_followed", note: "", exclusion: "" } }
    const rows = [record("2026-03-08", 11), record("2026-03-09", 71), record("2026-03-10", 999), record("2026-03-12", 0), { ...record("2026-03-08", 0), data_type: "tag", payload: { start_day: "2026-03-08", comment: "Walk" } }]
    const evidence = experimentEvidence(e, rows, "2026-03-12T16:00:00Z")
    const during = evidence.days.filter(d => d.period === "During")
    expect(during[0]).toMatchObject({ day: "2026-03-08", outcomeDay: "2026-03-09", values: { averageHrv: 71 }, context: ["Walk"] })
    expect(during[3]?.checkIn.adherence).toBe("unknown")
    expect(summarizeExperiment(during, "averageHrv")).toEqual({ planned: 4, pending: 0, excluded: 1, missing: 1, n: 2, mean: 35.5 })
    expect(summarizeExperiment(evidence.days.filter(d => d.period === "After"), "averageHrv")).toMatchObject({ pending: 1, missing: 0, n: 0, mean: null })
    const sameDay = experimentEvidence({ ...e, alignment: 0 }, rows, "2026-03-12T16:00:00Z")
    expect(sameDay.days.find(d => d.day === "2026-03-08")?.values.averageHrv).toBe(11)
  })
  it("converts daily stress seconds to hours without inferring an intraday event", () => {
    const row = { ...record("2026-03-09", 0), data_type: "daily_stress", payload: { day: "2026-03-09", stress_high: 5400 } }
    expect(experimentEvidence(plan, [row], "2026-03-12T16:00:00Z").days.find(d => d.day === "2026-03-08")?.values.stressHours).toBe(1.5)
  })
  it("rejects overlapping windows, unknown metrics, invalid dates, future check-ins and lost logged days", () => {
    expect(validateExperiment(plan, "2026-03-12")).toEqual(plan)
    expect(validExperimentDay("2026-02-30")).toBe(false)
    expect(validExperimentDay("2026-99-01")).toBe(false)
    expect(() => validateExperiment({ ...plan, checkIns: { "2026-03-08": { adherence: "followed", note: "", exclusion: "   " } } }, "2026-03-12")).toThrow("visible reason")
    for (const patch of [ { beforeEnd: plan.start }, { afterEnd: "" }, { primary: "invented" }, { supporting: [plan.primary] }, { alignment: 2 }, { beforeStart: "2020-01-01" }, { checkIns: { "2026-03-13": { adherence: "unknown", note: "", exclusion: "" } } }, { start: "2026-03-10", checkIns: { "2026-03-08": { adherence: "followed", note: "", exclusion: "" } } } ]) {
      expect(() => validateExperiment({ ...plan, ...patch }, "2026-03-12")).toThrow()
    }
  })
})
