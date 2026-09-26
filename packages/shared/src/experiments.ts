import { buildDailyPoints, localDay, shiftDay, type DailyPoint, type OuraRecord } from "./index"
import type { ContextLabels, ContextProposal } from "./context"

export const experimentMetrics = {
  sleepEfficiency: ["Sleep efficiency", "%", "percentage points"],
  totalSleepHours: ["Main sleep", "h", "h"], averageHrv: ["Overnight HRV", "ms", "ms"],
  lowestHeartRate: ["Lowest sleeping HR", "bpm", "bpm"], averageHeartRate: ["Average sleeping HR", "bpm", "bpm"],
  stressHours: ["Daily high-stress time", "h/day", "h/day"], recoveryHours: ["Daily recovery", "h/day", "h/day"],
  steps: ["Steps", "steps", "steps"], activeCalories: ["Active energy", "kcal", "kcal"],
  sleepScore: ["Sleep score", "/100", "points"], readinessScore: ["Readiness", "/100", "points"],
  activityScore: ["Activity score", "/100", "points"], respiratoryRate: ["Respiratory rate", "breaths/min", "breaths/min"],
  temperatureDeviation: ["Temperature deviation", "°C", "°C"], deepSleepHours: ["Deep sleep", "h", "h"],
  remSleepHours: ["REM sleep", "h", "h"], lightSleepHours: ["Light sleep", "h", "h"], awakeHours: ["Awake", "h", "h"],
  sleepLatencyMinutes: ["Sleep latency", "min", "min"], sedentaryHours: ["Sedentary time", "h", "h"],
  lowActivityHours: ["Light activity", "h", "h"], mediumActivityHours: ["Moderate activity", "h", "h"],
  highActivityHours: ["Vigorous activity", "h", "h"], averageSpo2: ["SpO₂", "%", "percentage points"],
  breathingDisturbanceIndex: ["Breathing disturbance", "index", "index"], vascularAge: ["Cardiovascular age", "years", "years"],
  pulseWaveVelocity: ["Pulse-wave velocity", "m/s", "m/s"], vo2Max: ["VO₂ max", "ml/kg/min", "ml/kg/min"]
} as const satisfies Partial<Record<keyof DailyPoint, readonly string[]>>
export type ExperimentMetric = keyof typeof experimentMetrics
export const adherenceStates = ["followed", "partly", "not_followed", "unknown"] as const
export type Adherence = typeof adherenceStates[number]
export const adherenceLabels: Record<Adherence, string> = { followed: "Followed", partly: "Partly followed", not_followed: "Not followed", unknown: "Unknown" }
export type ClassificationReceipt = Pick<ContextProposal, "id" | "model" | "rubricVersion" | "sourceHash" | "createdAt">
export type CheckIn = { adherence: Adherence; note: string; exclusion: string;
  context?: { day: string; version: number }; classificationId?: string;
  provenance?: { context?: { labels: ContextLabels; source: ClassificationReceipt }; adherence?: { proposed: Adherence; source: ClassificationReceipt; planVersion: number } } }
export type Experiment = {
  question: string; habit: string; primary: ExperimentMetric; supporting: ExperimentMetric[];
  rules: { followed: string; partly: string; not_followed: string };
  beforeStart: string; beforeEnd: string; start: string; end: string; afterStart: string; afterEnd: string;
  alignment: 0 | 1; state: "draft" | "active" | "paused" | "finished";
  checkIns: Record<string, CheckIn>; conclusion: string; revisionNote: string;
}
export type ExperimentRevision = { id: string; version: number; savedAt: string; experiment: Experiment }
export type EvidenceDay = { day: string; outcomeDay: string; period: "Before" | "During" | "After"; pending: boolean; checkIn: CheckIn; values: Partial<Record<ExperimentMetric, number>>; context: string[] }
export type ExperimentEvidence = { asOf: string; sourceUpdatedAt: string | null; days: EvidenceDay[] }
export type ExperimentSnapshot = { id: string; savedAt: string; revision: ExperimentRevision; evidence: ExperimentEvidence }
export const validExperimentDay = (day: unknown): day is string => typeof day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(day) && Number.isFinite(Date.parse(`${day}T12:00:00Z`)) && new Date(`${day}T12:00:00Z`).toISOString().slice(0, 10) === day

// Validate the persisted contract, not only the form. Reject silent loss of check-ins on date edits.
export function validateExperiment(value: unknown, today = localDay(new Date())): Experiment {
  const e = value as Experiment
  const fail = (message: string): never => { throw new Error(message) }
  const text = (s: unknown, max: number, required = false) => typeof s === "string" && s.length <= max && (!required || !!s.trim())
  if (!e || typeof e !== "object" || !text(e.question, 200, true) || !text(e.habit, 1000, true)) fail("Add a question and a concrete habit (200 / 1,000 characters maximum).")
  if (!Object.hasOwn(experimentMetrics, e.primary) || !Array.isArray(e.supporting) || e.supporting.length > 4 || e.supporting.some(k => !Object.hasOwn(experimentMetrics, k) || k === e.primary) || new Set(e.supporting).size !== e.supporting.length) fail("Choose one primary outcome and up to four different supporting measures.")
  if (!["draft", "active", "paused", "finished"].includes(e.state) || ![0, 1].includes(e.alignment)) fail("Invalid lifecycle or date alignment.")
  if (!e.rules || [e.rules.followed, e.rules.partly, e.rules.not_followed].some(s => !text(s, 500, true))) fail("Define all three adherence rules (500 characters each maximum).")
  if (![e.beforeStart, e.beforeEnd, e.start, e.end].every(validExperimentDay) || e.beforeStart > e.beforeEnd || e.beforeEnd >= e.start || e.start > e.end) fail("Use valid, non-overlapping Before and During windows.")
  if (e.afterStart !== "" || e.afterEnd !== "") {
    if (!validExperimentDay(e.afterStart) || !validExperimentDay(e.afterEnd) || e.afterStart <= e.end || e.afterStart > e.afterEnd) fail("Follow-up needs two valid dates after the experiment.")
  }
  if ((Date.parse(e.afterEnd || e.end) - Date.parse(e.beforeStart)) / 86400000 > 365) fail("The complete notebook window must fit within 366 calendar days.")
  if (!text(e.conclusion, 4000) || !text(e.revisionNote, 500, true)) fail("Add a revision note; conclusion limit is 4,000 characters.")
  if (!e.checkIns || typeof e.checkIns !== "object" || Array.isArray(e.checkIns) || Object.keys(e.checkIns).length > 366) fail("Invalid daily check-ins.")
  for (const [day, c] of Object.entries(e.checkIns)) {
    const inWindow = (day >= e.beforeStart && day <= e.beforeEnd) || (day >= e.start && day <= e.end) || (e.afterStart && day >= e.afterStart && day <= e.afterEnd)
    if (!validExperimentDay(day) || !inWindow || day > today || !c || !adherenceStates.includes(c.adherence) || !text(c.note, 2000) || !text(c.exclusion, 500)) fail("Check-ins must be valid elapsed days inside your windows. Preserve logged days when revising dates.")
    if (c.exclusion && !c.exclusion.trim()) fail("An exclusion needs a visible reason, not whitespace. Clear the field to include the day.")
    if (c.context && (c.context.day !== day || !Number.isSafeInteger(c.context.version) || c.context.version < 1)) fail("Context must reference a saved revision for this exposure day.")
    if (c.classificationId !== undefined && (typeof c.classificationId !== "string" || !/^[a-f0-9-]{36}$/.test(c.classificationId))) fail("Invalid classification provenance.")
    if ((day < e.start || day > e.end) && c.adherence !== "unknown") fail("Adherence applies to During days only; Before/After support notes and exclusions.")
  }
  return e
}

export function experimentEvidence(experiment: Experiment, records: OuraRecord[], asOf: string): ExperimentEvidence {
  const today = localDay(new Date(asOf)), points = new Map(buildDailyPoints(records).map(p => [p.day, p]))
  const context = new Map<string, string[]>()
  for (const r of records.filter(r => ["tag", "workout", "session"].includes(r.data_type))) {
    const day = String(r.payload.start_day ?? r.payload.day ?? r.record_date ?? (r.start_datetime ? localDay(new Date(r.start_datetime)) : ""))
    const label = String(r.payload.comment || r.payload.custom_name || r.payload.tag_type_code || r.payload.activity || r.payload.type || r.data_type)
    context.set(day, [...(context.get(day) ?? []), label])
  }
  const days: EvidenceDay[] = []
  for (const [period, start, end] of [["Before", experiment.beforeStart, experiment.beforeEnd], ["During", experiment.start, experiment.end], ["After", experiment.afterStart, experiment.afterEnd]] as const) {
    if (!start || !end) continue
    for (let day = start; day <= end; day = shiftDay(day, 1)) {
      const outcomeDay = shiftDay(day, experiment.alignment), pending = outcomeDay > today
      const point = points.get(outcomeDay), values: EvidenceDay["values"] = {}
      if (!pending) for (const key of Object.keys(experimentMetrics) as ExperimentMetric[]) {
        const value = point?.[key]
        if (typeof value === "number" && Number.isFinite(value)) values[key] = value
      }
      days.push({ day, outcomeDay, period, pending, values, checkIn: experiment.checkIns[day] ?? { adherence: "unknown", note: "", exclusion: "" }, context: context.get(day) ?? [] })
    }
  }
  return { asOf, sourceUpdatedAt: records.map(r => r.synced_at).sort().at(-1) ?? null, days }
}

export function summarizeExperiment(days: EvidenceDay[], metric: ExperimentMetric) {
  const elapsed = days.filter(d => !d.pending), included = elapsed.filter(d => !d.checkIn.exclusion)
  const values = included.flatMap(d => d.values[metric] === undefined ? [] : [d.values[metric]!])
  return { planned: days.length, pending: days.length - elapsed.length, excluded: elapsed.length - included.length,
    missing: included.length - values.length, n: values.length,
    mean: values.length ? values.reduce((a, b) => a + b, 0) / values.length : null }
}
