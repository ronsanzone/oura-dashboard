import { localDay, timeZone, type ObservatoryStatus, type OuraRecord } from "@oura/shared"
import { Panel, recordDay, startTime } from "./Dashboard"

const stamp = (value: string | null | undefined) => value ? new Date(value).toLocaleString("en-US", { timeZone, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "Not recorded"
const datasets = [["daily_sleep", "Sleep score", "daily"], ["sleep", "Sleep & overnight physiology", "daily"], ["daily_readiness", "Readiness", "daily"], ["daily_activity", "Activity & MET", "daily"], ["heart_rate", "Heart rate", "heartrate"], ["daily_stress", "Daily stress totals", "stress"], ["daily_spo2", "Oxygen saturation", "spo2"], ["daily_resilience", "Resilience", "stress"], ["cardiovascular_age", "Cardiovascular age", "heart_health"], ["vo2_max", "VO₂ max", "heart_health"], ["tag", "Tags & notes", "tag"], ["workout", "Workouts", "workout"], ["session", "Sessions", "session"]] as const

export function DataView({ status, records }: { status: ObservatoryStatus; records: OuraRecord[] }) {
  return <div className="dashboard-grid"><Panel title="Trust starts with coverage." meta="SOURCE: OURA API / IMPORT" wide><p>Last sync attempt: {stamp(status.sync?.started_at)} · {status.sync?.status ?? "No sync history"}. Last changed/imported record: {stamp(status.last_sync)}. A successful sync does not guarantee every measurement is available.</p><p className="caption">Coverage below is for the selected window. Granted scopes: {status.scopes?.length ? status.scopes.join(", ") : "Not recorded"}. Stored data can still be explored while disconnected. HTTP 403 means access denied; the API alone does not distinguish a permission problem from an expired subscription.</p></Panel>
    {datasets.map(([type, title]) => {
      const rows = records.filter((record) => record.data_type === type)
      const days = rows.map((record) => recordDay(record) || (Number.isFinite(startTime(record)) ? localDay(new Date(startTime(record))) : "")).filter(Boolean).sort()
      const issue = status.sync?.skipped[type]
      return <Panel key={type} title={title} meta={`${rows.length.toLocaleString()} RECORDS`}><p className={issue ? "warning" : ""}>{issue === "HTTP 403" ? "Access denied by Oura — check permission / subscription" : issue ? `Sync incomplete: ${issue}` : rows.length ? "Measurements available in loaded history" : "No measurements in loaded history — availability unknown"}</p><p className="caption">Observed {days[0] ?? "—"} → {days.at(-1) ?? "—"} · {new Set(days).size} distinct days. Record counts do not prove full-day coverage.</p><details><summary>Source payloads · first 5 records</summary><pre>{JSON.stringify(rows.slice(0, 5), null, 2)}</pre></details></Panel>
    })}</div>
}
