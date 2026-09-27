import { lazy, Suspense, useEffect, useMemo, useState } from "react"
import { baselineFor, indexRecordRange, indexRecords, localDay, shiftDay, type DailyPoint, type ObservatoryStatus, type OuraRecord } from "@oura/shared"
import { Empty, fmt, palette, Timeline, Trend } from "./Dashboard"
import { JevDebug } from "./JevDebug"
import { DashboardSkeleton, TimelineSkeleton } from "./Loading"
import { loadCompleteHistory, loadDailySummaries, loadSelectedDay, loadStatus } from "./data"

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
  const [status, setStatus] = useState<ObservatoryStatus | null>(null), [statusError, setStatusError] = useState<string | null>(null)
  const [allPoints, setAllPoints] = useState<DailyPoint[]>([]), [summariesLoading, setSummariesLoading] = useState(true), [summariesError, setSummariesError] = useState<string | null>(null), [summariesKey, setSummariesKey] = useState("")
  const [dayRecords, setDayRecords] = useState<OuraRecord[]>([]), [dayLoading, setDayLoading] = useState(true), [dayError, setDayError] = useState<string | null>(null), [dayKey, setDayKey] = useState("")
  const [completeRecords, setCompleteRecords] = useState<OuraRecord[]>([]), [completeLoading, setCompleteLoading] = useState(false), [completeError, setCompleteError] = useState<string | null>(null), [completeKey, setCompleteKey] = useState("")
  const [actionError, setActionError] = useState<string | null>(null), [syncing, setSyncing] = useState(false), [refresh, setRefresh] = useState(0)
  const start = shiftDay(day, -(windowDays - 1)), historyStart = shiftDay(start, -Math.min(28, 367 - windowDays))
  const needsSelectedDay = tab === "Today" || tab === "Sleep"
  const needsCompleteHistory = tab === "Cardio" || tab === "Activity" || tab === "Data"
  const expectedSummariesKey = `${historyStart}:${day}:${refresh}`, expectedDayKey = `${day}:${refresh}`, expectedCompleteKey = `${start}:${day}:${refresh}`
  const summariesPending = summariesLoading || (summariesKey !== expectedSummariesKey && !summariesError)
  const dayPending = dayLoading || (dayKey !== expectedDayKey && !dayError)
  const completePending = completeLoading || (completeKey !== expectedCompleteKey && !completeError)

  useEffect(() => {
    const controller = new AbortController()
    setStatusError(null)
    void loadStatus(fetch, controller.signal).then((next) => { if (!controller.signal.aborted) setStatus(next) })
      .catch((reason) => { if (!controller.signal.aborted) setStatusError(reason instanceof Error ? reason.message : "Connection status is unavailable.") })
    return () => controller.abort()
  }, [refresh])

  useEffect(() => {
    const controller = new AbortController()
    setSummariesLoading(true); setSummariesError(null); setSummariesKey(""); setAllPoints([])
    void loadDailySummaries(fetch, historyStart, day, controller.signal)
      .then((result) => { if (!controller.signal.aborted) { setAllPoints(result.days); setSummariesKey(expectedSummariesKey) } })
      .catch((reason) => { if (!controller.signal.aborted) setSummariesError(reason instanceof Error ? reason.message : "Daily history is unavailable.") })
      .finally(() => { if (!controller.signal.aborted) setSummariesLoading(false) })
    return () => controller.abort()
  }, [day, historyStart, refresh])

  useEffect(() => {
    if (!needsSelectedDay || dayKey === expectedDayKey) return
    const controller = new AbortController()
    setDayLoading(true); setDayError(null); setDayKey(""); setDayRecords([])
    void loadSelectedDay(fetch, day, controller.signal)
      .then((result) => { if (!controller.signal.aborted) { setDayRecords(result.records); setDayKey(expectedDayKey) } })
      .catch((reason) => { if (!controller.signal.aborted) setDayError(reason instanceof Error ? reason.message : "Selected-day detail is unavailable.") })
      .finally(() => { if (!controller.signal.aborted) setDayLoading(false) })
    return () => controller.abort()
  }, [day, needsSelectedDay, refresh])

  useEffect(() => {
    if (!needsCompleteHistory || completeKey === expectedCompleteKey) return
    const controller = new AbortController()
    setCompleteLoading(true); setCompleteError(null); setCompleteKey(""); setCompleteRecords([])
    void loadCompleteHistory(fetch, start, day, controller.signal)
      .then((result) => { if (!controller.signal.aborted) { setCompleteRecords(result); setCompleteKey(expectedCompleteKey) } })
      .catch((reason) => { if (!controller.signal.aborted) setCompleteError(reason instanceof Error ? reason.message : "Complete record history is unavailable.") })
      .finally(() => { if (!controller.signal.aborted) setCompleteLoading(false) })
    return () => controller.abort()
  }, [day, needsCompleteHistory, refresh, start])

  const points = useMemo(() => Array.from({ length: windowDays }, (_, index) => allPoints.find((point) => point.day === shiftDay(start, index)) ?? { day: shiftDay(start, index) }), [allPoints, start, windowDays])
  const dayRecordIndex = useMemo(() => indexRecords(dayRecords), [dayRecords])
  const recordIndex = useMemo(() => indexRecords(completeRecords), [completeRecords])
  const visibleRecordIndex = useMemo(() => indexRecordRange(recordIndex, start, day), [recordIndex, start, day])
  const sync = async () => {
    if (debriefDirty && !confirm("Sync will refresh this view. Discard your unsaved context draft or pending result?")) return
    setSyncing(true); setActionError(null)
    try {
      const response = await fetch("/api/sync", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ start: historyStart, end: day }) })
      const result = await response.json() as { message?: string; skipped?: Record<string, string> }
      if (!response.ok) throw new Error(result.message ?? "Sync failed")
      setRefresh((value) => value + 1)
    } catch (reason) { setActionError(reason instanceof Error ? reason.message : "Sync failed") }
    finally { setSyncing(false) }
  }
  const syncIssues = Object.entries(status?.sync?.skipped ?? {})
  const retry = () => setRefresh((value) => value + 1)
  const connectionLabel = summariesPending ? "Loading daily summaries…" : needsSelectedDay && dayPending ? "Daily summaries ready · loading selected day…" : !status ? "Connection status unavailable" : status.connected ? "Oura connected" : "Oura not connected"
  const selectedDayUnavailable = <section className="panel timeline detail-unavailable"><header className="panel-head"><div><span className="eyebrow">THE BODY TIMELINE</span><h2>Selected-day detail unavailable.</h2></div></header><p>{dayError}</p><p className="caption">This is not the same as a day with no measurements. Retry before interpreting the gap.</p><button onClick={retry}>Retry selected day</button></section>
  const pageTitle = tab !== "Today" && tab !== "Debrief" && tab !== "Experiments" ? <header className="page-title"><span className="eyebrow">{start} — {day}</span><h1>{{ Sleep: "Make room for rest.", Cardio: "Listen over the long run.", Activity: "Movement, in perspective.", Explore: "Curiosity, with context.", Data: "Know what you’re seeing." }[tab]}</h1></header> : null

  return <div className="app-shell">
    <header className="site-header"><a className="brand" href="#" onClick={(event) => { event.preventDefault(); changeTab("Today") }}><span className="brand-mark">◯</span><span>oura <b>observatory</b></span></a><span className="private-label">{!status ? "Connection unverified" : status.mode === "production" ? "Private · Access protected" : "Local preview · not production data"}</span></header>
    <div className="toolbar"><nav aria-label="Main navigation">{tabs.map((name) => <button key={name} aria-current={tab === name ? "page" : undefined} onClick={() => changeTab(name)}>{name}</button>)}</nav><fieldset className="date-controls" disabled={debriefDirty} title={debriefDirty ? "Save or close your context draft before changing the history window" : undefined}><button aria-label="Previous day" onClick={() => setDay(shiftDay(day, -1))}>‹</button><label><span className="sr-only">Selected date</span><input type="date" value={day} max={today} onChange={(event) => { if (/^\d{4}-\d{2}-\d{2}$/.test(event.target.value) && event.target.value <= today) setDay(event.target.value) }} /></label><button aria-label="Next day" disabled={day >= today} onClick={() => setDay(shiftDay(day, 1))}>›</button><label><span className="sr-only">History range</span><select value={windowDays} onChange={(event) => setWindowDays(Number(event.target.value))}>{[7, 30, 90, 365].map((days) => <option key={days} value={days}>{days === 365 ? "1 year" : `${days} days`}</option>)}</select></label></fieldset></div>
    <main><div className="coverage-bar"><span>{connectionLabel} · Eastern time</span><div><button onClick={() => changeTab("Data")}>Coverage & sync {syncIssues.length ? `· ${syncIssues.length} issues` : "↗"}</button>{status?.connected ? <button disabled={syncing || summariesPending} onClick={() => void sync()}>{syncing ? "Syncing…" : "Sync Oura"}</button> : <a href="/oauth/start">Connect Oura ↗</a>}</div></div>
      <p className="demo-notice">{!status ? "VERIFYING DATA SOURCE · Measurements remain private while connection status loads." : status.mode !== "production" ? "LOCAL PREVIEW · Records shown here are local/imported data, not verified production measurements. Review screenshots use the repository’s synthetic demo." : "PRIVATE DATA · Access protected. Measurements are loaded for this session only and are not persisted in the browser."}</p>
      {syncIssues.length > 0 && <div className="alert" role="status">Last sync was incomplete: {syncIssues.map(([type, reason]) => `${type}: ${reason}`).join(" · ")}. See Data for coverage.</div>}
      {(actionError || statusError) && <div className="alert" role="alert">{actionError ?? statusError} <button onClick={retry}>Retry</button></div>}
      <Suspense fallback={<ViewLoading tab={tab} />}>
        {tab === "Debrief" ? <Debrief onDirty={setDebriefDirty} /> : tab === "Experiments" ? <Experiments /> : <>
          {pageTitle}
          {tab === "Data" ? completePending ? <DashboardSkeleton /> : completeError ? <Empty>{completeError} No partial coverage is displayed.</Empty> : status ? <DataView status={status} index={visibleRecordIndex} /> : <Empty>Connection and coverage status is unavailable.</Empty>
            : summariesPending ? <DashboardSkeleton today={tab === "Today"} /> : summariesError ? <Empty>{summariesError} Retry above; incomplete summaries are not displayed.</Empty>
            : tab === "Today" ? <><Brief points={allPoints} day={day} />{dayPending ? <TimelineSkeleton /> : dayError ? selectedDayUnavailable : <Timeline key={day} index={dayRecordIndex} day={day} />}<div className="dashboard-grid"><Trend points={points} history={allPoints} metric="totalSleepHours" title="A longer view of sleep" unit="h" /><Trend points={points} history={allPoints} metric="averageHrv" title="Your overnight HRV" unit="ms" color={palette[1]} /></div></>
            : tab === "Sleep" ? dayPending ? <><TimelineSkeleton /><div className="dashboard-grid"><Trend points={points} history={allPoints} metric="totalSleepHours" title="Main sleep duration" unit="h" /><Trend points={points} history={allPoints} metric="sleepScore" title="Sleep score" unit="/ 100" color={palette[2]} /></div></> : dayError ? selectedDayUnavailable : <SleepView key={day} points={points} history={allPoints} index={dayRecordIndex} day={day} />
            : tab === "Cardio" ? <CardioView points={points} history={allPoints} index={visibleRecordIndex} loading={completePending} error={completeError} />
            : tab === "Activity" ? <ActivityView points={points} history={allPoints} index={visibleRecordIndex} loading={completePending} error={completeError} />
            : <ExploreView points={points} history={allPoints} start={start} end={day} onDirty={setDebriefDirty} />}
        </>}
      </Suspense>
      <JevDebug />
      <footer><span>Oura Observatory</span><span>Personal patterns, not medical advice. Missing data is never zero.</span></footer>
    </main>
  </div>
}
