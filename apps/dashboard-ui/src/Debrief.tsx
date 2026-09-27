import { useEffect, useState } from "react"
import { traceJev } from "./JevDebug"
import { loadSelectedDay } from "./data"
import { effectiveDay, localDay, type OuraRecord } from "@oura/shared"
import { contextLabels, contextTopics, proposedLabels, selectFollowUps, type ContextLabel, type ContextLabels, type ContextProposal, type ContextRevision, type ContextTopic } from "@oura/shared/context"

export async function contextRequest<T>(path: string, body?: unknown, method = "POST"): Promise<T> {
  const finish = path === "/api/jev/classify" ? traceJev(body) : undefined
  let response: Response, data: any
  try {
    response = await fetch(path, body === undefined ? {} : { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
    data = await response.json()
  } catch (error) {
    finish?.(null, undefined, "Request failed or its response could not be read. No automatic retry was made.")
    throw error
  }
  finish?.(response.status, data)
  if (!response.ok) throw new Error(data.message ?? "Unable to complete the request")
  return data as T
}
export function ProposalSource({ proposal }: { proposal: ContextProposal }) {
  return <details className="context-source"><summary>Source & classifier receipt · {proposal.model}</summary>
    {proposal.reviewDay && <p className="context-notice">Retrospective Explore classification · {proposal.reviewDay}. Reviewed after looking at outcomes; not prospective evidence.</p>}
    <p>{proposal.rubricVersion} · {new Date(proposal.createdAt).toLocaleString()} · {proposal.usage.input_tokens.toLocaleString()} input tokens · estimated ${proposal.estimatedInputCostUsd.toFixed(6)}</p>
    <p className="caption">Classifier confidence describes its reading of the text. It is not statistical confidence, a diagnosis, or evidence of causation.</p>
    <p className="source-note">{proposal.input.note}</p>{Object.entries(proposal.input.responses).map(([key, answer]) => <p key={key}><b>{contextTopics[key as ContextTopic][2]}</b><br />{answer || "Skipped"}</p>)}
    <p className="caption">Receipt {proposal.id}<br />Source hash (SHA-256/base64): {proposal.sourceHash}</p>
  </details>
}

export function DayDebrief({ day, onDirty, retrospective = false, onSaved }: { day: string; onDirty: (dirty: boolean) => void; retrospective?: boolean; onSaved?: (revision: ContextRevision) => void }) {
  const [saved, setSaved] = useState<ContextRevision | null>(null), [history, setHistory] = useState<ContextRevision[]>([])
  const [records, setRecords] = useState<OuraRecord[]>([]), [recordsLoading, setRecordsLoading] = useState(true), [recordsError, setRecordsError] = useState("")
  const [note, setNote] = useState(""), [responses, setResponses] = useState<ContextProposal["input"]["responses"]>({})
  const [proposal, setProposal] = useState<ContextProposal | null>(null), [labels, setLabels] = useState<ContextLabels | null>(null)
  const [consent, setConsent] = useState(false), [medications, setMedications] = useState(false), [followUps, setFollowUps] = useState<ContextTopic[]>([])
  const [busy, setBusy] = useState(true), [loaded, setLoaded] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState(""), [reason, setReason] = useState("")
  const dirty = proposal?.id !== saved?.proposal.id || note !== (saved?.proposal.input.note ?? "") || JSON.stringify(responses) !== JSON.stringify(saved?.proposal.input.responses ?? {}) || JSON.stringify(labels) !== JSON.stringify(saved?.labels ?? null)
  useEffect(() => { onDirty(dirty || busy); return () => onDirty(false) }, [dirty, busy, onDirty])
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => { if (dirty) { e.preventDefault(); e.returnValue = "" } }
    window.addEventListener("beforeunload", warn); return () => window.removeEventListener("beforeunload", warn)
  }, [dirty])
  const load = async () => {
    const revisions = await contextRequest<ContextRevision[]>(`/api/context/${day}/revisions`)
    const current = revisions[0] ?? null
    setSaved(current); setHistory(revisions); setProposal(current?.proposal ?? null); setLabels(current?.labels ?? null)
    setNote(current?.proposal.input.note ?? ""); setResponses(current?.proposal.input.responses ?? {}); setFollowUps([]); setReason(""); setLoaded(true)
  }
  const run = async (work: () => Promise<void>) => { setBusy(true); setError(""); setNotice(""); try { await work() } catch (e) { setError((e as Error).message) } finally { setBusy(false) } }
  useEffect(() => { void run(load) }, [])
  useEffect(() => {
    const controller = new AbortController()
    setRecordsLoading(true); setRecordsError(""); setRecords([])
    void loadSelectedDay(fetch, day, controller.signal).then(result => { if (!controller.signal.aborted) setRecords(result.records) })
      .catch(e => { if (!controller.signal.aborted) setRecordsError(e instanceof Error ? e.message : "Oura tags are unavailable.") })
      .finally(() => { if (!controller.signal.aborted) setRecordsLoading(false) })
    return () => controller.abort()
  }, [day])
  const classify = async () => run(async () => {
    if (retrospective && proposal && note === proposal.input.note && JSON.stringify(responses) === JSON.stringify(proposal.input.responses)) {
      setFollowUps(selectFollowUps(proposal.answers, Object.keys(responses), medications))
      setNotice("Reusing the existing interpretation. No Jev call was made. Edit the source or answer a follow-up to request a new reading.")
      return
    }
    const next = await contextRequest<ContextProposal>("/api/jev/classify", { note, responses, medications, consent, ...(retrospective ? { reviewDay: day } : {}) })
    setProposal(next); setLabels(proposedLabels(next)); setFollowUps(Object.keys(responses).length ? [] : next.followUps)
    setReason(retrospective ? "Retrospective Explore context review" : saved ? "Updated note and classification" : "Reviewed daily context")
    setNotice("Jev’s proposal is ready. Review it before saving; nothing has been accepted yet.")
  })
  const stale = !!proposal && (note !== proposal.input.note || JSON.stringify(responses) !== JSON.stringify(proposal.input.responses))
  const tags = records.filter(r => r.data_type === "tag" && effectiveDay(r) === day && typeof r.payload.comment === "string" && r.payload.comment.trim())
  return <div aria-busy={busy}>
    {retrospective && <p className="context-notice">Retrospective review · {day}. Existing accepted context loads without inference. Review one day at a time, including ordinary days—not only unusual outcomes. Remove measured results from the text before sending. New classifications are marked retrospective.</p>}
    {error && <div className="alert" role="alert">{error}<p>Your draft is still here. Copy it before reloading.</p><button disabled={busy} onClick={() => { if (!dirty || confirm("Discard unsaved edits and reload this day?")) void run(load) }}>Reload saved day</button></div>}
    {notice && <p className="context-notice" role="status">{notice}</p>}
    {busy && <p role="status">{loaded ? "Working on your context…" : "Opening your daily notebook…"}</p>}
    <div className="debrief-layout">
      <section className="panel lab-form debrief-capture">
        <span className="eyebrow">01 / REMEMBER</span><h2>What shaped your day?</h2>
        <p>A few sentences is enough. What happened, what changed, what did you do? Leave scores and measured outcomes out of this note.</p>
        <label>Your day, in your words<textarea disabled={busy || !loaded} maxLength={4000} value={note} onChange={e => setNote(e.target.value)} placeholder="Start with the things you want to remember…" /></label>
        <span className="caption">{note.length}/4,000 characters · Nothing is sent while you type.</span>
        {recordsLoading && <p className="caption" role="status">Loading Oura tags for this day…</p>}
        {recordsError && <p className="caption warning">Oura tags unavailable. This does not mean none were logged.</p>}
        {!!tags.length && <details><summary>Use an Oura tag comment · {tags.length}</summary>{tags.map(t => <button key={t.record_id} disabled={busy} onClick={() => setNote(String(t.payload.comment).slice(0, 4000))}>Copy comment: {String(t.payload.comment)}</button>)}<p className="caption">Copies into your draft only. Review before sending.</p></details>}
        <div className="debrief-permissions"><label><input type="checkbox" checked={medications} disabled={busy} onChange={e => setMedications(e.target.checked)} />Allow optional medication follow-up questions</label><p className="caption">Adderall and Zepbound use may be classified if you mention them. No doses, schedules, or treatment advice are inferred.</p>
          <label><input type="checkbox" checked={consent} disabled={busy} onChange={e => setConsent(e.target.checked)} />Send this note and answers to Jev through Cloudflare, and store the source and proposal privately for review.</label></div>
        <button className="lab-primary" disabled={busy || !loaded || !consent || !note.trim()} onClick={() => void classify()}>{retrospective && proposal && !stale ? "Review existing interpretation" : proposal ? "Reclassify this draft" : "Interview me →"}</button>
        <p className="caption">One opening note. Up to two optional follow-ups. Each classification is a real, paid call; no automatic retries. Reclassifying replaces unsaved label edits.</p>
      </section>
      <aside className="debrief-aside"><span className="eyebrow">A RECORD, NOT A VERDICT</span><h2>Keep the context.<br />Leave room for unknown.</h2><dl><dt>Present</dt><dd>You explicitly reported it.</dd><dt>Absent</dt><dd>You explicitly said it did not happen.</dd><dt>Unknown</dt><dd>Not mentioned, ambiguous, or skipped.</dd><dt>Conflicting</dt><dd>Reports disagree for the same period.</dd></dl><p className="caption">A “no” about the morning does not describe the whole day. Labels apply only to the period in your note.</p><span className="context-status">{saved ? `SAVED · REVISION ${saved.version}` : "NO ACCEPTED ENTRY YET"}</span></aside>
    </div>
    {!!followUps.length && <section className="panel lab-form"><span className="eyebrow">02 / A LITTLE CLARITY</span><h2>Only if you remember.</h2><p>These curated questions are selected from uncertain or conflicting context—not your Oura results. Every answer is optional.</p>{followUps.map(k => <label key={k}>{contextTopics[k][2]}<input maxLength={500} disabled={busy} value={responses[k] ?? ""} placeholder="Answer, or leave blank to skip" onChange={e => setResponses({ ...responses, [k]: e.target.value })} /></label>)}
      <div className="lab-actions"><button className="lab-primary" disabled={busy || !consent} onClick={() => { const answered = Object.fromEntries(followUps.map(k => [k, responses[k] ?? ""])); setResponses(answered); void run(async () => { const next = await contextRequest<ContextProposal>("/api/jev/classify", { note, responses: answered, medications, consent, ...(retrospective ? { reviewDay: day } : {}) }); setProposal(next); setLabels(proposedLabels(next)); setFollowUps([]); if (retrospective) setReason("Retrospective Explore context review") }) }}>Classify with my answers</button><button disabled={busy} onClick={() => { setResponses(proposal!.input.responses); setFollowUps([]) }}>Skip follow-ups</button></div>
    </section>}
    {proposal && labels && <section className="panel context-review"><span className="eyebrow">03 / YOUR FINAL SAY</span><h2>Does this sound right?</h2><p>Edit any interpretation. Saving accepts your labels, not a claim that they affected your health.</p>
      {stale && <p className="alert" role="status">The source has changed. Reclassify before saving these labels.</p>}
      <div className="context-grid">{(Object.keys(contextTopics) as ContextTopic[]).map(k => <div className={`context-item is-${labels[k]}`} key={k}><label>{contextTopics[k][0]}<select aria-label={`${contextTopics[k][0]} classification`} disabled={busy || stale} value={labels[k]} onChange={e => { setLabels({ ...labels, [k]: e.target.value as ContextLabel }); if (!reason) setReason("Corrected context labels") }}>{contextLabels.map(l => <option key={l} value={l}>{l === "absent" ? "Explicitly absent" : l[0]!.toUpperCase() + l.slice(1)}</option>)}</select></label><span className="caption">Jev: {proposal.answers[k].choice} · {Math.round(proposal.answers[k].confidence * 100)}% classifier confidence{labels[k] !== proposal.answers[k].choice ? " · edited by you" : ""}</span></div>)}</div>
      <ProposalSource proposal={proposal} />
      <div className="lab-form"><label>Revision reason<input maxLength={500} value={reason} disabled={busy} placeholder="What did you review or correct?" onChange={e => setReason(e.target.value)} /></label><button className="lab-primary" disabled={busy || stale || !reason.trim() || !loaded} onClick={() => void run(async () => { const next = await contextRequest<ContextRevision>(`/api/context/${day}`, { version: saved?.version ?? 0, proposalId: proposal.id, labels, reason }, "PUT"); setSaved(next); setHistory([next, ...history]); setReason(""); setFollowUps([]); onSaved?.(next); setNotice(`Saved revision ${next.version}. ${retrospective ? "Accepted history updated. Choose your comparison below when ready." : "Available to import into this day’s experiment check-in."}`) })}>Accept & save daily context</button></div>
    </section>}
    {!!history.length && <details className="panel"><summary>Revision history · {history.length} accepted versions</summary>{history.map(r => <details key={r.version}><summary>v{r.version} · {r.reason} · {new Date(r.savedAt).toLocaleString()}</summary><p>{(Object.keys(contextTopics) as ContextTopic[]).map(k => `${contextTopics[k][0]}: ${r.labels[k]}`).join(" · ")}</p><ProposalSource proposal={r.proposal} /></details>)}</details>}
  </div>
}
export function Debrief({ onDirty }: { onDirty: (dirty: boolean) => void }) {
  const [day, setDay] = useState(localDay(new Date()))
  return <div className="daily-debrief"><header className="page-title"><span className="eyebrow">DAILY DEBRIEF · WITH JEV</span><h1>Your day has a story.<br />Keep the useful parts.</h1><p>A small conversation. An editable record. Always your final say.</p></header>
    <label className="debrief-date">Day to remember · Eastern<input type="date" value={day} max={localDay(new Date())} onChange={e => { if (e.target.value && e.target.value <= localDay(new Date()) && confirm("Switch dates? Any unsaved draft will be discarded.")) setDay(e.target.value) }} /></label>
    <DayDebrief key={day} day={day} onDirty={onDirty} />
  </div>
}
