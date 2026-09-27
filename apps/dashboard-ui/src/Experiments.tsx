import { useEffect, useState, type FormEvent } from "react"
import { localDay, shiftDay } from "@oura/shared"
import { adherenceLabels, adherenceStates, experimentMetrics, summarizeExperiment, validateExperiment, type CheckIn, type EvidenceDay, type Experiment, type ExperimentEvidence, type ExperimentMetric, type ExperimentRevision, type ExperimentSnapshot } from "@oura/shared/experiments"
import { contextTopics, type ContextProposal, type ContextRevision, type ContextTopic } from "@oura/shared/context"
import { Chart } from "./Chart"
import { contextRequest, ProposalSource } from "./Debrief"

const metrics = Object.keys(experimentMetrics) as ExperimentMetric[]
const format = (value: number | null | undefined) => value == null || !Number.isFinite(value) ? "—" : value.toLocaleString(undefined, { maximumFractionDigits: 2 })
const dateTime = (value: string) => new Date(value).toLocaleString("en-US", { timeZone: "America/New_York", dateStyle: "medium", timeStyle: "short" })
const blankCheck: CheckIn = { adherence: "unknown", note: "", exclusion: "" }
async function api<T>(path = "", body?: unknown, method = "POST"): Promise<T> {
  const response = await fetch(`/api/experiments${path}`, body === undefined ? {} : { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  const data = await response.json()
  if (!response.ok) throw new Error(data.message ?? "Notebook request failed")
  return data as T
}
function newExperiment(): Experiment {
  const today = localDay(new Date())
  return { question: "", habit: "", primary: "sleepEfficiency", supporting: [], rules: { followed: "", partly: "", not_followed: "" },
    beforeStart: shiftDay(today, -14), beforeEnd: shiftDay(today, -1), start: today, end: shiftDay(today, 13), afterStart: "", afterEnd: "",
    alignment: 1, state: "draft", checkIns: {}, conclusion: "", revisionNote: "Initial plan" }
}
function PlanForm({ initial, save, cancel, busy }: { initial: Experiment; save: (e: Experiment) => Promise<void>; cancel: () => void; busy: boolean }) {
  const [e, set] = useState(initial), [validation, setValidation] = useState("")
  const field = <K extends keyof Experiment>(key: K, value: Experiment[K]) => set({ ...e, [key]: value })
  const submit = (event: FormEvent) => { event.preventDefault(); try { validateExperiment(e); setValidation(""); void save(e) } catch (error) { setValidation(String((error as Error).message)) } }
  return <form className="panel lab-form" onSubmit={submit}>
    <span className="eyebrow">THE PLAN · ALL EDITS ARE VERSIONED</span><h2>One question. A clear comparison.</h2>
    <label>Your question<input required maxLength={200} value={e.question} placeholder="Does an earlier dinner help my sleep?" onChange={v => field("question", v.target.value)} /></label>
    <label>The habit or change<textarea required maxLength={1000} value={e.habit} placeholder="Finish dinner before 7 PM." onChange={v => field("habit", v.target.value)} /></label>
    <div className="lab-form-grid"><label>Primary outcome<select value={e.primary} onChange={v => { const primary = v.target.value as ExperimentMetric; set({ ...e, primary, supporting: e.supporting.filter(k => k !== primary) }) }}>{metrics.map(k => <option key={k} value={k}>{experimentMetrics[k][0]} · {experimentMetrics[k][1]}</option>)}</select></label>
      <label>Exposure day → outcome day<select value={e.alignment} onChange={v => field("alignment", Number(v.target.value) as 0 | 1)}><option value={0}>Same calendar day</option><option value={1}>Following calendar day (e.g. next morning)</option></select></label></div>
    <p className="caption">Eastern calendar days. Oura sleep belongs to its reported day, usually the wake date. The same alignment applies to Before, During and After. This is a declared pairing, not a search for the best lag.</p>
    <details><summary>Supporting measures · {e.supporting.length}/4 selected</summary><div className="lab-checks">{metrics.filter(k => k !== e.primary).map(k => <label key={k}><input type="checkbox" checked={e.supporting.includes(k)} disabled={!e.supporting.includes(k) && e.supporting.length >= 4} onChange={v => field("supporting", v.target.checked ? [...e.supporting, k] : e.supporting.filter(x => x !== k))} />{experimentMetrics[k][0]}</label>)}</div></details>
    <fieldset><legend>What counts as adherence?</legend>{(["followed", "partly", "not_followed"] as const).map(key => <label key={key}>{adherenceLabels[key]}<input required maxLength={500} value={e.rules[key]} onChange={v => field("rules", { ...e.rules, [key]: v.target.value })} /></label>)}<p className="caption">Unanswered is always Unknown, never Not followed. Cohorts compare Followed with Not followed; partial and unknown days remain separate.</p></fieldset>
    <fieldset><legend>Review your comparison windows</legend><p className="caption">Defaults are planning conveniences, not a promise of sufficient evidence. Maximum total span: 366 days.</p><div className="lab-form-grid">{([ ["beforeStart", "Before · start"], ["beforeEnd", "Before · end"], ["start", "During · start"], ["end", "During · end"], ["afterStart", "After · start (optional)"], ["afterEnd", "After · end (optional)"] ] as const).map(([key, label]) => <label key={key}>{label}<input type="date" required={!key.startsWith("after")} value={e[key]} onChange={v => field(key, v.target.value)} /></label>)}</div></fieldset>
    <label>Lifecycle<select value={e.state} onChange={v => field("state", v.target.value as Experiment["state"])}>{["draft", "active", "paused", "finished"].map(s => <option key={s}>{s}</option>)}</select></label>
    <p className="caption">Pausing does not silently exclude dates. Record unknown adherence or an explicit exclusion reason for interrupted days.</p>
    <label>Reflection / conclusion<textarea maxLength={4000} value={e.conclusion} onChange={v => field("conclusion", v.target.value)} placeholder="What did you learn? What remains uncertain?" /></label>
    <label>Why this revision?<input required maxLength={500} value={e.revisionNote} onChange={v => field("revisionNote", v.target.value)} /></label>
    {validation && <p role="alert" className="alert">{validation}</p>}<div className="lab-actions"><button className="lab-primary" disabled={busy}>Save plan</button><button type="button" disabled={busy} onClick={cancel}>Cancel</button></div>
  </form>
}

function Comparison({ days, metric, cohorts = false }: { days: EvidenceDay[]; metric: ExperimentMetric; cohorts?: boolean }) {
  const groups = cohorts ? adherenceStates.map(key => ({ label: adherenceLabels[key], days: days.filter(d => d.period === "During" && d.checkIn.adherence === key) })) : ["Before", "During", "After"].map(label => ({ label, days: days.filter(d => d.period === label) })).filter(g => g.days.length)
  const summaries = groups.map(g => ({ ...g, ...summarizeExperiment(g.days, metric) }))
  const values = days.flatMap(d => d.values[metric] === undefined ? [] : [d.values[metric]!])
  const low = Math.min(...values), high = Math.max(...values)
  const before = summaries[0], during = summaries[cohorts ? 2 : 1]
  const difference = before?.mean != null && during?.mean != null ? (cohorts ? before.mean - during.mean : during.mean - before.mean) : null
  return <div className="lab-comparison"><h3>{cohorts ? "Adherence groups" : experimentMetrics[metric][0]}</h3>
    <div className="lab-periods">{summaries.map(g => <div key={g.label}><span className="eyebrow">{g.label}</span>{!cohorts && <p>{g.days[0]?.day} → {g.days.at(-1)?.day}</p>}<strong>{format(g.mean)} <small>{experimentMetrics[metric][1]}</small></strong><p>{g.n} measured · {g.missing} missing<br />{g.excluded} excluded · {g.pending} pending</p>
      {!cohorts && <svg className="lab-spark" viewBox="0 0 240 64" role="img" aria-label={`${g.label} daily ${experimentMetrics[metric][0]}, shared scale ${format(low)} to ${format(high)}. Exact values in the daily ledger.`}>{g.days.map((d, i) => {
        const value = d.values[metric], prior = g.days[i - 1]?.values[metric], x = 5 + i * 230 / Math.max(1, g.days.length - 1)
        const y = (v: number) => high === low ? 32 : 58 - (v - low) / (high - low) * 52
        return value === undefined ? null : <g key={d.day}>{prior !== undefined && <line x1={5 + (i - 1) * 230 / Math.max(1, g.days.length - 1)} x2={x} y1={y(prior)} y2={y(value)} stroke="#df9850" />}<circle cx={x} cy={y(value)} r={2.5} fill={d.checkIn.exclusion ? "#c98c97" : "#df9850"}><title>{d.outcomeDay}: {value} {experimentMetrics[metric][1]}{d.checkIn.exclusion ? ` · excluded: ${d.checkIn.exclusion}` : ""}</title></circle></g>
      })}</svg>}
    </div>)}</div>
    {!cohorts && <p className="caption">Daily plots share a vertical scale ({values.length ? `${format(low)}–${format(high)} ${experimentMetrics[metric][1]}` : "no measurements"}); each spans its labeled exposure window. Rose points are excluded from averages, not hidden.</p>}
    <p className="lab-difference">{difference === null ? "Not enough measurements for a difference." : `${cohorts ? "Followed − not followed" : "During − before"}: ${difference > 0 ? "+" : ""}${format(difference)} ${experimentMetrics[metric][2]}`}</p>
    {!cohorts && summaries[2] && <p className="lab-difference">{before?.mean != null && summaries[2].mean != null ? `After − before: ${format(summaries[2].mean - before.mean)} ${experimentMetrics[metric][2]}` : "After − before: not enough measurements."}</p>}
    {(before && before.n < 7 || during && during.n < 7) && <p className="caption">Sparse evidence: fewer than seven measured days in a comparison group. Seven is a coverage flag, not a significance threshold.</p>}
  </div>
}

function Evidence({ revision, evidence }: { revision: ExperimentRevision; evidence: ExperimentEvidence }) {
  const e = revision.experiment, days = evidence.days
  const [selected, setSelected] = useState<ExperimentMetric>(e.primary)
  const [inspect, setInspect] = useState(0)
  const active = days[Math.min(inspect, days.length - 1)]
  const charts = [e.primary, ...e.supporting]
  const option = { animation: false, textStyle: { color: "#bdaba1" }, tooltip: { trigger: "axis", renderMode: "richText" },
    grid: [{ left: 62, right: 22, top: 38, height: 160 }, { left: 62, right: 22, top: 240, height: 65 }, { left: 62, right: 22, top: 350, height: 45 }],
    xAxis: [0, 1, 2].map(i => ({ gridIndex: i, type: "category", data: days.map(d => d.day), axisLabel: { show: i === 2, formatter: (d: string) => d.slice(5), hideOverlap: true }, axisLine: { lineStyle: { color: "#493b3e" } } })),
    yAxis: [{ type: "value", name: experimentMetrics[selected][1], scale: true, splitLine: { lineStyle: { color: "#493b3e" } } }, { gridIndex: 1, type: "category", data: ["Unknown", "Not", "Partly", "Followed"], axisLabel: { fontSize: 10 }, splitLine: { show: false } }, { gridIndex: 2, type: "category", data: ["Context", "Excluded"], axisLabel: { fontSize: 10 }, splitLine: { show: false } }],
    series: [{ name: experimentMetrics[selected][0], type: "line", connectNulls: false, data: days.map(d => d.values[selected] ?? null), lineStyle: { color: "#df9850", width: 2 }, itemStyle: { color: "#df9850" }, symbolSize: 5 },
      { name: "Adherence · During only", type: "scatter", xAxisIndex: 1, yAxisIndex: 1, symbolSize: 9, data: days.map(d => d.period !== "During" || d.day > localDay(new Date(evidence.asOf)) ? null : { value: d.checkIn.adherence === "followed" ? 3 : d.checkIn.adherence === "partly" ? 2 : d.checkIn.adherence === "not_followed" ? 1 : 0, itemStyle: { color: d.checkIn.adherence === "unknown" ? "#a58c82" : "#9eb8b2" } }) },
      { name: "Context logged", type: "scatter", xAxisIndex: 2, yAxisIndex: 2, symbol: "diamond", itemStyle: { color: "#9fad68" }, data: days.map(d => d.checkIn.note || d.checkIn.context || d.context.length ? 0 : null) },
      { name: "Explicit exclusion", type: "scatter", xAxisIndex: 2, yAxisIndex: 2, symbol: "cross", itemStyle: { color: "#c98c97" }, data: days.map(d => d.checkIn.exclusion ? 1 : null) }], aria: { enabled: true } }
  return <>
    <section className="panel"><span className="eyebrow">WHAT CHANGED? · OBSERVATIONAL</span><h2>Before, during, and beyond.</h2><p>Group averages describe these windows, not effects caused by the habit. No outliers or travel days are automatically removed. Today’s measurements may still be incomplete.</p>
      {charts.map((metric, index) => <div key={metric}><p className="eyebrow">{index === 0 ? "PRIMARY OUTCOME" : "SUPPORTING MEASURE"}</p><Comparison days={days} metric={metric} /></div>)}
      <details><summary>Within-experiment adherence comparisons</summary>{charts.map(metric => <div key={metric}><h4>{experimentMetrics[metric][0]}</h4><Comparison days={days} metric={metric} cohorts /></div>)}</details>
    </section>
    <section className="panel"><span className="eyebrow">THE DAILY EVIDENCE</span><h2>A pattern, not a verdict.</h2><label>Timeline measure<select value={selected} onChange={v => setSelected(v.target.value as ExperimentMetric)}>{charts.map(k => <option key={k} value={k}>{experimentMetrics[k][0]}</option>)}</select></label>
      <Chart option={option} height={440} />
      <p className="caption">Exposure dates on the shared axis; outcomes from {e.alignment ? "the following day" : "the same day"}. Lines do not bridge missing values. All measured days—including exclusions—remain in this chart and ledger. Adherence is categorical, not a score.</p>
      <label className="cursor-control">Inspect a day<input type="range" min={0} max={Math.max(0, days.length - 1)} value={inspect} onChange={v => setInspect(Number(v.target.value))} /></label>
      {active && <div className="moment"><strong>{active.day} · {active.period}</strong><span>{active.period === "During" ? adherenceLabels[active.checkIn.adherence] : "No adherence cohort"}</span><span>Outcome {active.outcomeDay}: {format(active.values[selected])} {experimentMetrics[selected][1]}</span><span>{active.checkIn.exclusion ? `Excluded: ${active.checkIn.exclusion}` : "Included if measured"}</span><span>{active.checkIn.note || "No manual note"}</span><span>{active.context.length ? active.context.join(" · ") : "No context logged; absence unknown"}</span></div>}
      {active?.checkIn.provenance && <details className="context-source"><summary>Accepted context & classification provenance · {active.day}</summary>
        {active.checkIn.provenance.context && <><p>Debrief revision {active.checkIn.context?.version} · {(Object.keys(contextTopics) as ContextTopic[]).map(k => `${contextTopics[k][0]}: ${active.checkIn.provenance!.context!.labels[k]}`).join(" · ")}</p><p className="caption">{active.checkIn.provenance.context.source.model} · {active.checkIn.provenance.context.source.rubricVersion} · source {active.checkIn.provenance.context.source.sourceHash}</p></>}
        {active.checkIn.provenance.adherence && <><p>Jev proposed {adherenceLabels[active.checkIn.provenance.adherence.proposed]}; you saved {adherenceLabels[active.checkIn.adherence]}. Classified against plan v{active.checkIn.provenance.adherence.planVersion}.</p><p className="caption">{active.checkIn.provenance.adherence.source.model} · {active.checkIn.provenance.adherence.source.rubricVersion} · source {active.checkIn.provenance.adherence.source.sourceHash}</p></>}
        <p className="caption">These labels and receipts belong to this notebook revision and remain frozen in snapshots. Later Debrief corrections do not rewrite them.</p></details>}
      <details><summary>Full daily ledger · values, context & exclusions</summary><div className="table-wrap"><table><thead><tr><th>Exposure → outcome</th><th>Period / adherence</th><th>{experimentMetrics[selected][0]}</th><th>Notes & context</th><th>Exclusion</th></tr></thead><tbody>{days.map(d => <tr key={d.day}><td>{d.day}<br />→ {d.outcomeDay}</td><td>{d.period}<br />{d.period === "During" ? adherenceLabels[d.checkIn.adherence] : "—"}</td><td>{d.pending ? "Pending" : format(d.values[selected])} {experimentMetrics[selected][1]}</td><td>{[d.checkIn.note, ...d.context].filter(Boolean).join(" · ") || "Not logged"}</td><td>{d.checkIn.exclusion || "None"}</td></tr>)}</tbody></table></div></details>
    </section>
    <details className="panel"><summary>Other signals · exploratory, not a redefinition of success</summary><p>All supported daily measures are available here, in a fixed order—not ranked by apparent improvement. A surprising change can become the question for your next experiment.</p>{metrics.filter(k => !charts.includes(k)).map(k => <Comparison key={k} days={days} metric={k} />)}</details>
    <p className="caption">Evidence read {dateTime(evidence.asOf)} Eastern · latest source update in this read: {evidence.sourceUpdatedAt ? dateTime(evidence.sourceUpdatedAt) : "not recorded"}. Saved snapshots freeze these values and the plan. Live reads are not transactionally isolated from concurrent Oura imports.</p>
  </>
}

function CheckInForm({ revision, day, onDay, save, busy }: { revision: ExperimentRevision; day: string; onDay: (day: string) => void; save: (e: Experiment) => Promise<void>; busy: boolean }) {
  const e = revision.experiment, [c, set] = useState<CheckIn>(e.checkIns[day] ?? blankCheck)
  const [proposal, setProposal] = useState<ContextProposal | null>(null), [context, setContext] = useState<ContextRevision | null>(null)
  const [aiBusy, setAiBusy] = useState(false), [aiError, setAiError] = useState(""), [consent, setConsent] = useState(false), [contextChecked, setContextChecked] = useState(false)
  const ask = async (work: () => Promise<void>) => { setAiBusy(true); setAiError(""); try { await work() } catch (error) { setAiError((error as Error).message) } finally { setAiBusy(false) } }
  const during = day >= e.start && day <= e.end
  return <form className="panel lab-form" onSubmit={event => { event.preventDefault(); void save({ ...e, checkIns: { ...e.checkIns, [day]: c }, revisionNote: `Check-in ${day}` }) }}>
    <span className="eyebrow">DAILY CHECK-IN</span><h2>What actually happened?</h2><label>Exposure date<input type="date" required min={e.beforeStart} max={[localDay(new Date()), e.afterEnd || e.end].sort()[0]} value={day} onChange={v => { if (v.target.value) onDay(v.target.value) }} /></label>
    {during ? <fieldset><legend>Adherence</legend><div className="lab-adherence">{adherenceStates.map(a => <label key={a}><input type="radio" name="adherence" checked={c.adherence === a} onChange={() => set({ ...c, adherence: a })} />{adherenceLabels[a]}</label>)}</div><p className="caption">{c.adherence === "unknown" ? "No assumption is made from an unanswered check-in or an Oura tag." : e.rules[c.adherence]}</p></fieldset> : <p className="caption">Before/After: record context or an exclusion, not exposure adherence.</p>}
    <label>Anything different? (optional)<textarea disabled={aiBusy} maxLength={2000} value={c.note} onChange={v => { set({ ...c, note: v.target.value, classificationId: undefined }); setProposal(null) }} placeholder="What did you do? Include relevant timing; leave measured outcomes out." /></label>
    <section className="lab-concierge"><span className="eyebrow">OPTIONAL · EXPERIMENT CONCIERGE</span><h3>A second reading, not a decision.</h3>
      <p>Import accepted context from your Debrief, or ask Jev to read this note against your declared adherence rules. Your outcomes and comparison results are never fetched for classification.</p>
      <button type="button" disabled={aiBusy || busy} onClick={() => void ask(async () => { setContext(await contextRequest<ContextRevision | null>(`/api/context/${day}`)); setContextChecked(true) })}>Find saved context for this day</button>
      {contextChecked && !context && <p>No accepted Debrief for this day yet. You can still log manually.</p>}
      {context && <div><p>Debrief v{context.version}: {(Object.keys(contextTopics) as ContextTopic[]).filter(k => context.labels[k] !== "unknown").map(k => `${contextTopics[k][0]}: ${context.labels[k]}`).join(" · ") || "All topics unknown"}</p><button type="button" disabled={aiBusy || busy} onClick={() => set({ ...c, context: { day, version: context.version } })}>Attach this accepted context</button><p className="caption">Attaches labels and provenance only. It does not change your note, adherence, or exclusions.</p></div>}
      {c.context && <p className="caption">Attached: {c.context.day} · v{c.context.version} <button type="button" onClick={() => set({ ...c, context: undefined })}>Detach</button></p>}
      {during && <><div className="debrief-permissions"><label><input type="checkbox" checked={consent} disabled={aiBusy} onChange={v => setConsent(v.target.checked)} />Send this note and the habit/adherence rules to Jev through Cloudflare; privately store its proposal and source.</label></div><button type="button" disabled={aiBusy || busy || !consent || !c.note.trim()} onClick={() => void ask(async () => { setProposal(await contextRequest<ContextProposal>("/api/jev/classify", { note: c.note, consent, experiment: { id: revision.id, version: revision.version } })) })}>{aiBusy ? "Reading your note…" : "Suggest adherence"}</button></>}
      {aiError && <p role="alert" className="alert">{aiError}</p>}
      {proposal?.adherence && <div className="context-notice"><p><b>Proposed: {adherenceLabels[proposal.adherence.choice]}</b> · {Math.round(proposal.adherence.confidence * 100)}% classifier confidence</p>
        {proposal.adherence.choice === "unknown" && <p>One clarification: what happened relative to “{e.rules.followed}”? Include any relevant timing or amount. Edit the note above and ask again, or leave adherence Unknown.</p>}
        <p>Context to review: {(Object.keys(contextTopics) as ContextTopic[]).filter(k => ["present", "conflicting"].includes(proposal.answers[k].choice)).map(k => `${contextTopics[k][0]} (${proposal.answers[k].choice})`).join(" · ") || "No explicit complications identified; unmentioned context remains unknown."}</p>
        <button type="button" disabled={aiBusy || busy} onClick={() => set({ ...c, adherence: proposal.adherence!.choice, classificationId: proposal.id })}>Use suggestion in this draft</button><ProposalSource proposal={proposal} /></div>}
      {c.classificationId && <p className="caption">Jev suggestion accepted into the draft. You can still change adherence above. Save check-in to record your decision and its provenance.</p>}
    </section>
    <label>Exclude this day from averages? Give a reason, or leave blank.<input maxLength={500} value={c.exclusion} onChange={v => set({ ...c, exclusion: v.target.value })} /></label><p className="caption">Exclusions stay visible in the timeline and snapshots. Clearing the reason includes the day again. No automatic removal.</p>
    <button className="lab-primary" disabled={busy || aiBusy || e.state === "draft"}>Save check-in</button>{e.state === "draft" && <p className="caption">Activate the plan before logging. Paused/finished notebooks still allow corrections.</p>}
  </form>
}

export function Experiments() {
  const [list, setList] = useState<ExperimentRevision[]>([]), [current, setCurrent] = useState<ExperimentRevision | null>(null)
  const [evidence, setEvidence] = useState<ExperimentEvidence | null>(null), [snapshots, setSnapshots] = useState<ExperimentSnapshot[]>([]), [revisions, setRevisions] = useState<ExperimentRevision[]>([])
  const [editing, setEditing] = useState<Experiment | null>(null), [snapshot, setSnapshot] = useState<ExperimentSnapshot | null>(null)
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState(""), [day, setDay] = useState(localDay(new Date()))
  const run = async (fn: () => Promise<void>) => { setBusy(true); setError(""); setNotice(""); try { await fn() } catch (e) { setError((e as Error).message) } finally { setBusy(false) } }
  const loadList = async () => setList(await api<ExperimentRevision[]>())
  useEffect(() => { void run(loadList) }, [])
  const open = async (id: string) => {
    const [data, saved, history] = await Promise.all([api<{ revision: ExperimentRevision; evidence: ExperimentEvidence }>(`/${id}/evidence`), api<ExperimentSnapshot[]>(`/${id}/snapshots`), api<ExperimentRevision[]>(`/${id}/revisions`)])
    setCurrent(data.revision); setEvidence(data.evidence); setSnapshots(saved); setRevisions(history); setSnapshot(null); setEditing(null)
    const e = data.revision.experiment, today = localDay(new Date())
    setDay(today < e.start ? e.beforeEnd < today ? e.beforeEnd : today : today > e.end ? e.end : today)
  }
  const save = async (experiment: Experiment) => run(async () => {
    const r = await api<ExperimentRevision>(current ? `/${current.id}` : "", { experiment, version: current?.version }, current ? "PUT" : "POST")
    setCurrent(r); setEditing(null); setEvidence(null); await open(r.id); await loadList(); setNotice(`Saved revision ${r.version}.`)
  })
  const shown = snapshot?.revision ?? current, shownEvidence = snapshot?.evidence ?? evidence
  return <div className="experiment-lab" aria-busy={busy}>
    <header className="page-title"><span className="eyebrow">PERSONAL EXPERIMENT LAB · MANUAL FIRST</span><h1>A little curiosity.<br />A clearer record.</h1><p>Test one change. Keep the context. Let the evidence stay honest.</p></header>
    {error && <div className="alert" role="alert">{error} <button disabled={busy} onClick={() => void run(async () => { if (current) await open(current.id); else await loadList() })}>Reload saved notebook</button><p>Reload discards unsaved form edits. Copy them first if needed.</p></div>}{notice && <p role="status">{notice}</p>}
    {busy && <p role="status">Saving or loading your notebook…</p>}
    <div className="lab-actions"><button disabled={busy} onClick={() => { setCurrent(null); setEditing(null); setEvidence(null); setSnapshot(null) }}>All experiments</button><button className="lab-primary" disabled={busy} onClick={() => { setCurrent(null); setEditing(newExperiment()); setSnapshot(null) }}>New experiment</button></div>
    {editing ? <PlanForm key={`${current?.id ?? "new"}-${current?.version ?? 0}`} initial={editing} save={save} cancel={() => setEditing(null)} busy={busy} /> : !current ? <>
      {!list.length && !busy && !error && <section className="panel"><h2>Start with a question, not a conclusion.</h2><p>Choose one outcome and a concrete habit. You’ll define your comparison before logging, then save before/during/after snapshots when you’re ready to reflect.</p><p className="caption">Private, server-saved notebook. AI assistance is opt-in per check-in. No automatic causal or significance claims.</p></section>}
      <div className="dashboard-grid">{[...list].sort((a, b) => Number(b.experiment.state === "active") - Number(a.experiment.state === "active")).map(r => {
        const e = r.experiment, today = localDay(new Date()), logged = Object.entries(e.checkIns).filter(([d, c]) => d >= e.start && d <= e.end && c.adherence !== "unknown").length
        return <article className="panel lab-card" key={r.id}><span className="eyebrow">{e.state} · REVISION {r.version}</span><h2>{e.question}</h2><p>{e.start} → {e.end}<br />{experimentMetrics[e.primary][0]} · {logged} known-adherence check-ins</p><p className="caption">{e.state === "active" && today >= e.start && today <= e.end ? e.checkIns[today] ? "Today’s entry saved; you can revise it." : "Today’s check-in is waiting." : "Open to plan, log or reflect."}</p><button disabled={busy} onClick={() => void run(() => open(r.id))}>Open notebook ↗</button></article>
      })}</div>
    </> : <>
      <section className="lab-heading"><span className="eyebrow">{shown?.experiment.state} · {snapshot ? `SAVED SNAPSHOT · ${dateTime(snapshot.savedAt)}` : `LIVE NOTEBOOK · REVISION ${current.version}`}</span><h2>{shown?.experiment.question}</h2><p>{shown?.experiment.habit}</p><p className="caption">{shown?.experiment.beforeStart} → {shown?.experiment.afterEnd || shown?.experiment.end} · Uses its own date windows, independent of dashboard controls.</p></section>
      {shown && <details className="panel"><summary>Comparison plan · revision {shown.version}{snapshot ? " preserved in this snapshot" : ""}</summary><p>Primary: {experimentMetrics[shown.experiment.primary][0]}. Exposure pairs with {shown.experiment.alignment ? "the next calendar day’s" : "the same day’s"} outcome.</p>{(["followed", "partly", "not_followed"] as const).map(a => <p key={a}><b>{adherenceLabels[a]}:</b> {shown.experiment.rules[a]}</p>)}<p className="caption">Before: {shown.experiment.beforeStart} → {shown.experiment.beforeEnd}. During: {shown.experiment.start} → {shown.experiment.end}. After: {shown.experiment.afterStart || "not planned"} {shown.experiment.afterEnd && `→ ${shown.experiment.afterEnd}`}.</p></details>}
      <div className="lab-actions"><button disabled={busy || !!snapshot} onClick={() => setEditing({ ...current.experiment, revisionNote: "" })}>Revise plan / reflect</button><button disabled={busy || !evidence || !!snapshot} onClick={() => void run(async () => { const saved = await api<ExperimentSnapshot>(`/${current.id}/snapshots`, { version: current.version }); setSnapshots([saved, ...snapshots]); setSnapshot(saved); setNotice("Snapshot saved. Later imports and edits will not rewrite it.") })}>Save evidence snapshot</button>{snapshot && <button onClick={() => setSnapshot(null)}>Return to live notebook</button>}</div>
      {shown?.experiment.conclusion && <section className="panel"><h2>Your reflection</h2><p>{shown.experiment.conclusion}</p></section>}
      {!snapshot && <CheckInForm key={`${current.version}-${day}`} revision={current} day={day} onDay={setDay} save={save} busy={busy} />}
      {shown && shownEvidence && <Evidence key={`${shown.id}-${shown.version}-${snapshot?.id ?? "live"}`} revision={shown} evidence={shownEvidence} />}
      <section className="panel"><h2>Saved snapshots</h2><p className="caption">Each snapshot preserves all supported daily values, context, check-ins, exclusions, and the plan version. Refresh live evidence by reopening the notebook; save a new snapshot to record a later read.</p>{!snapshots.length && <p>No snapshots yet.</p>}<div className="lab-actions">{snapshots.map(s => <button disabled={busy} key={s.id} aria-pressed={s.id === snapshot?.id} onClick={() => setSnapshot(s)}>{dateTime(s.savedAt)} · v{s.revision.version}</button>)}</div></section>
      <details className="panel"><summary>Revision history · {revisions.length} saved versions</summary>{revisions.map(r => <details key={r.version}><summary>v{r.version} · {dateTime(r.savedAt)} · {r.experiment.revisionNote}</summary><pre>{JSON.stringify(r.experiment, null, 2)}</pre></details>)}</details>
    </>}
  </div>
}
