import { afterEach, describe, expect, it, vi } from "vitest"
import { DatabaseSync } from "node:sqlite"
import { readFileSync } from "node:fs"
import worker from "../src/index.js"
import { contextTopics, proposedLabels, selectFollowUps, type ContextProposal, type ContextRevision } from "@oura/shared/context"
import type { Experiment, ExperimentRevision, ExperimentSnapshot } from "@oura/shared/experiments"
import type { AppEnv } from "../src/types.js"

const databases: DatabaseSync[] = []
afterEach(() => { for (const db of databases.splice(0)) db.close() })
const plan: Experiment = { question: "PRIVATE OUTCOME QUESTION", habit: "Finish work before dinner", primary: "averageHrv", supporting: [], rules: { followed: "No work after dinner", partly: "Up to 15 minutes after dinner", not_followed: "More than 15 minutes after dinner" }, beforeStart: "2026-03-06", beforeEnd: "2026-03-07", start: "2026-03-08", end: "2026-03-10", afterStart: "", afterEnd: "", alignment: 1, state: "active", checkIns: {}, conclusion: "PRIVATE RESULT", revisionNote: "Initial" }
function setup() {
  const db = new DatabaseSync(":memory:"); databases.push(db)
  for (const file of ["0001_initial.sql", "0003_experiments.sql", "0004_context.sql"]) db.exec(readFileSync(new URL(`../../../migrations/${file}`, import.meta.url), "utf8"))
  const run = vi.fn(async (_model: string, input: { state: unknown; questions: Record<string, unknown> }) => ({ state: "Completed", result: {
    model: "jev-1.13.0", usage: { input_tokens: 1000, output_tokens: 200 }, answers: Object.fromEntries(Object.keys(input.questions).map(k => [k, { type: "choice", choice: k === "adherence" ? "not_followed" : k === "evening_work" ? "present" : "unknown", confidence: 0.9,
      probabilities: k === "adherence" ? { followed: 0, partly: 0, not_followed: 0.9, unknown: 0.1 } : k === "evening_work" ? { present: 0.9, absent: 0, unknown: 0.1, conflicting: 0 } : { present: 0, absent: 0, unknown: 1, conflicting: 0 } }]))
  } }))
  const env = { DEPLOYMENT_MODE: "local", JEV_ENABLED: "true", AI: { run }, JEV_RATE_LIMITER: { limit: async () => ({ success: true }) }, DB: { prepare(sql: string) {
    const statement = db.prepare(sql); let bindings: (string | number | null)[] = []
    return { bind(...v: typeof bindings) { bindings = v; return this }, async all() { return { results: statement.all(...bindings) } }, async first() { return statement.get(...bindings) ?? null }, async run() { return { meta: { changes: Number(statement.run(...bindings).changes) } } } }
  } } } as unknown as AppEnv
  const request = (path: string, body?: unknown, method = "POST", origin = "https://oura.test") => worker.fetch(new Request(`https://oura.test${path}`, body === undefined ? {} : { method, headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body) }), env, {} as ExecutionContext)
  return { db, env, run, request }
}
describe("context and concierge (mock inference, real persistence)", () => {
  it("keeps proposal distinct from accepted edits, preserves history, rejects stale writes and invalid days", async () => {
    const { request } = setup()
    const response = await request("/api/jev/classify", { note: "Worked after dinner", consent: true })
    expect(response.status).toBe(200)
    const p = await response.json() as ContextProposal
    expect(await (await request("/api/context/2026-03-08")).json()).toBeNull()
    const first = { proposalId: p.id, version: 0, labels: { ...proposedLabels(p), evening_work: "absent" }, reason: "Corrected reading" }
    expect((await request("/api/context/2026-03-08", first, "PUT")).status).toBe(200)
    expect((await request("/api/context/2026-03-08", first, "PUT")).status).toBe(409)
    expect((await request("/api/context/2026-03-08", { ...first, version: 1, labels: proposedLabels(p) }, "PUT")).status).toBe(200)
    const history = await (await request("/api/context/2026-03-08/revisions")).json() as ContextRevision[]
    expect(history.map(r => [r.version, r.labels.evening_work])).toEqual([[2, "present"], [1, "absent"]])
    expect(history[1]!.proposal.answers.evening_work.choice).toBe("present")
    await request("/api/context/2026-03-09", first, "PUT")
    const range = await (await request("/api/context?start=2026-03-08&end=2026-03-09")).json() as ContextRevision[]
    expect(range.map(r => [r.day, r.version, r.labels.evening_work])).toEqual([["2026-03-08", 2, "present"], ["2026-03-09", 1, "absent"]])
    expect(await (await request("/api/context?start=2026-03-10&end=2026-03-10")).json()).toEqual([])
    for (const query of ["start=2026-03-09&end=2026-03-08", "start=2025-01-01&end=2026-03-08", "start=2026-02-30&end=2026-03-08", ""]) {
      expect((await request(`/api/context?${query}`)).status).toBe(400)
    }
    expect((await request("/api/context/2026-02-30", first, "PUT")).status).toBe(400)
    expect((await request("/api/context/2999-01-01", first, "PUT")).status).toBe(400)
    expect((await request("/api/context/2026-03-08", { ...first, labels: { ...first.labels, zepbound: "diagnosis" } }, "PUT")).status).toBe(400)
    expect((await request("/api/context/2026-03-08", first, "PUT", "https://evil.test")).status).toBe(403)
  })
  it("sends curated answers only and bounds follow-ups including medication opt-in", async () => {
    const { request, run, db } = setup()
    const p = await (await request("/api/jev/classify", { note: "Worked after dinner", consent: true, responses: { travel: "", work_demands: "No unusual demands" } })).json() as ContextProposal
    const stored = db.prepare("SELECT document_json FROM context_proposals WHERE id = ?").get(p.id) as { document_json: string }
    expect(JSON.parse(stored.document_json)).not.toHaveProperty("debug")
    expect(p.followUps).toEqual([])
    expect(run.mock.calls[0]![1].state).toEqual({ note: "Worked after dinner", interview: [{ question: contextTopics.travel[2], answer: "" }, { question: contextTopics.work_demands[2], answer: "No unusual demands" }] })
    p.answers.zepbound.choice = "conflicting"; p.answers.caffeine.choice = "conflicting"
    expect(selectFollowUps(p.answers, [], true)).toEqual(["caffeine", "zepbound"])
    expect(selectFollowUps(p.answers, [], false)).toEqual(["caffeine", "work_demands"])
    expect(selectFollowUps(p.answers, ["caffeine"], true)).toEqual(["zepbound"])
    expect((await request("/api/jev/classify", { note: "note", consent: true, responses: { unknown_question: "yes" } })).status).toBe(400)
    expect((await request("/api/jev/classify", { note: "note", consent: true, responses: { travel: "", caffeine: "", exercise: "" } })).status).toBe(400)
  })
  it("keeps outcomes out of concierge input; accepts a human override and freezes provenance in snapshots", async () => {
    const { request, run } = setup()
    const revision = await (await request("/api/experiments", { experiment: plan })).json() as ExperimentRevision
    const input = { note: "Worked two hours after dinner", consent: true, experiment: { id: revision.id, version: 1 } }
    const response = await request("/api/jev/classify", input); expect(response.status).toBe(200)
    const p = await response.json() as ContextProposal
    const sent = JSON.stringify(run.mock.calls[0]![1])
    expect(sent).toContain(plan.habit); expect(sent).toContain(plan.rules.followed)
    expect(sent).not.toContain(plan.question); expect(sent).not.toContain(plan.conclusion); expect(sent).not.toContain("averageHrv")
    expect((await (await request(`/api/experiments/${revision.id}`)).json() as ExperimentRevision).experiment.checkIns).toEqual({})
    await request("/api/context/2026-03-08", { version: 0, proposalId: p.id, labels: proposedLabels(p), reason: "Reviewed" }, "PUT")
    const experiment: Experiment = { ...plan, checkIns: { "2026-03-08": { adherence: "partly", note: input.note, exclusion: "", context: { day: "2026-03-08", version: 1 }, classificationId: p.id } }, revisionNote: "Override suggestion" }
    const savedResponse = await request(`/api/experiments/${revision.id}`, { version: 1, experiment }, "PUT"); expect(savedResponse.status).toBe(200)
    const saved = await savedResponse.json() as ExperimentRevision
    expect(saved.experiment.checkIns["2026-03-08"]).toMatchObject({ adherence: "partly", exclusion: "", provenance: { adherence: { proposed: "not_followed", planVersion: 1, source: { id: p.id } }, context: { labels: { evening_work: "present" } } } })
    const snapshot = await (await request(`/api/experiments/${revision.id}/snapshots`, { version: 2 })).json() as ExperimentSnapshot
    await request("/api/context/2026-03-08", { version: 1, proposalId: p.id, labels: { ...proposedLabels(p), evening_work: "absent" }, reason: "Correction" }, "PUT")
    expect((await (await request(`/api/experiments/${revision.id}/snapshots`)).json() as ExperimentSnapshot[])[0]).toEqual(snapshot)
    experiment.checkIns["2026-03-08"]!.note = "Changed source"
    expect((await request(`/api/experiments/${revision.id}`, { version: 2, experiment }, "PUT")).status).toBe(400)
    expect((await request("/api/jev/classify", input)).status).toBe(409)
  })
  it("keeps retrospective provenance out of Jev input, binds acceptance to its day and reuses saved context without inference", async () => {
    const { request, run } = setup()
    const input = { note: "Worked after dinner", consent: true, reviewDay: "2026-03-08" }
    const p = await (await request("/api/jev/classify", input)).json() as ContextProposal
    expect(p.reviewDay).toBe("2026-03-08")
    expect(run.mock.calls[0]![1].state).toEqual({ note: input.note })
    expect(JSON.stringify(run.mock.calls[0]![1])).not.toContain(input.reviewDay)
    const save = { version: 0, proposalId: p.id, labels: proposedLabels(p), reason: "Retrospective review" }
    expect((await request("/api/context/2026-03-09", save, "PUT")).status).toBe(400)
    expect((await request("/api/context/2026-03-08", save, "PUT")).status).toBe(200)
    expect((await (await request("/api/context/2026-03-08/revisions")).json() as ContextRevision[])[0]!.proposal.reviewDay).toBe(input.reviewDay)
    const notebook = await (await request("/api/experiments", { experiment: plan })).json() as ExperimentRevision
    await request(`/api/experiments/${notebook.id}`, { version: 1, experiment: { ...plan, checkIns: { "2026-03-08": { adherence: "unknown", note: "", exclusion: "", context: { day: input.reviewDay, version: 1 } } } } }, "PUT")
    const snapshot = await (await request(`/api/experiments/${notebook.id}/snapshots`, { version: 2 })).json()
    expect(JSON.stringify(snapshot)).toContain('"reviewDay":"2026-03-08"')
    for (const extra of [{ reviewDay: "2026-02-30" }, { reviewDay: "2999-01-01" }, { elevated: true }, { stressHours: 4 }, { experiment: { id: notebook.id, version: 2 } }]) {
      expect((await request("/api/jev/classify", { ...input, ...extra })).status).toBe(400)
    }
    expect(run).toHaveBeenCalledTimes(1)
  })
  it("requires Access for saved context even when inference is off", async () => {
    const { env, request } = setup()
    env.JEV_ENABLED = "false"
    expect((await request("/api/context/2026-03-08")).status).toBe(200)
    env.DEPLOYMENT_MODE = "production"; env.DASHBOARD_HOSTNAME = "oura.ronsanzone.dev"
    expect((await worker.fetch(new Request("https://oura.ronsanzone.dev/api/context/2026-03-08"), env, {} as ExecutionContext)).status).toBe(403)
  })
})
