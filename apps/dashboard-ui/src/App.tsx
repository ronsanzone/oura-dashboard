import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react"
import ReactECharts from "echarts-for-react"
import {
  buildDailyPoints,
  mean,
  pearson,
  type DailyPoint,
  type ObservatoryStatus,
  type OuraRecord
} from "@oura/shared"

const colors = {
  cyan: "#61e7e0",
  violet: "#9b87f5",
  blue: "#5da5fa",
  green: "#57d68d",
  amber: "#ffbd66",
  pink: "#f47ca6",
  red: "#ff6b72",
  grid: "rgba(142, 163, 190, .13)",
  muted: "#8492a8"
}

const chartBase = {
  animationDuration: 350,
  backgroundColor: "transparent",
  textStyle: { color: "#9aa9bd", fontFamily: "IBM Plex Mono, ui-monospace, monospace", fontSize: 11 },
  grid: { left: 44, right: 20, top: 34, bottom: 34 },
  tooltip: { trigger: "axis", backgroundColor: "#111827", borderColor: "#334155", textStyle: { color: "#e5edf7" } },
  legend: { top: 0, right: 0, textStyle: { color: "#8fa0b8", fontSize: 10 } },
  xAxis: { type: "category", axisLine: { lineStyle: { color: colors.grid } }, axisLabel: { color: colors.muted }, splitLine: { show: false } },
  yAxis: { type: "value", axisLine: { show: false }, axisLabel: { color: colors.muted }, splitLine: { lineStyle: { color: colors.grid } } }
}

type Tab = "Command" | "Sleep" | "Cardio" | "Activity" | "Relations" | "Data"
const tabs: Tab[] = ["Command", "Sleep", "Cardio", "Activity", "Relations", "Data"]

const isoDate = (date: Date): string => new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Los_Angeles",
  year: "numeric",
  month: "2-digit",
  day: "2-digit"
}).format(date)
const dateDaysAgo = (days: number): string => {
  const date = new Date()
  date.setDate(date.getDate() - days)
  return isoDate(date)
}

const formatValue = (value: number | undefined, digits = 1): string =>
  value === undefined || !Number.isFinite(value) ? "—" : value.toLocaleString(undefined, { maximumFractionDigits: digits })

const metricDelta = (values: (number | undefined)[]): number | undefined => {
  const latest = [...values].reverse().find((value) => value !== undefined)
  const baseline = mean(values.slice(-29, -1))
  return latest === undefined || baseline === undefined ? undefined : latest - baseline
}

const metricOption = (
  points: DailyPoint[],
  series: { key: keyof DailyPoint; name: string; color: string; type?: "line" | "bar"; yAxisIndex?: number }[],
  stacked = false
) => ({
  ...chartBase,
  xAxis: { ...chartBase.xAxis, data: points.map((point) => point.day.slice(5)) },
  series: series.map((entry) => ({
    name: entry.name,
    type: entry.type ?? "line",
    data: points.map((point) => point[entry.key] ?? null),
    smooth: entry.type !== "bar" ? 0.22 : false,
    symbolSize: 5,
    showSymbol: points.length < 40,
    lineStyle: { width: 2, color: entry.color },
    itemStyle: { color: entry.color, opacity: .9 },
    areaStyle: entry.type === "line" ? { opacity: .04 } : undefined,
    stack: stacked ? "total" : undefined,
    yAxisIndex: entry.yAxisIndex ?? 0
  }))
})

function Panel({ title, meta, children, className = "" }: { title: string; meta?: string; children: ReactNode; className?: string }) {
  return <section className={`panel ${className}`}>
    <header className="panel-head"><h2>{title}</h2>{meta && <span>{meta}</span>}</header>
    {children}
  </section>
}

function Chart({ option, height = 290 }: { option: object; height?: number }) {
  return <ReactECharts option={option} style={{ height }} opts={{ renderer: "canvas" }} notMerge />
}

function Metric({ label, value, unit, delta, inverse = false }: { label: string; value?: number; unit?: string; delta?: number; inverse?: boolean }) {
  const deltaClass = delta === undefined ? "neutral" : (delta >= 0) !== inverse ? "positive" : "negative"
  return <div className="metric">
    <span>{label}</span>
    <strong>{formatValue(value)}<small>{value === undefined ? "" : unit}</small></strong>
    <em className={deltaClass}>{delta === undefined ? "no baseline" : `${delta >= 0 ? "+" : ""}${delta.toFixed(1)} vs base`}</em>
  </div>
}

const latest = (points: DailyPoint[], key: keyof DailyPoint): number | undefined => {
  for (let index = points.length - 1; index >= 0; index -= 1) {
    const value = points[index]?.[key]
    if (typeof value === "number") return value
  }
  return undefined
}

function CommandView({ points }: { points: DailyPoint[] }) {
  const scoreOption = metricOption(points, [
    { key: "readinessScore", name: "Readiness", color: colors.cyan },
    { key: "sleepScore", name: "Sleep", color: colors.violet },
    { key: "activityScore", name: "Activity", color: colors.green }
  ])
  const physio = metricOption(points, [
    { key: "averageHrv", name: "HRV ms", color: colors.cyan },
    { key: "lowestHeartRate", name: "Lowest HR", color: colors.pink },
    { key: "temperatureDeviation", name: "Temp Δ", color: colors.amber, type: "bar" }
  ])
  const anomalies = [
    ["Average HRV", "averageHrv"], ["Lowest heart rate", "lowestHeartRate"],
    ["Temperature deviation", "temperatureDeviation"], ["Total sleep", "totalSleepHours"],
    ["Steps", "steps"], ["Average SpO₂", "averageSpo2"]
  ] as const

  return <div className="dashboard-grid">
    <Panel title="System scores" meta="DAILY SIGNAL" className="span-8"><Chart option={scoreOption} /></Panel>
    <Panel title="Signal deviations" meta="LATEST VS WINDOW" className="span-4">
      <div className="deviation-list">
        {anomalies.map(([name, key]) => {
          const values = points.map((point) => point[key])
          const current = latest(points, key)
          const average = mean(values)
          const variance = mean(values.map((value) => value === undefined || average === undefined ? undefined : (value - average) ** 2))
          const z = current === undefined || average === undefined || !variance ? undefined : (current - average) / Math.sqrt(variance)
          return <div className="deviation" key={key}><span>{name}</span><b>{formatValue(current, 2)}</b><i>{z === undefined ? "—" : `${z >= 0 ? "+" : ""}${z.toFixed(2)}σ`}</i></div>
        })}
      </div>
    </Panel>
    <Panel title="Physiological signals" meta="HRV / RHR / TEMPERATURE" className="span-8"><Chart option={physio} /></Panel>
    <Panel title="Latest state vector" meta={points.at(-1)?.day ?? "NO PARTITION"} className="span-4">
      <div className="state-grid">
        {["readinessScore", "sleepScore", "activityScore", "averageHrv", "lowestHeartRate", "totalSleepHours", "sleepEfficiency", "averageSpo2", "steps", "stressHours"]
          .map((key) => <div key={key}><span>{key.replace(/([A-Z])/g, " $1")}</span><b>{formatValue(latest(points, key as keyof DailyPoint), 2)}</b></div>)}
      </div>
    </Panel>
  </div>
}

function ContributorHeatmap({ points, prefix }: { points: DailyPoint[]; prefix: string }) {
  const keys = [...new Set(points.flatMap((point) => Object.keys(point).filter((key) => key.startsWith(prefix))))]
  const data = points.flatMap((point, y) => keys.flatMap((key, x) => {
    const value = point[key as keyof DailyPoint]
    return typeof value === "number" ? [[x, y, value]] : []
  }))
  return <Chart height={300} option={{
    ...chartBase,
    grid: { left: 70, right: 15, top: 30, bottom: 85 },
    tooltip: { position: "top" },
    xAxis: { type: "category", data: keys.map((key) => key.split(".").at(-1)?.replaceAll("_", " ")), axisLabel: { rotate: 45, color: colors.muted } },
    yAxis: { type: "category", data: points.map((point) => point.day.slice(5)), axisLabel: { color: colors.muted } },
    visualMap: { min: 0, max: 100, calculable: false, orient: "horizontal", left: "center", top: 0, show: false, inRange: { color: ["#351829", "#7643c8", "#168fa5", "#61e7e0"] } },
    series: [{ type: "heatmap", data }]
  }} />
}

function SleepView({ points, records }: { points: DailyPoint[]; records: OuraRecord[] }) {
  const stages = metricOption(points, [
    { key: "deepSleepHours", name: "Deep", color: "#6157d9", type: "bar" },
    { key: "remSleepHours", name: "REM", color: colors.violet, type: "bar" },
    { key: "lightSleepHours", name: "Light", color: colors.blue, type: "bar" },
    { key: "awakeHours", name: "Awake", color: colors.amber, type: "bar" }
  ], true)
  const sleeps = records.filter((record) => record.data_type === "sleep")
  const latestSleep = [...sleeps].sort((a, b) => String(a.start_datetime).localeCompare(String(b.start_datetime))).at(-1)
  const phaseString = typeof latestSleep?.payload.sleep_phase_30_sec === "string" ? latestSleep.payload.sleep_phase_30_sec : ""
  const phaseOption = {
    ...chartBase,
    xAxis: { type: "category", data: [...phaseString].map((_, index) => index % 120 === 0 ? `${Math.floor(index / 120)}h` : ""), axisLabel: { color: colors.muted } },
    yAxis: { type: "value", min: 1, max: 4, interval: 1, axisLabel: { formatter: (value: number) => ["", "Deep", "Light", "REM", "Awake"][value] } },
    series: [{ type: "line", step: "end", symbol: "none", data: [...phaseString].map(Number), lineStyle: { width: 1.2, color: colors.violet }, areaStyle: { opacity: .09 } }]
  }
  return <div className="dashboard-grid">
    <Panel title="Sleep architecture" meta="HOURS BY STAGE" className="span-7"><Chart option={stages} height={310} /></Panel>
    <Panel title="Sleep score contributors" meta="0–100" className="span-5"><ContributorHeatmap points={points} prefix="sleepContributor." /></Panel>
    <Panel title="Latest sleep-stage trace" meta={`${latestSleep?.record_date ?? "—"} · 30S RESOLUTION`} className="span-12"><Chart option={phaseOption} height={250} /></Panel>
  </div>
}

function CardioView({ points, records }: { points: DailyPoint[]; records: OuraRecord[] }) {
  const heartRate = records.filter((record) => record.data_type === "heart_rate").map((record) => ({
    timestamp: String(record.payload.timestamp ?? record.start_datetime ?? ""),
    bpm: Number(record.payload.bpm),
    source: String(record.payload.source ?? "unknown")
  })).filter((row) => Number.isFinite(row.bpm))
  const sources = [...new Set(heartRate.map((row) => row.source))]
  const stream = {
    ...chartBase,
    xAxis: { type: "time", axisLabel: { color: colors.muted } },
    series: sources.map((source, index) => ({
      name: source, type: "scatter", symbolSize: 4,
      data: heartRate.filter((row) => row.source === source).map((row) => [row.timestamp, row.bpm]),
      itemStyle: { color: [colors.pink, colors.amber, colors.cyan, colors.green][index % 4] }
    }))
  }
  const distributionBins = Array.from({ length: 31 }, (_, index) => 40 + index * 3)
  const histogram = distributionBins.map((floor) => heartRate.filter((row) => row.bpm >= floor && row.bpm < floor + 3).length)
  const distribution = {
    ...chartBase,
    xAxis: { type: "category", data: distributionBins, axisLabel: { color: colors.muted } },
    series: [{ type: "bar", data: histogram, itemStyle: { color: colors.pink } }]
  }
  const vascular = metricOption(points, [
    { key: "vascularAge", name: "Vascular age", color: colors.violet, type: "bar" },
    { key: "pulseWaveVelocity", name: "PWV", color: colors.cyan }
  ])
  return <div className="dashboard-grid">
    <Panel title="Heart-rate event stream" meta={`${heartRate.length.toLocaleString()} EVENTS`} className="span-8"><Chart option={stream} height={330} /></Panel>
    <Panel title="Heart-rate distribution" meta="3 BPM BUCKETS" className="span-4"><Chart option={distribution} height={330} /></Panel>
    <Panel title="Vascular telemetry" meta="CVA / PWV" className="span-12"><Chart option={vascular} height={270} /></Panel>
  </div>
}

function ActivityView({ points, records }: { points: DailyPoint[]; records: OuraRecord[] }) {
  const movement = metricOption(points, [
    { key: "steps", name: "Steps", color: colors.blue, type: "bar" },
    { key: "activeCalories", name: "Active kcal", color: colors.amber }
  ])
  const intensity = metricOption(points, [
    { key: "sedentaryHours", name: "Sedentary", color: "#46546b", type: "bar" },
    { key: "lowActivityHours", name: "Low", color: colors.blue, type: "bar" },
    { key: "mediumActivityHours", name: "Medium", color: colors.cyan, type: "bar" },
    { key: "highActivityHours", name: "High", color: colors.green, type: "bar" }
  ], true)
  const stress = metricOption(points, [
    { key: "stressHours", name: "Stress", color: colors.red, type: "bar" },
    { key: "recoveryHours", name: "Recovery", color: colors.green, type: "bar" }
  ])
  const workouts = records.filter((record) => record.data_type === "workout")
  return <div className="dashboard-grid">
    <Panel title="Movement + energy" meta="STEPS / CALORIES" className="span-7"><Chart option={movement} /></Panel>
    <Panel title="Movement intensity budget" meta="HOURS / DAY" className="span-5"><Chart option={intensity} /></Panel>
    <Panel title="Activity contributors" meta="0–100" className="span-7"><ContributorHeatmap points={points} prefix="activityContributor." /></Panel>
    <Panel title="Stress / recovery allocation" meta="HOURS" className="span-5"><Chart option={stress} height={300} /></Panel>
    <Panel title="Workout event log" meta={`${workouts.length} EVENTS`} className="span-12">
      <div className="table-wrap"><table><thead><tr><th>Day</th><th>Activity</th><th>Intensity</th><th>Calories</th><th>Distance</th><th>Source</th></tr></thead>
        <tbody>{workouts.map((record) => <tr key={record.record_id}><td>{record.record_date}</td><td>{String(record.payload.activity ?? record.payload.label ?? "—")}</td><td>{String(record.payload.intensity ?? "—")}</td><td>{formatValue(Number(record.payload.calories))}</td><td>{formatValue(Number(record.payload.distance) / 1000)} km</td><td>{String(record.payload.source ?? "—")}</td></tr>)}</tbody>
      </table></div>
    </Panel>
  </div>
}

const relationMetrics = [
  ["Readiness", "readinessScore"], ["Sleep score", "sleepScore"], ["Activity", "activityScore"],
  ["Average HRV", "averageHrv"], ["Lowest HR", "lowestHeartRate"], ["Total sleep", "totalSleepHours"],
  ["Deep sleep", "deepSleepHours"], ["REM sleep", "remSleepHours"], ["Sleep efficiency", "sleepEfficiency"],
  ["Temperature", "temperatureDeviation"], ["Steps", "steps"], ["Stress", "stressHours"], ["SpO₂", "averageSpo2"]
] as const

function RelationsView({ points }: { points: DailyPoint[] }) {
  const [xKey, setXKey] = useState<keyof DailyPoint>("totalSleepHours")
  const [yKey, setYKey] = useState<keyof DailyPoint>("readinessScore")
  const keys = relationMetrics.filter(([, key]) => points.some((point) => typeof point[key] === "number"))
  const matrix = keys.flatMap(([, left], y) => keys.map(([, right], x) => [x, y, pearson(points.map((point) => point[left]), points.map((point) => point[right])) ?? null]))
  const pair = points.flatMap((point) => {
    const x = point[xKey]
    const y = point[yKey]
    return typeof x === "number" && typeof y === "number" ? [[x, y, point.day]] : []
  })
  return <div className="dashboard-grid">
    <Panel title="Correlation matrix" meta={`N=${points.length} DAYS · PEARSON`} className="span-8"><Chart height={520} option={{
      ...chartBase,
      grid: { left: 100, right: 20, top: 20, bottom: 100 },
      xAxis: { type: "category", data: keys.map(([name]) => name), axisLabel: { rotate: 45, color: colors.muted } },
      yAxis: { type: "category", data: keys.map(([name]) => name), axisLabel: { color: colors.muted } },
      visualMap: { min: -1, max: 1, show: false, inRange: { color: [colors.red, "#151b27", colors.cyan] } },
      series: [{ type: "heatmap", data: matrix, label: { show: true, formatter: ({ value }: { value: [number, number, number | null] }) => value[2] === null ? "" : value[2].toFixed(2), color: "#dce7f5", fontSize: 9 } }]
    }} /></Panel>
    <Panel title="Relationship explorer" meta="INTERACTIVE PAIR" className="span-4">
      <div className="select-row"><select value={String(xKey)} onChange={(event) => setXKey(event.target.value as keyof DailyPoint)}>{keys.map(([name, key]) => <option value={key} key={key}>{name}</option>)}</select><span>×</span><select value={String(yKey)} onChange={(event) => setYKey(event.target.value as keyof DailyPoint)}>{keys.map(([name, key]) => <option value={key} key={key}>{name}</option>)}</select></div>
      <Chart height={390} option={{ ...chartBase, xAxis: { type: "value", axisLabel: { color: colors.muted } }, series: [{ type: "scatter", symbolSize: 11, data: pair, itemStyle: { color: colors.cyan, borderColor: "#dce7f5", borderWidth: 1 } }] }} />
      <div className="relation-score"><span>Pearson r</span><b>{formatValue(pearson(points.map((point) => point[xKey] as number | undefined), points.map((point) => point[yKey] as number | undefined)), 3)}</b><i>{pair.length} overlapping days</i></div>
    </Panel>
  </div>
}

function DataView({ status, records }: { status: ObservatoryStatus; records: OuraRecord[] }) {
  const [selected, setSelected] = useState(status.datasets[0]?.data_type ?? "")
  const subset = records.filter((record) => record.data_type === selected)
  return <div className="dashboard-grid">
    <Panel title="Dataset cardinality" meta={`${status.records.toLocaleString()} RECORDS`} className="span-5"><Chart height={340} option={{
      ...chartBase,
      grid: { left: 130, right: 20, top: 20, bottom: 20 },
      xAxis: { type: "value", axisLabel: { color: colors.muted } },
      yAxis: { type: "category", data: status.datasets.map((item) => item.data_type), axisLabel: { color: colors.muted } },
      series: [{ type: "bar", data: status.datasets.map((item) => item.count), itemStyle: { color: colors.cyan } }]
    }} /></Panel>
    <Panel title="Storage plane" meta="D1 / LOSSLESS JSON" className="span-7"><div className="storage-stats"><div><span>Daily partitions</span><b>{status.days}</b></div><div><span>First partition</span><b>{status.first_date ?? "—"}</b></div><div><span>Latest partition</span><b>{status.last_date ?? "—"}</b></div><div><span>Last ingest</span><b>{status.last_sync?.replace("T", " ").slice(0, 19) ?? "—"}</b></div></div></Panel>
    <Panel title="Raw event inspector" meta="SOURCE PAYLOADS" className="span-12">
      <div className="inspector-head"><select value={selected} onChange={(event) => setSelected(event.target.value)}>{status.datasets.map((item) => <option key={item.data_type}>{item.data_type}</option>)}</select><span>{subset.length.toLocaleString()} rows in selected window</span></div>
      <pre className="raw-json">{JSON.stringify(subset.slice(0, 25), null, 2)}</pre>
    </Panel>
  </div>
}

export function App() {
  const [status, setStatus] = useState<ObservatoryStatus | null>(null)
  const [records, setRecords] = useState<OuraRecord[]>([])
  const [activeTab, setActiveTab] = useState<Tab>("Command")
  const [windowDays, setWindowDays] = useState(90)
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [statusResponse, recordsResponse] = await Promise.all([
        fetch("/api/status"),
        fetch(`/api/records?start=${dateDaysAgo(windowDays)}&end=${isoDate(new Date())}`)
      ])
      if (!statusResponse.ok || !recordsResponse.ok) throw new Error("The telemetry API did not respond successfully")
      setStatus(await statusResponse.json() as ObservatoryStatus)
      setRecords(await recordsResponse.json() as OuraRecord[])
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to load telemetry")
    } finally {
      setLoading(false)
    }
  }, [windowDays])

  useEffect(() => { void load() }, [load])
  const points = useMemo(() => buildDailyPoints(records), [records])
  const sync = async () => {
    setSyncing(true)
    setError(null)
    try {
      const response = await fetch("/api/sync", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ start: dateDaysAgo(windowDays), end: isoDate(new Date()) }) })
      if (!response.ok) {
        const body = await response.json() as { message?: string }
        throw new Error(body.message ?? "Sync failed")
      }
      await load()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Sync failed")
    } finally {
      setSyncing(false)
    }
  }

  if (loading && !status) return <div className="boot"><div className="boot-ring" /><span>HYDRATING TELEMETRY PLANE</span></div>
  if (!status) return <div className="boot error"><span>{error ?? "Observatory unavailable"}</span><button onClick={() => void load()}>Retry</button></div>

  const view = activeTab === "Command" ? <CommandView points={points} />
    : activeTab === "Sleep" ? <SleepView points={points} records={records} />
    : activeTab === "Cardio" ? <CardioView points={points} records={records} />
    : activeTab === "Activity" ? <ActivityView points={points} records={records} />
    : activeTab === "Relations" ? <RelationsView points={points} />
    : <DataView status={status} records={records} />

  return <div className="app-shell">
    <aside>
      <div className="brand"><div className="brand-mark"><i /><i /><i /></div><div><strong>OURA // OBS</strong><span>BODY TELEMETRY</span></div></div>
      <div className="connection"><span className={status.connected ? "live" : "idle"} />{status.connected ? "API CONNECTED" : "AUTH REQUIRED"}</div>
      <nav>{tabs.map((tab) => <button className={tab === activeTab ? "active" : ""} onClick={() => setActiveTab(tab)} key={tab}><span>{tab.slice(0, 2).toUpperCase()}</span>{tab}</button>)}</nav>
      <div className="control-block"><label>WINDOW</label><div className="window-buttons">{[7, 30, 90, 365].map((days) => <button className={days === windowDays ? "active" : ""} onClick={() => setWindowDays(days)} key={days}>{days === 365 ? "1Y" : `${days}D`}</button>)}</div></div>
      <div className="ingest-block"><label>INGEST STATUS</label><div><span>Records</span><b>{status.records.toLocaleString()}</b></div><div><span>Datasets</span><b>{status.datasets.length}</b></div><small>Last sync<br />{status.last_sync?.replace("T", " ").slice(0, 19) ?? "never"}</small></div>
      {status.connected ? <button className="primary" disabled={syncing} onClick={() => void sync()}>{syncing ? "SYNCING…" : "↻ SYNC OURA NOW"}</button> : <a className="primary" href="/oauth/start">CONNECT OURA</a>}
      <div className="sidebar-foot"><span>MODE</span><b>{status.mode.toUpperCase()}</b><small>D1 · WORKERS · ACCESS</small></div>
    </aside>
    <main>
      <header className="topbar"><div><span className="eyebrow">PERSONAL SYSTEMS TELEMETRY</span><h1>Body observability console</h1><p>{dateDaysAgo(windowDays)} → {isoDate(new Date())} · {points.length} daily partitions · {records.filter((record) => record.data_type === "heart_rate").length.toLocaleString()} HR events</p></div><div className="pipeline"><span /><div><b>PIPELINE HEALTHY</b><small>ACCESS PROTECTED</small></div></div></header>
      {error && <div className="alert">{error}<button onClick={() => setError(null)}>×</button></div>}
      <div className="metric-strip">
        <Metric label="Readiness" value={latest(points, "readinessScore")} delta={metricDelta(points.map((point) => point.readinessScore))} />
        <Metric label="Sleep score" value={latest(points, "sleepScore")} delta={metricDelta(points.map((point) => point.sleepScore))} />
        <Metric label="Activity" value={latest(points, "activityScore")} delta={metricDelta(points.map((point) => point.activityScore))} />
        <Metric label="HRV" value={latest(points, "averageHrv")} unit=" ms" delta={metricDelta(points.map((point) => point.averageHrv))} />
        <Metric label="RHR min" value={latest(points, "lowestHeartRate")} unit=" bpm" delta={metricDelta(points.map((point) => point.lowestHeartRate))} inverse />
        <Metric label="Sleep" value={latest(points, "totalSleepHours")} unit=" h" delta={metricDelta(points.map((point) => point.totalSleepHours))} />
        <Metric label="SpO₂" value={latest(points, "averageSpo2")} unit="%" delta={metricDelta(points.map((point) => point.averageSpo2))} />
        <Metric label="Temp Δ" value={latest(points, "temperatureDeviation")} unit="°C" delta={metricDelta(points.map((point) => point.temperatureDeviation))} inverse />
      </div>
      <div className="mobile-tabs">{tabs.map((tab) => <button className={tab === activeTab ? "active" : ""} onClick={() => setActiveTab(tab)} key={tab}>{tab}</button>)}</div>
      {points.length === 0 && activeTab !== "Data" ? <div className="empty"><b>NO DAILY TELEMETRY IN THIS WINDOW</b><span>Widen the range, import the existing database, or sync Oura.</span></div> : view}
      <footer>OURA OBSERVATORY · PROCESSED WELLNESS TELEMETRY · NOT RAW PPG OR ACCELEROMETER DATA · NOT MEDICAL ADVICE</footer>
    </main>
  </div>
}
