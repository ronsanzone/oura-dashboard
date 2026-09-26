import { shiftDay, type DailyPoint } from "./index"
import type { ContextLabel, ContextRevision, ContextTopic } from "./context"

const mean = (values: number[]) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null
export function stressSignal(points: DailyPoint[], day: string) {
  const prior = points.filter(p => p.day >= shiftDay(day, -28) && p.day < day && p.stressHours !== undefined).map(p => p.stressHours!)
  const baseline = mean(prior), value = points.find(p => p.day === day)?.stressHours
  const sd = prior.length > 1 ? Math.sqrt(prior.reduce((sum, v) => sum + (v - baseline!) ** 2, 0) / (prior.length - 1)) : null
  const threshold = baseline !== null && sd !== null && prior.length >= 14 ? baseline + Math.max(0.5, sd) : null
  return { value, baseline, sd, n: prior.length, threshold, elevated: value !== undefined && threshold !== null && value > threshold }
}
export type ContextPair = { day: string; outcomeDay: string; label: ContextLabel; value?: number; revision?: number; savedAt?: string; weekend: boolean; sleep?: number; travel: ContextLabel }
export function contextPairs(points: DailyPoint[], context: ContextRevision[], start: string, end: string, topic: ContextTopic, lag: 0 | 1): ContextPair[] {
  const p = new Map(points.map(p => [p.day, p])), c = new Map(context.map(c => [c.day, c]))
  const rows: ContextPair[] = []
  for (let day = start; day <= end; day = shiftDay(day, 1)) {
    const outcomeDay = shiftDay(day, lag), revision = c.get(day), weekday = new Date(`${day}T12:00:00Z`).getUTCDay()
    rows.push({ day, outcomeDay, label: revision?.labels[topic] ?? "unknown", value: p.get(outcomeDay)?.stressHours,
      revision: revision?.version, savedAt: revision?.savedAt, weekend: weekday === 0 || weekday === 6, sleep: p.get(day)?.totalSleepHours, travel: revision?.labels.travel ?? "unknown" })
  }
  return rows
}
export function compareContext(rows: ContextPair[]) {
  const present = rows.filter(r => r.label === "present" && r.value !== undefined).map(r => r.value!)
  const absent = rows.filter(r => r.label === "absent" && r.value !== undefined).map(r => r.value!)
  const presentMean = mean(present), absentMean = mean(absent)
  return { present: present.length, absent: absent.length, presentMean, absentMean,
    difference: presentMean !== null && absentMean !== null ? presentMean - absentMean : null,
    unknown: rows.filter(r => r.label === "unknown").length, conflicting: rows.filter(r => r.label === "conflicting").length,
    missing: rows.filter(r => r.value === undefined).length }
}
// Circular seven-calendar-day block bootstrap. Resample whole rows, including
// gaps, rather than pretending consecutive days are independent. Fixed seed
// makes rerenders reproducible, not the underlying interval universally valid.
export function contextInterval(rows: ContextPair[]): [number, number] | null {
  const summary = compareContext(rows)
  if (rows.length < 28 || summary.present < 7 || summary.absent < 7) return null
  let seed = 20260926
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296 }
  const differences: number[] = []
  for (let b = 0; b < 1000; b++) {
    const sample: ContextPair[] = []
    while (sample.length < rows.length) {
      const start = Math.floor(random() * rows.length)
      for (let j = 0; j < 7 && sample.length < rows.length; j++) sample.push(rows[(start + j) % rows.length]!)
    }
    const d = compareContext(sample).difference
    if (d !== null) differences.push(d)
  }
  if (differences.length < 900) return null
  differences.sort((a, b) => a - b)
  return [differences[Math.floor(differences.length * 0.025)]!, differences[Math.floor(differences.length * 0.975)]!]
}
