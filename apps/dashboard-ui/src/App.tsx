import { lazy, Suspense, useEffect, useMemo, useState } from "react"
import { baselineFor, buildDailyPoints, indexRecordRange, indexRecords, localDay, shiftDay, type DailyPoint, type ObservatoryStatus, type OuraRecord, type RecordsPage } from "@oura/shared"
import { Empty, fmt, palette, Timeline, Trend } from "./Dashboard"
import { JevDebug } from "./JevDebug"

const SleepView = lazy(() => import("./SleepView").then(({ SleepView }) => ({ default: SleepView })))
const CardioView = lazy(() => import("./MetricViews").then(({ CardioView }) => ({ default: CardioView })))
const ActivityView = lazy(() => import("./MetricViews").then(({ ActivityView }) => ({ default: ActivityView })))
const ExploreView = lazy(() => import("./ExploreView").then(({ ExploreView }) => ({ default: ExploreView })))
const Debrief = lazy(() => import("./Debrief").then(({ Debrief }) => ({ default: Debrief })))
const Experiments = lazy(() => import("./Experiments").then(({ Experiments }) => ({ default: Experiments })))
const DataView = lazy(() => import("./DataView").then(({ DataView }) => ({ default: DataView })))

const tabs = ["Today", "Sleep", "Cardio", "Activity", "Explore", "Debrief", "Experiments", "Data"] as const
type Tab = typeof tabs[number]

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

function ViewLoading({ tab }: { tab: Tab }) {
  return <div className="loading" role="status" aria-live="polite">Loading {tab}…</div>
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
  const recordIndex = useMemo(() => indexRecords(records), [records])
  const visibleRecordIndex = useMemo(() => indexRecordRange(recordIndex, start, day), [recordIndex, start, day])
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
      <Suspense fallback={<ViewLoading tab={tab} />}>
        {tab === "Debrief" ? <Debrief records={records} onDirty={setDebriefDirty} /> : tab === "Experiments" ? <Experiments /> : loading ? <div className="loading" role="status">Gathering your measurements…</div> : error && !records.length ? <Empty>Data unavailable. Retry above; incomplete results are not displayed.</Empty> : <>
          {tab !== "Today" && <header className="page-title"><span className="eyebrow">{start} — {day}</span><h1>{{ Sleep: "Make room for rest.", Cardio: "Listen over the long run.", Activity: "Movement, in perspective.", Explore: "Curiosity, with context.", Data: "Know what you’re seeing." }[tab]}</h1></header>}
          {tab === "Today" ? <><Brief points={allPoints} day={day} /><Timeline key={day} index={recordIndex} day={day} /><div className="dashboard-grid"><Trend points={points} history={allPoints} metric="totalSleepHours" title="A longer view of sleep" unit="h" /><Trend points={points} history={allPoints} metric="averageHrv" title="Your overnight HRV" unit="ms" color={palette[1]} /></div></>
            : tab === "Sleep" ? <SleepView key={day} points={points} history={allPoints} index={recordIndex} day={day} />
            : tab === "Cardio" ? <CardioView points={points} history={allPoints} index={visibleRecordIndex} />
            : tab === "Activity" ? <ActivityView points={points} history={allPoints} index={visibleRecordIndex} />
            : tab === "Explore" ? <ExploreView points={points} history={allPoints} start={start} end={day} index={visibleRecordIndex} onDirty={setDebriefDirty} /> : status && <DataView status={status} index={visibleRecordIndex} />}
        </>}
      </Suspense>
      <JevDebug />
      <footer><span>Oura Observatory</span><span>Personal patterns, not medical advice. Missing data is never zero.</span></footer>
    </main>
  </div>
}
