export type OuraRecord = {
  data_type: string
  record_id: string
  record_date: string | null
  start_datetime: string | null
  end_datetime: string | null
  payload: Record<string, unknown>
  synced_at: string
}

export type DatasetCount = {
  data_type: string
  count: number
  first_date: string | null
  last_date: string | null
}

export type ObservatoryStatus = {
  mode: string
  connected: boolean
  records: number
  days: number
  first_date: string | null
  last_date: string | null
  last_sync: string | null
  datasets: DatasetCount[]
  sync?: { started_at: string; finished_at: string | null; status: string; skipped: Record<string, string> } | null
  scopes?: string[]
}

export const timeZone = "America/New_York"
export const localDay = (date: Date): string => new Intl.DateTimeFormat("en-CA", {
  timeZone, year: "numeric", month: "2-digit", day: "2-digit"
}).format(date)

export const shiftDay = (day: string, days: number): string => {
  const date = new Date(`${day}T12:00:00Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

// Resolve midnight in the account timezone, including both DST transitions.
export const dayStart = (day: string): string => {
  const midnight = Date.parse(`${day}T00:00:00Z`)
  let instant = midnight
  for (let i = 0; i < 3; i++) {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(new Date(instant))
    const get = (key: string) => parts.find((part) => part.type === key)?.value
    const wall = Date.parse(`${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}Z`)
    instant += midnight - wall
  }
  return new Date(instant).toISOString()
}

export type RecordsPage = { records: OuraRecord[]; nextOffset: number | null }

export const mainSleep = (records: readonly OuraRecord[]): OuraRecord | undefined =>
  records.filter((record) => record.data_type === "sleep").reduce<OuraRecord | undefined>((best, record) =>
    !best || Number(record.payload.total_sleep_duration ?? 0) > Number(best.payload.total_sleep_duration ?? 0) ? record : best, undefined)

export const baselineFor = (points: readonly DailyPoint[], day: string, key: keyof DailyPoint) => {
  const values = points.filter((point) => point.day >= shiftDay(day, -28) && point.day < day)
    .map((point) => point[key]).filter((value): value is number => typeof value === "number" && Number.isFinite(value))
  return { count: values.length, mean: values.length >= 7 ? mean(values) : undefined }
}

export type DailyPoint = {
  day: string
  sleepScore?: number
  readinessScore?: number
  activityScore?: number
  averageHrv?: number
  lowestHeartRate?: number
  averageHeartRate?: number
  respiratoryRate?: number
  temperatureDeviation?: number
  totalSleepHours?: number
  deepSleepHours?: number
  remSleepHours?: number
  lightSleepHours?: number
  awakeHours?: number
  sleepEfficiency?: number
  sleepLatencyMinutes?: number
  steps?: number
  activeCalories?: number
  sedentaryHours?: number
  lowActivityHours?: number
  mediumActivityHours?: number
  highActivityHours?: number
  stressHours?: number
  recoveryHours?: number
  averageSpo2?: number
  breathingDisturbanceIndex?: number
  vascularAge?: number
  pulseWaveVelocity?: number
  vo2Max?: number
  [key: `sleepContributor.${string}`]: number | undefined
  [key: `readinessContributor.${string}`]: number | undefined
  [key: `activityContributor.${string}`]: number | undefined
}

const numberAt = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined

const objectAt = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}

const assignContributors = (
  point: DailyPoint,
  prefix: "sleepContributor" | "readinessContributor" | "activityContributor",
  value: unknown
): void => {
  for (const [name, score] of Object.entries(objectAt(value))) {
    const numeric = numberAt(score)
    if (numeric !== undefined) point[`${prefix}.${name}`] = numeric
  }
}

export const buildDailyPoints = (records: readonly OuraRecord[]): DailyPoint[] => {
  const days = new Map<string, DailyPoint>()
  const sleepCandidates = new Map<string, Record<string, unknown>>()

  for (const record of records) {
    const payload = record.payload
    const day = typeof payload.day === "string" ? payload.day : record.record_date
    if (!day) continue
    const point = days.get(day) ?? { day }

    if (record.data_type === "daily_sleep") {
      point.sleepScore = numberAt(payload.score)
      assignContributors(point, "sleepContributor", payload.contributors)
    } else if (record.data_type === "daily_readiness") {
      point.readinessScore = numberAt(payload.score)
      point.temperatureDeviation = numberAt(payload.temperature_deviation)
      assignContributors(point, "readinessContributor", payload.contributors)
    } else if (record.data_type === "daily_activity") {
      point.activityScore = numberAt(payload.score)
      point.steps = numberAt(payload.steps)
      point.activeCalories = numberAt(payload.active_calories)
      point.sedentaryHours = secondsToHours(payload.sedentary_time)
      point.lowActivityHours = secondsToHours(payload.low_activity_time)
      point.mediumActivityHours = secondsToHours(payload.medium_activity_time)
      point.highActivityHours = secondsToHours(payload.high_activity_time)
      assignContributors(point, "activityContributor", payload.contributors)
    } else if (record.data_type === "daily_stress") {
      point.stressHours = secondsToHours(payload.stress_high)
      point.recoveryHours = secondsToHours(payload.recovery_high)
    } else if (record.data_type === "daily_spo2") {
      point.averageSpo2 = numberAt(objectAt(payload.spo2_percentage).average)
      point.breathingDisturbanceIndex = numberAt(payload.breathing_disturbance_index)
    } else if (record.data_type === "cardiovascular_age") {
      point.vascularAge = numberAt(payload.vascular_age)
      point.pulseWaveVelocity = numberAt(payload.pulse_wave_velocity)
    } else if (record.data_type === "vo2_max") {
      point.vo2Max = numberAt(payload.vo2_max)
    } else if (record.data_type === "sleep") {
      const existing = sleepCandidates.get(day)
      const duration = numberAt(payload.total_sleep_duration) ?? 0
      const existingDuration = numberAt(existing?.total_sleep_duration) ?? -1
      if (!existing || duration > existingDuration) sleepCandidates.set(day, payload)
    }
    days.set(day, point)
  }

  for (const [day, sleep] of sleepCandidates) {
    const point = days.get(day) ?? { day }
    point.averageHrv = numberAt(sleep.average_hrv)
    point.lowestHeartRate = numberAt(sleep.lowest_heart_rate)
    point.averageHeartRate = numberAt(sleep.average_heart_rate)
    point.respiratoryRate = numberAt(sleep.average_breath)
    point.totalSleepHours = secondsToHours(sleep.total_sleep_duration)
    point.deepSleepHours = secondsToHours(sleep.deep_sleep_duration)
    point.remSleepHours = secondsToHours(sleep.rem_sleep_duration)
    point.lightSleepHours = secondsToHours(sleep.light_sleep_duration)
    point.awakeHours = secondsToHours(sleep.awake_time)
    point.sleepEfficiency = numberAt(sleep.efficiency)
    const latency = numberAt(sleep.latency)
    point.sleepLatencyMinutes = latency === undefined ? undefined : latency / 60
    days.set(day, point)
  }

  return [...days.values()].sort((a, b) => a.day.localeCompare(b.day))
}

const secondsToHours = (value: unknown): number | undefined => {
  const numeric = numberAt(value)
  return numeric === undefined ? undefined : numeric / 3600
}

export const mean = (values: readonly (number | undefined)[]): number | undefined => {
  const present = values.filter((value): value is number => value !== undefined && Number.isFinite(value))
  return present.length === 0 ? undefined : present.reduce((sum, value) => sum + value, 0) / present.length
}

export const pearson = (
  left: readonly (number | undefined)[],
  right: readonly (number | undefined)[]
): number | undefined => {
  const pairs = left.flatMap((value, index) => {
    const other = right[index]
    return value === undefined || other === undefined ? [] : [[value, other] as const]
  })
  if (pairs.length < 3) return undefined
  const leftMean = mean(pairs.map(([value]) => value)) ?? 0
  const rightMean = mean(pairs.map(([, value]) => value)) ?? 0
  const numerator = pairs.reduce((sum, [a, b]) => sum + (a - leftMean) * (b - rightMean), 0)
  const leftSquare = pairs.reduce((sum, [a]) => sum + (a - leftMean) ** 2, 0)
  const rightSquare = pairs.reduce((sum, [, b]) => sum + (b - rightMean) ** 2, 0)
  const denominator = Math.sqrt(leftSquare * rightSquare)
  return denominator === 0 ? undefined : numerator / denominator
}
