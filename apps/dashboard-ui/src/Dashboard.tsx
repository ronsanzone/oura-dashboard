import { useState, type ReactNode } from "react"
import { baselineFor, dayStart, localDay, shiftDay, timeZone, type DailyPoint, type OuraRecord } from "@oura/shared"
import { Chart } from "./Chart"

// Waffle Cat: ronsanzone/dotfiles/theme-picker/themes/omarchy-waffle-cat.json
export const ink = "#fff4d8", muted = "#a58c82", grid = "#463b3e"
export const palette = ["#df9850", "#9eb8b2", "#c98c97", "#9fad68", "#e4c56d"]
export const num = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) ? value : undefined
export const fmt = (value: unknown, digits = 1) => num(value)?.toLocaleString(undefined, { maximumFractionDigits: digits }) ?? "—"
export const clock = (value: number | string) => new Date(value).toLocaleTimeString("en-US", { timeZone, hour: "numeric", minute: "2-digit" })
export const recordDay = (record: OuraRecord) => String(record.payload.day ?? record.payload.start_day ?? record.record_date ?? "")
export const startTime = (record: OuraRecord) => Date.parse(String(record.start_datetime ?? record.payload.timestamp ?? record.payload.bedtime_start ?? record.payload.start_time ?? ""))
export const eventLabel = (record: OuraRecord) => String(record.payload.comment || record.payload.custom_name || record.payload.tag_type_code || record.payload.activity || record.payload.type || record.data_type).replaceAll("_", " ")
export const base = {
  animation: false, backgroundColor: "transparent", textStyle: { color: muted, fontFamily: "system-ui", fontSize: 12 },
  grid: { left: 52, right: 22, top: 32, bottom: 36 },
  tooltip: { trigger: "axis", renderMode: "richText", backgroundColor: "#1f181c", borderColor: grid, textStyle: { color: ink } },
  xAxis: { type: "category", axisLine: { lineStyle: { color: grid } }, axisLabel: { color: muted }, boundaryGap: false },
  yAxis: { type: "value", axisLabel: { color: muted }, splitLine: { lineStyle: { color: grid } } }
}

export function Panel({ title, meta, children, wide = false }: { title: string; meta?: string; children: ReactNode; wide?: boolean }) {
  return <section className={`panel ${wide ? "wide" : ""}`}><header className="panel-head"><h2>{title}</h2>{meta && <span>{meta}</span>}</header>{children}</section>
}

export function Empty({ children }: { children: ReactNode }) { return <p className="empty">{children}</p> }

export function Trend({ points, history = points, metric, title, unit, color = palette[0] }: { points: DailyPoint[]; history?: DailyPoint[]; metric: keyof DailyPoint; title: string; unit: string; color?: string }) {
  const observed = points.filter((point) => num(point[metric]) !== undefined)
  const latest = observed.at(-1)
  const baseline = latest ? baselineFor(history, latest.day, metric) : undefined
  return <Panel title={title} meta={unit}>
    {latest ? <>
      <div className="trend-value">{fmt(latest[metric])} <small>{unit}</small><span>Last observed {latest.day}</span></div>
      <Chart option={{ ...base, xAxis: { ...base.xAxis, data: points.map((point) => point.day.slice(5)) },
        yAxis: { ...base.yAxis, name: unit, scale: true }, series: [{ name: title, type: "line", showSymbol: points.length < 15, connectNulls: false,
          data: points.map((point) => point[metric] ?? null), lineStyle: { width: 2, color }, itemStyle: { color },
          markLine: baseline?.mean === undefined ? undefined : { symbol: "none", label: { show: false }, lineStyle: { color: muted, type: "dashed" }, data: [{ yAxis: baseline.mean }] } }] }} />
      <p className="caption">{observed.length}/{points.length} days measured. {baseline?.mean === undefined ? "Not enough prior observations for a baseline (7 required)." : `Dashed line: prior 28-day mean ${fmt(baseline.mean)} ${unit}, n=${baseline.count}; excludes latest day.`}</p>
    </> : <Empty>No {title.toLowerCase()} measurements in this window. Missing is not zero.</Empty>}
  </Panel>
}

export type Sample = [number, number | null]
export function samples(value: unknown): Sample[] {
  if (!value || typeof value !== "object") return []
  const data = value as { timestamp?: string; interval?: number; items?: unknown[] }
  const start = Date.parse(data.timestamp ?? ""), interval = num(data.interval)
  if (!Number.isFinite(start) || !interval || !Array.isArray(data.items)) return []
  return data.items.map((item, index) => [start + index * interval * 1000, num(item) ?? null])
}

export function Timeline({ records, day }: { records: OuraRecord[]; day: string }) {
  const [mode, setMode] = useState("night")
  const [position, setPosition] = useState(50)
  const midnight = Date.parse(dayStart(day))
  const nextMidnight = Date.parse(dayStart(shiftDay(day, 1)))
  const min = mode === "night" ? midnight - 6 * 3600000 : midnight
  const max = mode === "night" ? nextMidnight - 6 * 3600000 : nextMidnight
  const cursor = min + (max - min) * position / 100
  const within = (time: number) => time >= min && time < max
  const sleeps = records.filter((record) => record.data_type === "sleep")
  const phases: Sample[] = sleeps.flatMap((record) => {
    const phases = record.payload.sleep_phase_30_sec
    if (typeof phases !== "string") return []
    const start = startTime(record)
    return [...phases].map((value, index): Sample => [start + index * 30000, /^[1-4]$/.test(value) ? Number(value) : null]).concat([[start + phases.length * 30000, null]])
  }).filter(([time]) => within(time)).sort((a, b) => a[0] - b[0])
  const hr: Sample[] = records.filter((record) => record.data_type === "heart_rate" && within(startTime(record)))
    .map((record): Sample => [startTime(record), num(record.payload.bpm) ?? null]).sort((a, b) => a[0] - b[0])
  const met = records.filter((record) => record.data_type === "daily_activity").flatMap((record) => samples(record.payload.met)).filter(([time]) => within(time)).sort((a, b) => a[0] - b[0])
  const events = records.filter((record) => ["tag", "session", "workout"].includes(record.data_type) && (within(startTime(record)) || (!Number.isFinite(startTime(record)) && recordDay(record) === day)))
  const sleepEvents = sleeps.flatMap((record) => [{ time: startTime(record), label: "Bedtime" }, { time: Date.parse(String(record.end_datetime ?? record.payload.bedtime_end ?? "")), label: "Wake time" }]).filter((event) => within(event.time))
  const timedEvents = [...sleepEvents, ...events.filter((record) => Number.isFinite(startTime(record))).map((record) => ({ time: startTime(record), label: eventLabel(record) }))].sort((a, b) => a.time - b.time)
  const lanes = [phases, hr, met, timedEvents.map((event): Sample => [event.time, 1])]
  const names = ["Sleep stage", "Heart rate · bpm", "Activity · MET", "Context"]
  const nearest = (data: Sample[], tolerance: number) => data.filter(([time, value]) => value !== null && Math.abs(time - cursor) <= tolerance).sort((a, b) => Math.abs(a[0] - cursor) - Math.abs(b[0] - cursor))[0]
  const heart = nearest(hr, 5 * 60000), activity = nearest(met, 60000), stage = nearest(phases, 30000)
  const option = {
    ...base, tooltip: { ...base.tooltip, axisPointer: { type: "line" } }, axisPointer: { link: [{ xAxisIndex: "all" }] },
    grid: [0, 1, 2, 3].map((index) => ({ left: 60, right: 20, top: index * 112 + 28, height: index === 3 ? 40 : 72 })),
    xAxis: lanes.map((_, index) => ({ type: "time", gridIndex: index, min, max, splitNumber: 4, axisLine: { lineStyle: { color: grid } }, splitLine: { show: true, lineStyle: { color: grid } }, axisLabel: { show: index === 3, hideOverlap: true, color: muted, formatter: (value: number) => new Date(value).toLocaleTimeString("en-US", { timeZone, hour: "numeric" }) } })),
    yAxis: lanes.map((_, index) => ({ type: "value", gridIndex: index, name: names[index], nameLocation: "end", nameTextStyle: { color: ink, align: "left" }, min: index === 0 ? 1 : index === 3 ? 0 : undefined, max: index === 0 ? 4 : index === 3 ? 2 : undefined, interval: index === 0 ? 1 : undefined, scale: index === 1, splitLine: { lineStyle: { color: grid } }, axisLabel: { show: index !== 3, color: muted, formatter: index === 0 ? (value: number) => ["", "Deep", "Light", "REM", "Awake"][value] : undefined } })),
    series: lanes.map((data, index) => ({ name: names[index], xAxisIndex: index, yAxisIndex: index, type: index === 0 ? "line" : index === 2 ? "bar" : "scatter", step: index === 0 ? "end" : undefined, showSymbol: false, symbolSize: index === 3 ? 12 : 4, data, itemStyle: { color: palette[index] }, lineStyle: { color: palette[index], width: 2 }, markLine: { silent: true, symbol: "none", label: { show: false }, lineStyle: { color: ink, opacity: .6 }, data: [{ xAxis: cursor }] } })),
    graphic: lanes.flatMap((data, index) => data.some(([, value]) => value !== null) ? [] : [{ type: "text", left: "center", top: index * 112 + 57, style: { text: index === 3 ? "No timed events logged" : "No samples available — not zero", fill: muted, fontSize: 12 } }])
  }
  return <section className="panel timeline" id="body-timeline"><header className="panel-head"><div><span className="eyebrow">THE BODY TIMELINE</span><h2>Your day, in its own rhythm.</h2></div><div className="segmented">{["night", "day"].map((value) => <button key={value} aria-pressed={mode === value} onClick={() => setMode(value)}>{value === "night" ? "Night → day" : "Calendar day"}</button>)}</div></header>
    <p className="caption">{mode === "night" ? "Previous 6 PM → selected 6 PM" : "Midnight → midnight"} · Eastern time · Separate scales, one shared clock. Heart rate is measured samples, not an interpolated trace.</p>
    <Chart option={option} height={438} onEvents={{ click: (event) => { if (Array.isArray(event.value)) setPosition(Math.max(0, Math.min(100, (event.value[0] - min) / (max - min) * 100))) } }} />
    <label className="cursor-control">Inspect a moment <input type="range" min="0" max="100" step="0.1" value={position} onChange={(event) => setPosition(Number(event.target.value))} /></label>
    <div className="moment" aria-live="polite"><strong>{clock(cursor)}</strong><span>Sleep: {stage ? ["", "Deep", "Light", "REM", "Awake"][stage[1] ?? 0] : "no nearby sample"}</span><span>HR: {heart ? `${heart[1]} bpm at ${clock(heart[0])}` : "no sample within 5 min"}</span><span>Activity: {activity ? `${fmt(activity[1])} MET` : "no sample within 1 min"}</span></div>
    <div className="events">{timedEvents.map((event, index) => <button key={index} onClick={() => setPosition((event.time - min) / (max - min) * 100)}><small>{clock(event.time)}</small>{event.label}</button>)}{events.filter((record) => !Number.isFinite(startTime(record))).map((record) => <div key={record.record_id}><small>Day-level context · time unknown</small>{eventLabel(record)}</div>)}</div>
    <p className="caption">Unlogged context is unknown, not “didn’t happen.” Daily stress is a daily total and is never plotted as an intraday signal.</p>
  </section>
}

export function Events({ records }: { records: OuraRecord[] }) {
  const events = records.filter((record) => ["workout", "session", "tag"].includes(record.data_type))
  return <Panel title="The context you logged" meta={`${events.length} EVENTS`} wide>{events.length ? <div className="table-wrap"><table><thead><tr><th>Day</th><th>Type</th><th>Context</th><th>Duration</th></tr></thead><tbody>{events.map((record) => <tr key={`${record.data_type}-${record.record_id}`}><td>{recordDay(record) || (Number.isFinite(startTime(record)) ? localDay(new Date(startTime(record))) : "Unknown")}</td><td>{record.data_type}</td><td>{eventLabel(record)}</td><td>{record.end_datetime && Number.isFinite(startTime(record)) ? `${fmt((Date.parse(record.end_datetime) - startTime(record)) / 60000)} min` : "Not recorded"}</td></tr>)}</tbody></table></div> : <Empty>No workouts, sessions or tags in this window. This does not mean none happened.</Empty>}</Panel>
}
