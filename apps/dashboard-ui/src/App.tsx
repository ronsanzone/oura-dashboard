import { useEffect, useMemo, useState, type ReactNode } from "react"
import ReactECharts from "echarts-for-react"
import { Experiments } from "./Experiments"
import { Debrief } from "./Debrief"
import { Signals } from "./Signals"
import { JevDebug } from "./JevDebug"
import { baselineFor, buildDailyPoints, dayStart, localDay, mainSleep, pearson, shiftDay, timeZone, type DailyPoint, type ObservatoryStatus, type OuraRecord, type RecordsPage } from "@oura/shared"

// Waffle Cat: ronsanzone/dotfiles/theme-picker/themes/omarchy-waffle-cat.json
const ink = "#fff4d8", muted = "#a58c82", grid = "#463b3e"
const palette = ["#df9850", "#9eb8b2", "#c98c97", "#9fad68", "#e4c56d"]
const tabs = ["Today", "Sleep", "Cardio", "Activity", "Explore", "Debrief", "Experiments", "Data"] as const
type Tab = typeof tabs[number]
const num = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) ? value : undefined
const fmt = (value: unknown, digits = 1) => num(value)?.toLocaleString(undefined, { maximumFractionDigits: digits }) ?? "—"
const clock = (value: number | string) => new Date(value).toLocaleTimeString("en-US", { timeZone, hour: "numeric", minute: "2-digit" })
const stamp = (value: string | null | undefined) => value ? new Date(value).toLocaleString("en-US", { timeZone, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "Not recorded"
const recordDay = (record: OuraRecord) => String(record.payload.day ?? record.payload.start_day ?? record.record_date ?? "")
const startTime = (record: OuraRecord) => Date.parse(String(record.start_datetime ?? record.payload.timestamp ?? record.payload.bedtime_start ?? record.payload.start_time ?? ""))
const eventLabel = (record: OuraRecord) => String(record.payload.comment || record.payload.custom_name || record.payload.tag_type_code || record.payload.activity || record.payload.type || record.data_type).replaceAll("_", " ")
const base = {
  animation: false, backgroundColor: "transparent", textStyle: { color: muted, fontFamily: "system-ui", fontSize: 12 },
  grid: { left: 52, right: 22, top: 32, bottom: 36 },
  tooltip: { trigger: "axis", renderMode: "richText", backgroundColor: "#1f181c", borderColor: grid, textStyle: { color: ink } },
  xAxis: { type: "category", axisLine: { lineStyle: { color: grid } }, axisLabel: { color: muted }, boundaryGap: false },
  yAxis: { type: "value", axisLabel: { color: muted }, splitLine: { lineStyle: { color: grid } } }
}

function Panel({ title, meta, children, wide = false }: { title: string; meta?: string; children: ReactNode; wide?: boolean }) {
  return <section className={`panel ${wide ? "wide" : ""}`}><header className="panel-head"><h2>{title}</h2>{meta && <span>{meta}</span>}</header>{children}</section>
}
function Empty({ children }: { children: ReactNode }) { return <p className="empty">{children}</p> }
function Chart({ option, height = 240 }: { option: object; height?: number }) {
  return <ReactECharts option={{ ...option, aria: { enabled: true } }} style={{ height }} opts={{ renderer: "canvas" }} notMerge />
}

function Trend({ points, history = points, metric, title, unit, color = palette[0] }: { points: DailyPoint[]; history?: DailyPoint[]; metric: keyof DailyPoint; title: string; unit: string; color?: string }) {
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

function Brief({ points, day }: { points: DailyPoint[]; day: string }) {
  const current = points.find((point) => point.day === day)
  const metrics = [["Main sleep", "totalSleepHours", "h"], ["Overnight HRV", "averageHrv", "ms"], ["Lowest sleeping HR", "lowestHeartRate", "bpm"]] as const
  const sleepBase = baselineFor(points, day, "totalSleepHours")
  const change = current?.totalSleepHours === undefined || sleepBase.mean === undefined ? undefined : current.totalSleepHours - sleepBase.mean
  return <>
    <section className="brief"><div><span className="eyebrow">YOUR MORNING BRIEF · {day}</span><h1>A little perspective,<br />before your day begins.</h1>
      <p>{change === undefined ? "Start with what was measured. A missing night is a gap in the story, not a verdict on your day." : `Your main sleep was ${fmt(Math.abs(change) * 60, 0)} minutes ${change >= 0 ? "longer" : "shorter"} than your prior 28-day average. Look at the night in context, not just the score.`}</p></div>
      <div className="next-step"><span className="eyebrow">ONE SMALL NEXT STEP</span><h3>{current ? "Notice your routine." : "Check your coverage."}</h3><p>{current ? "Review the timeline and your Oura tags. Note what was different before deciding what to change." : "Sync Oura or choose an earlier date. We won’t substitute an older measurement for this day."}</p><a href="#body-timeline">Explore this day <span>↘</span></a></div>
    </section>
    <div className="brief-metrics">{metrics.map(([title, key, unit], index) => {
      const value = current?.[key], baseline = baselineFor(points, day, key)
      const delta = value === undefined || baseline.mean === undefined ? undefined : value - baseline.mean
      return <article className="metric" key={key} style={{ borderTopColor: palette[index] }}><span>{title}</span><strong>{fmt(value)} <small>{unit}</small></strong>
        <p>{value === undefined ? "No measurement for this date" : delta === undefined ? "Building your personal baseline" : `${delta >= 0 ? "+" : ""}${fmt(delta)} ${unit} vs your baseline`}</p>
        <details><summary>Measurement & context</summary><p>{day} · Oura sleep record, longest sleep of the day. Prior window: {shiftDay(day, -28)}–{shiftDay(day, -1)}. {baseline.count}/28 observed nights; mean {fmt(baseline.mean)} {unit}. At least 7 nights required. Gaps excluded, never filled.</p></details>
      </article>
    })}</div>
  </>
}

type Sample = [number, number | null]
function samples(value: unknown): Sample[] {
  if (!value || typeof value !== "object") return []
  const data = value as { timestamp?: string; interval?: number; items?: unknown[] }
  const start = Date.parse(data.timestamp ?? ""), interval = num(data.interval)
  if (!Number.isFinite(start) || !interval || !Array.isArray(data.items)) return []
  return data.items.map((item, index) => [start + index * interval * 1000, num(item) ?? null])
}

function Timeline({ records, day }: { records: OuraRecord[]; day: string }) {
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
    <ReactECharts option={{ ...option, aria: { enabled: true } }} style={{ height: 438 }} notMerge onEvents={{ click: (event: { value?: Sample }) => { if (Array.isArray(event.value)) setPosition(Math.max(0, Math.min(100, (event.value[0] - min) / (max - min) * 100))) } }} />
    <label className="cursor-control">Inspect a moment <input type="range" min="0" max="100" step="0.1" value={position} onChange={(event) => setPosition(Number(event.target.value))} /></label>
    <div className="moment" aria-live="polite"><strong>{clock(cursor)}</strong><span>Sleep: {stage ? ["", "Deep", "Light", "REM", "Awake"][stage[1] ?? 0] : "no nearby sample"}</span><span>HR: {heart ? `${heart[1]} bpm at ${clock(heart[0])}` : "no sample within 5 min"}</span><span>Activity: {activity ? `${fmt(activity[1])} MET` : "no sample within 1 min"}</span></div>
    <div className="events">{timedEvents.map((event, index) => <button key={index} onClick={() => setPosition((event.time - min) / (max - min) * 100)}><small>{clock(event.time)}</small>{event.label}</button>)}{events.filter((record) => !Number.isFinite(startTime(record))).map((record) => <div key={record.record_id}><small>Day-level context · time unknown</small>{eventLabel(record)}</div>)}</div>
    <p className="caption">Unlogged context is unknown, not “didn’t happen.” Daily stress is a daily total and is never plotted as an intraday signal.</p>
  </section>
}

function SleepView({ points, history, records, day }: { points: DailyPoint[]; history: DailyPoint[]; records: OuraRecord[]; day: string }) {
  const sleeps = records.filter((record) => record.data_type === "sleep" && recordDay(record) === day)
  const main = mainSleep(sleeps)
  const [selected, setSelected] = useState("")
  const sleep = sleeps.find((record) => record.record_id === selected) ?? main
  const p = sleep?.payload
  const total = sleeps.length && sleeps.every((record) => num(record.payload.total_sleep_duration) !== undefined) ? sleeps.reduce((sum, record) => sum + Number(record.payload.total_sleep_duration), 0) / 3600 : undefined
  const stages = [["Deep", p?.deep_sleep_duration], ["REM", p?.rem_sleep_duration], ["Light", p?.light_sleep_duration], ["Awake", p?.awake_time]]
  return <div className="dashboard-grid"><Panel title="One night, not one score." meta={day} wide>
    <div className="sleep-summary"><label>Sleep episode<select value={sleep?.record_id ?? ""} onChange={(event) => setSelected(event.target.value)}>{!sleeps.length && <option>No sleep for this date</option>}{sleeps.map((record) => <option key={record.record_id} value={record.record_id}>{record === main ? "Main sleep (longest)" : "Additional sleep / nap"} · {clock(startTime(record))} · {fmt(Number(record.payload.total_sleep_duration) / 3600)} h</option>)}</select></label><div><strong>{fmt(total)} h</strong><span>Total across {sleeps.length} episodes</span></div><div><strong>{fmt(num(p?.total_sleep_duration) === undefined ? undefined : Number(p?.total_sleep_duration) / 3600)} h</strong><span>Selected episode · asleep</span></div></div>
    <div className="stage-summary">{stages.map(([label, value], index) => <div key={String(label)} style={{ borderColor: palette[index] }}><span>{String(label)}</span><b>{num(value) === undefined ? "Not measured" : `${fmt(Number(value) / 3600)} h`}</b></div>)}</div>
    <p className="caption">Daily trends and the brief use the longest episode; total daily sleep includes naps. No proprietary sleep-debt estimate is inferred.</p>
  </Panel>
    <Trend points={points} history={history} metric="totalSleepHours" title="Main sleep duration" unit="h" />
    <Trend points={points} history={history} metric="sleepEfficiency" title="Sleep efficiency" unit="%" color={palette[1]} />
    <Trend points={points} history={history} metric="sleepScore" title="Sleep score" unit="/ 100" color={palette[2]} />
    <Panel title="Selected episode physiology" meta="SOURCE SAMPLES">
      {([['heart_rate', 'Heart rate', 'bpm'], ['hrv', 'HRV', 'ms']] as const).map(([key, title, unit], index) => {
        const data = samples(p?.[key])
        return <div key={key}><p className="caption">{title} · {unit}</p>{data.some(([, value]) => value !== null) ? <Chart height={140} option={{ ...base, xAxis: { ...base.xAxis, type: "time", axisLabel: { color: muted, formatter: (value: number) => clock(value) } }, yAxis: { ...base.yAxis, scale: true }, series: [{ name: `${title} · ${unit}`, type: "line", data, showSymbol: false, connectNulls: false, lineStyle: { color: palette[index] } }] }} /> : <Empty>No {title.toLowerCase()} samples for this episode.</Empty>}</div>
      })}
    </Panel>
    <Panel title="Bed & wake rhythm" meta="EASTERN TIME" wide><div className="rhythm">{points.slice(-14).map((point) => {
      const sleep = mainSleep(records.filter((record) => recordDay(record) === point.day))
      return <div key={point.day}><span>{point.day.slice(5)}</span><b>{sleep ? clock(startTime(sleep)) : "—"}</b><span>→</span><b>{sleep?.end_datetime || sleep?.payload.bedtime_end ? clock(String(sleep.end_datetime ?? sleep.payload.bedtime_end)) : "—"}</b></div>
    })}</div><p className="caption">Last 14 days · main sleep only. Times preserve the source instant; no invented bedtime recommendations.</p></Panel>
    <div className="wide"><Timeline records={records} day={day} /></div>
  </div>
}

function Events({ records }: { records: OuraRecord[] }) {
  const events = records.filter((record) => ["workout", "session", "tag"].includes(record.data_type))
  return <Panel title="The context you logged" meta={`${events.length} EVENTS`} wide>{events.length ? <div className="table-wrap"><table><thead><tr><th>Day</th><th>Type</th><th>Context</th><th>Duration</th></tr></thead><tbody>{events.map((record) => <tr key={`${record.data_type}-${record.record_id}`}><td>{recordDay(record) || (Number.isFinite(startTime(record)) ? localDay(new Date(startTime(record))) : "Unknown")}</td><td>{record.data_type}</td><td>{eventLabel(record)}</td><td>{record.end_datetime && Number.isFinite(startTime(record)) ? `${fmt((Date.parse(record.end_datetime) - startTime(record)) / 60000)} min` : "Not recorded"}</td></tr>)}</tbody></table></div> : <Empty>No workouts, sessions or tags in this window. This does not mean none happened.</Empty>}</Panel>
}

function Explore({ points, history, start, end, records, onDirty }: { points: DailyPoint[]; history: DailyPoint[]; start: string; end: string; records: OuraRecord[]; onDirty: (dirty: boolean) => void }) {
  const choices = [["Main sleep · h", "totalSleepHours"], ["HRV · ms", "averageHrv"], ["Lowest HR · bpm", "lowestHeartRate"], ["Steps", "steps"], ["Daily stress · h", "stressHours"]] as const
  const [x, setX] = useState<keyof DailyPoint>("totalSleepHours"), [y, setY] = useState<keyof DailyPoint>("averageHrv")
  const pairs = points.filter((point) => num(point[x]) !== undefined && num(point[y]) !== undefined)
  const r = pairs.length >= 14 && x !== y ? pearson(pairs.map((point) => num(point[x])), pairs.map((point) => num(point[y]))) : undefined
  return <div className="dashboard-grid"><Signals points={history} start={start} end={end} records={records.filter(r => r.data_type === "tag")} onDirty={onDirty} /><Panel title="Ask a smaller question." meta="OBSERVATIONAL EXPLORER" wide><p>Do two measurements move together? Start here before designing an experiment. These same-day comparisons cannot establish cause, and nights are not independent observations.</p><div className="select-row"><label>First measurement<select value={x} onChange={(event) => setX(event.target.value as keyof DailyPoint)}>{choices.map(([name, key]) => <option key={key} value={key}>{name}</option>)}</select></label><label>Second measurement<select value={y} onChange={(event) => setY(event.target.value as keyof DailyPoint)}>{choices.map(([name, key]) => <option key={key} value={key}>{name}</option>)}</select></label></div>
    {r === undefined ? <Empty>{x === y ? "Choose two different measurements." : `Not enough evidence: ${pairs.length} paired days. At least 14 non-constant paired observations are required.`}</Empty> : <><Chart height={320} option={{ ...base, xAxis: { ...base.yAxis, name: choices.find(([, key]) => key === x)?.[0], nameLocation: "middle", nameGap: 28, scale: true }, yAxis: { ...base.yAxis, name: choices.find(([, key]) => key === y)?.[0], scale: true }, series: [{ type: "scatter", symbolSize: 8, data: pairs.map((point) => [point[x], point[y]]), itemStyle: { color: palette[0] } }] }} /><p className="relation-result">r = {fmt(r, 2)} <span>· {pairs.length} paired days · {points.length - pairs.length} days excluded for missing measurements</span></p></>}
    <p className="caption">Exploratory only: routine, travel, seasonality and serial correlation can explain an association. No confidence or causal claim is inferred from this coefficient. Score/component pairs are deliberately excluded.</p></Panel><Panel title="What am I testing?" meta="A DELIBERATE NEXT STEP" wide><p>Pick one routine, one outcome and a comparison period in Experiments. Log adherence explicitly—including days you did not follow it. Unlogged days remain unknown.</p><p className="caption">Use Debrief to capture context before reviewing outcomes. Explore’s optional context review makes Jev calls only with your explicit consent; comparisons remain deterministic.</p></Panel></div>
}

const datasets = [["daily_sleep", "Sleep score", "daily"], ["sleep", "Sleep & overnight physiology", "daily"], ["daily_readiness", "Readiness", "daily"], ["daily_activity", "Activity & MET", "daily"], ["heart_rate", "Heart rate", "heartrate"], ["daily_stress", "Daily stress totals", "stress"], ["daily_spo2", "Oxygen saturation", "spo2"], ["daily_resilience", "Resilience", "stress"], ["cardiovascular_age", "Cardiovascular age", "heart_health"], ["vo2_max", "VO₂ max", "heart_health"], ["tag", "Tags & notes", "tag"], ["workout", "Workouts", "workout"], ["session", "Sessions", "session"]] as const
function DataView({ status, records }: { status: ObservatoryStatus; records: OuraRecord[] }) {
  return <div className="dashboard-grid"><Panel title="Trust starts with coverage." meta="SOURCE: OURA API / IMPORT" wide><p>Last sync attempt: {stamp(status.sync?.started_at)} · {status.sync?.status ?? "No sync history"}. Last changed/imported record: {stamp(status.last_sync)}. A successful sync does not guarantee every measurement is available.</p><p className="caption">Coverage below is for the selected window. Granted scopes: {status.scopes?.length ? status.scopes.join(", ") : "Not recorded"}. Stored data can still be explored while disconnected. HTTP 403 means access denied; the API alone does not distinguish a permission problem from an expired subscription.</p></Panel>
    {datasets.map(([type, title]) => {
      const rows = records.filter((record) => record.data_type === type)
      const days = rows.map((record) => recordDay(record) || (Number.isFinite(startTime(record)) ? localDay(new Date(startTime(record))) : "")).filter(Boolean).sort()
      const issue = status.sync?.skipped[type]
      return <Panel key={type} title={title} meta={`${rows.length.toLocaleString()} RECORDS`}><p className={issue ? "warning" : ""}>{issue === "HTTP 403" ? "Access denied by Oura — check permission / subscription" : issue ? `Sync incomplete: ${issue}` : rows.length ? "Measurements available in loaded history" : "No measurements in loaded history — availability unknown"}</p><p className="caption">Observed {days[0] ?? "—"} → {days.at(-1) ?? "—"} · {new Set(days).size} distinct days. Record counts do not prove full-day coverage.</p><details><summary>Source payloads · first 5 records</summary><pre>{JSON.stringify(rows.slice(0, 5), null, 2)}</pre></details></Panel>
    })}</div>
}

export function App() {
  const today = localDay(new Date())
  const [day, setDay] = useState(today), [windowDays, setWindowDays] = useState(30), [tab, setTab] = useState<Tab>("Today")
  const [debriefDirty, setDebriefDirty] = useState(false)
  const changeTab = (next: Tab) => { if (next !== tab && (!debriefDirty || confirm("Leave context review? Your unsaved draft or pending result will be discarded."))) setTab(next) }
  const [status, setStatus] = useState<ObservatoryStatus | null>(null), [records, setRecords] = useState<OuraRecord[]>([])
  const [loading, setLoading] = useState(true), [error, setError] = useState<string | null>(null), [syncing, setSyncing] = useState(false), [refresh, setRefresh] = useState(0)
  const start = shiftDay(day, -(windowDays - 1)), historyStart = shiftDay(start, -Math.min(28, 367 - windowDays))
  useEffect(() => {
    const controller = new AbortController()
    async function load() {
      setLoading(true); setError(null); setRecords([])
      try {
        const response = await fetch("/api/status", { signal: controller.signal })
        if (!response.ok) throw new Error("Unable to load connection and coverage status.")
        const nextStatus = await response.json() as ObservatoryStatus
        if (!controller.signal.aborted) setStatus(nextStatus)
        const all: OuraRecord[] = []
        let offset: number | null = 0
        while (offset !== null) {
          const response = await fetch(`/api/records?start=${historyStart}&end=${day}&offset=${offset}`, { signal: controller.signal })
          if (!response.ok) throw new Error("History could not be fully loaded. No partial charts are shown.")
          const page = await response.json() as RecordsPage
          all.push(...page.records); offset = page.nextOffset
        }
        if (!controller.signal.aborted) setRecords(all)
      } catch (reason) { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Unable to load data") }
      finally { if (!controller.signal.aborted) setLoading(false) }
    }
    void load()
    return () => controller.abort()
  }, [day, historyStart, refresh])
  const allPoints = useMemo(() => buildDailyPoints(records), [records])
  const points = useMemo(() => Array.from({ length: windowDays }, (_, index) => allPoints.find((point) => point.day === shiftDay(start, index)) ?? { day: shiftDay(start, index) }), [allPoints, start, windowDays])
  const visibleRecords = records.filter((record) => { const date = recordDay(record) || (Number.isFinite(startTime(record)) ? localDay(new Date(startTime(record))) : ""); return date >= start && date <= day })
  const sync = async () => {
    if (debriefDirty && !confirm("Sync will refresh this view. Discard your unsaved context draft or pending result?")) return
    setSyncing(true); setError(null)
    try {
      const response = await fetch("/api/sync", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ start: historyStart, end: day }) })
      const result = await response.json() as { message?: string; skipped?: Record<string, string> }
      if (!response.ok) throw new Error(result.message ?? "Sync failed")
      setRefresh((value) => value + 1)
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Sync failed") }
    finally { setSyncing(false) }
  }
  const syncIssues = Object.entries(status?.sync?.skipped ?? {})
  return <div className="app-shell">
    <header className="site-header"><a className="brand" href="#" onClick={(event) => { event.preventDefault(); changeTab("Today") }}><span className="brand-mark">◯</span><span>oura <b>observatory</b></span></a><span className="private-label">{!status ? "Connection unverified" : status.mode === "production" ? "Private · Access protected" : "Local preview · not production data"}</span></header>
    <div className="toolbar"><nav aria-label="Main navigation">{tabs.map((name) => <button key={name} aria-current={tab === name ? "page" : undefined} onClick={() => changeTab(name)}>{name}</button>)}</nav><fieldset className="date-controls" disabled={debriefDirty} title={debriefDirty ? "Save or close your context draft before changing the history window" : undefined}><button aria-label="Previous day" onClick={() => setDay(shiftDay(day, -1))}>‹</button><label><span className="sr-only">Selected date</span><input type="date" value={day} max={today} onChange={(event) => { if (/^\d{4}-\d{2}-\d{2}$/.test(event.target.value) && event.target.value <= today) setDay(event.target.value) }} /></label><button aria-label="Next day" disabled={day >= today} onClick={() => setDay(shiftDay(day, 1))}>›</button><label><span className="sr-only">History range</span><select value={windowDays} onChange={(event) => setWindowDays(Number(event.target.value))}>{[7, 30, 90, 365].map((days) => <option key={days} value={days}>{days === 365 ? "1 year" : `${days} days`}</option>)}</select></label></fieldset></div>
    <main><div className="coverage-bar"><span>{loading ? "Loading complete history…" : !status ? "Connection status unavailable" : status.connected ? "Oura connected" : "Oura not connected"} · Eastern time</span><div><button onClick={() => changeTab("Data")}>Coverage & sync {syncIssues.length ? `· ${syncIssues.length} issues` : "↗"}</button>{status?.connected ? <button disabled={syncing || loading} onClick={() => void sync()}>{syncing ? "Syncing…" : "Sync Oura"}</button> : <a href="/oauth/start">Connect Oura ↗</a>}</div></div>
      {status && status.mode !== "production" && <p className="demo-notice">LOCAL PREVIEW · Records shown here are local/imported data, not verified production measurements. Review screenshots use the repository’s synthetic demo.</p>}
      {syncIssues.length > 0 && <div className="alert" role="status">Last sync was incomplete: {syncIssues.map(([type, reason]) => `${type}: ${reason}`).join(" · ")}. See Data for coverage.</div>}
      {error && <div className="alert" role="alert">{error} <button onClick={() => setRefresh((value) => value + 1)}>Retry</button></div>}
      {tab === "Debrief" ? <Debrief records={records} onDirty={setDebriefDirty} /> : tab === "Experiments" ? <Experiments /> : loading ? <div className="loading" role="status">Gathering your measurements…</div> : error && !records.length ? <Empty>Data unavailable. Retry above; incomplete results are not displayed.</Empty> : <>
        {tab !== "Today" && <header className="page-title"><span className="eyebrow">{start} — {day}</span><h1>{{ Sleep: "Make room for rest.", Cardio: "Listen over the long run.", Activity: "Movement, in perspective.", Explore: "Curiosity, with context.", Data: "Know what you’re seeing." }[tab]}</h1></header>}
        {tab === "Today" ? <><Brief points={allPoints} day={day} /><Timeline key={day} records={records} day={day} /><div className="dashboard-grid"><Trend points={points} history={allPoints} metric="totalSleepHours" title="A longer view of sleep" unit="h" /><Trend points={points} history={allPoints} metric="averageHrv" title="Your overnight HRV" unit="ms" color={palette[1]} /></div></>
          : tab === "Sleep" ? <SleepView key={day} points={points} history={allPoints} records={records} day={day} />
          : tab === "Cardio" ? <div className="dashboard-grid">{([
            ["averageHrv", "Overnight HRV", "ms"], ["lowestHeartRate", "Lowest sleeping heart rate", "bpm"],
            ["vascularAge", "Cardiovascular age", "years"], ["pulseWaveVelocity", "Pulse-wave velocity", "m/s"],
            ["vo2Max", "VO₂ max", "ml/kg/min"], ["readinessScore", "Readiness score", "/ 100"],
            ["averageSpo2", "Overnight oxygen saturation", "%"], ["temperatureDeviation", "Temperature deviation", "°C"]
          ] as const).map(([metric, title, unit], index) => <Trend key={metric} points={points} history={allPoints} metric={metric} title={title} unit={unit} color={palette[index % palette.length]} />)}<Events records={visibleRecords} /></div>
          : tab === "Activity" ? <div className="dashboard-grid">{([
            ["steps", "Daily steps", "steps"], ["activeCalories", "Active energy", "kcal"],
            ["stressHours", "Daily high-stress time", "h / day"], ["recoveryHours", "Daily recovery time", "h / day"],
            ["activityScore", "Activity score", "/ 100"], ["mediumActivityHours", "Moderate activity", "h / day"]
          ] as const).map(([metric, title, unit], index) => <Trend key={metric} points={points} history={allPoints} metric={metric} title={title} unit={unit} color={palette[index % palette.length]} />)}<Events records={visibleRecords} /></div>
          : tab === "Explore" ? <Explore points={points} history={allPoints} start={start} end={day} records={visibleRecords} onDirty={setDebriefDirty} /> : status && <DataView status={status} records={visibleRecords} />}
      </>}
      <JevDebug />
      <footer><span>Oura Observatory</span><span>Personal patterns, not medical advice. Missing data is never zero.</span></footer>
    </main>
  </div>
}
