import type { DailyPoint, RecordIndex } from "@oura/shared"
import { Events, palette, Panel, Trend } from "./Dashboard"

type Props = { points: DailyPoint[]; history: DailyPoint[]; index: RecordIndex; loading: boolean; error: string | null }

function CompleteEvents({ index, loading, error }: Pick<Props, "index" | "loading" | "error">) {
  if (loading) return <Panel title="The context you logged" meta="COMPLETE HISTORY" wide><p className="loading-inline" role="status">Loading every event in this window…</p></Panel>
  if (error) return <Panel title="The context you logged" meta="UNAVAILABLE" wide><p className="alert">{error}</p><p className="caption">No partial event list is shown.</p></Panel>
  return <Events index={index} />
}

export function CardioView({ points, history, index, loading, error }: Props) {
  return <div className="dashboard-grid">{([
    ["averageHrv", "Overnight HRV", "ms"], ["lowestHeartRate", "Lowest sleeping heart rate", "bpm"],
    ["vascularAge", "Cardiovascular age", "years"], ["pulseWaveVelocity", "Pulse-wave velocity", "m/s"],
    ["vo2Max", "VO₂ max", "ml/kg/min"], ["readinessScore", "Readiness score", "/ 100"],
    ["averageSpo2", "Overnight oxygen saturation", "%"], ["temperatureDeviation", "Temperature deviation", "°C"]
  ] as const).map(([metric, title, unit], index) => <Trend key={metric} points={points} history={history} metric={metric} title={title} unit={unit} color={palette[index % palette.length]} />)}<CompleteEvents index={index} loading={loading} error={error} /></div>
}

export function ActivityView({ points, history, index, loading, error }: Props) {
  return <div className="dashboard-grid">{([
    ["steps", "Daily steps", "steps"], ["activeCalories", "Active energy", "kcal"],
    ["stressHours", "Daily high-stress time", "h / day"], ["recoveryHours", "Daily recovery time", "h / day"],
    ["activityScore", "Activity score", "/ 100"], ["mediumActivityHours", "Moderate activity", "h / day"]
  ] as const).map(([metric, title, unit], index) => <Trend key={metric} points={points} history={history} metric={metric} title={title} unit={unit} color={palette[index % palette.length]} />)}<CompleteEvents index={index} loading={loading} error={error} /></div>
}
