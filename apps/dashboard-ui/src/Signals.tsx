import { useEffect, useMemo, useState } from "react"
import { shiftDay, type DailyPoint } from "@oura/shared"
import { contextTopics, type ContextRevision, type ContextTopic } from "@oura/shared/context"
import { compareContext, contextInterval, contextPairs, stressSignal, type ContextPair } from "@oura/shared/signals"
import { contextRequest } from "./Debrief"

const fmt = (v: number | null | undefined) => v == null ? "—" : v.toFixed(2)
export function Signals({ points, start, end }: { points: DailyPoint[]; start: string; end: string }) {
  const [context, setContext] = useState<ContextRevision[]>([]), [error, setError] = useState(""), [loading, setLoading] = useState(true)
  const [topic, setTopic] = useState<ContextTopic>("evening_work"), [lag, setLag] = useState<0 | 1>(0)
  const [comparison, setComparison] = useState<{ topic: ContextTopic; lag: 0 | 1 } | null>(null)
  useEffect(() => { let active = true; setLoading(true); setError(""); setContext([]); setComparison(null)
    void contextRequest<ContextRevision[]>(`/api/context?start=${start}&end=${end}`).then(v => { if (active) setContext(v) }).catch(e => { if (active) setError(e.message) }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [start, end])
  const signal = stressSignal(points, end)
  const rows = useMemo(() => comparison ? contextPairs(points, context, start, end, comparison.topic, comparison.lag) : [], [points, context, start, end, comparison])
  const summary = compareContext(rows), interval = useMemo(() => contextInterval(rows), [rows])
  const strata: [string, (r: ContextPair) => boolean][] = [
    ["Weekday", r => !r.weekend], ["Weekend", r => r.weekend],
    ["Overnight sleep <7h", r => r.sleep !== undefined && r.sleep < 7], ["Overnight sleep ≥7h", r => r.sleep !== undefined && r.sleep >= 7],
    ["Sleep not measured", r => r.sleep === undefined],
    ...(comparison?.topic === "travel" ? [] : [["Travel present", (r: ContextPair) => r.travel === "present"], ["Travel explicitly absent", (r: ContextPair) => r.travel === "absent"], ["Travel unknown/conflicting", (r: ContextPair) => !["present", "absent"].includes(r.travel)]] as [string, (r: ContextPair) => boolean][])
  ]
  return <section className="panel wide signal-detective"><span className="eyebrow">SIGNAL DETECTIVE · OBSERVATIONAL PILOT</span><h2>Notice a change. Ask what else changed.</h2>
    <div className="lab-periods"><div><span className="eyebrow">{end} · DAILY HIGH-STRESS TIME</span><strong>{fmt(signal.value)} <small>h/day</small></strong><p>{signal.value === undefined ? "No measured daily total." : "Daily aggregate, not an event-level stress trace."}</p></div><div><span className="eyebrow">PRIOR 28 DAYS · EXCLUDES SELECTED DAY</span><strong>{fmt(signal.baseline)} <small>h/day mean</small></strong><p>{signal.n}/28 measured · {shiftDay(end, -28)} → {shiftDay(end, -1)}</p></div><div><span className="eyebrow">DETERMINISTIC SCREEN</span><strong>{signal.value === undefined || signal.threshold === null ? "Insufficient" : signal.elevated ? "Elevated" : "Within screen"}</strong><p>{signal.threshold === null ? "14 baseline days required." : `Flag above ${fmt(signal.threshold)} h/day: mean + max(0.5h, one sample SD).`}</p></div></div>
    <p className="caption">This transparent pilot threshold is not a clinical threshold or statistical significance test. Today may be incomplete. A daily Oura total cannot tell us that a specific meeting caused stress.</p>
    <h3>Choose the comparison before looking.</h3><p>Only human-accepted Debrief labels are used. This view never sends outcomes to Jev. No inference calls run here; no exposures or lags are ranked by their result.</p>
    <div className="select-row"><label>Context to compare<select value={topic} onChange={e => { setTopic(e.target.value as ContextTopic); setComparison(null) }}>{(Object.keys(contextTopics) as ContextTopic[]).map(k => <option key={k} value={k}>{contextTopics[k][0]}</option>)}</select></label><label>Declared pairing<select value={lag} onChange={e => { setLag(Number(e.target.value) as 0 | 1); setComparison(null) }}><option value={0}>Context → same-day stress</option><option value={1}>Context → next-day stress</option></select></label></div>
    <button disabled={loading || !!error} onClick={() => setComparison({ topic, lag })}>Compare accepted history</button>
    {loading && <p role="status">Loading accepted context…</p>}{error && <p role="alert" className="alert">Context unavailable: {error}. No partial comparison is shown.</p>}
    {!loading && !error && <p className="caption">{context.length} accepted daily entries in {start} → {end}. Unlogged days are unknown, never control days.</p>}
    {comparison && !loading && !error && <><div className="lab-periods"><div><span className="eyebrow">PRESENT</span><strong>{fmt(summary.presentMean)} <small>h/day</small></strong><p>{summary.present} measured pairs</p></div><div><span className="eyebrow">EXPLICITLY ABSENT</span><strong>{fmt(summary.absentMean)} <small>h/day</small></strong><p>{summary.absent} measured pairs</p></div><div><span className="eyebrow">PRESENT − ABSENT</span><strong>{fmt(summary.difference)} <small>h/day</small></strong><p>Descriptive association, not an effect.</p></div></div>
      <p>{interval ? `Exploratory 95% block-bootstrap interval: ${fmt(interval[0])} to ${fmt(interval[1])} h/day.` : "Uncertainty interval withheld: need ≥28 calendar days, ≥7 measured pairs in each group, and ≥900 valid resamples."}</p>
      <p className="caption">{summary.unknown} unknown labels · {summary.conflicting} conflicting labels · {summary.missing} missing/unavailable outcome pairs (counts overlap). These remain in the ledger but cannot enter the present-versus-absent means. Next-day outcomes beyond the loaded window are unavailable, not zero.</p>
      <details><summary>Contextual complications · stratified checks</summary><p>Compare the direction within these strata. Sparse or unbalanced groups can explain an apparent pattern. These are descriptive checks, not an adjusted causal model.</p><div className="table-wrap"><table><thead><tr><th>Exposure-day stratum</th><th>Present n</th><th>Absent n</th><th>Difference h/day</th></tr></thead><tbody>{strata.map(([label, filter]) => { const s = compareContext(rows.filter(filter)); return <tr key={label}><td>{label}</td><td>{s.present}</td><td>{s.absent}</td><td>{fmt(s.difference)}</td></tr> })}</tbody></table></div></details>
      <details><summary>Every paired day · source & missingness</summary><div className="table-wrap"><table><thead><tr><th>Context → outcome</th><th>Accepted label</th><th>Stress h/day</th><th>Context revision / accepted at</th></tr></thead><tbody>{rows.map(r => <tr key={r.day}><td>{r.day} → {r.outcomeDay}</td><td>{r.label}</td><td>{fmt(r.value)}</td><td>{r.revision ? `v${r.revision} · ${r.savedAt}` : "Not logged"}</td></tr>)}</tbody></table></div></details>
      <details><summary>Method & limits · keep the uncertainty visible</summary><p>1,000 circular bootstrap resamples of seven consecutive calendar days, preserving gaps and label/outcome pairing. Fixed seed 20260926; empirical 2.5th and 97.5th percentiles of present-minus-absent means. A seven-day block is a declared heuristic, not a proven dependence length. Few weeks, nonstationary routines and selective logging can make the interval unreliable. Repeatedly trying topics or lags introduces multiple-comparison bias; the interval is not corrected for that search.</p><p>Sleep strata use the Oura-reported sleep total on the exposure date, usually the preceding night; 7h is a descriptive split, not a recommendation. Retrospective notes, partial-day denials, seasonality, medications and unmeasured factors can confound these comparisons. Source dates do not prove prospective capture. Classification confidence is separate from this sampling uncertainty, and neither establishes causality.</p></details>
    </>}
  </section>
}
