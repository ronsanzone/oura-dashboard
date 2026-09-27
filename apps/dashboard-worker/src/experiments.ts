import { localDay, shiftDay, type OuraRecord } from "@oura/shared"
import { experimentEvidence, validateExperiment, type ExperimentRevision, type ExperimentSnapshot } from "@oura/shared/experiments"
import { HttpError, json, readBoundedText } from "./http.js"
import { requireSameOrigin } from "./security.js"
import { records } from "./storage.js"
import { contextProposal } from "./context.js"
import type { ContextProposal } from "@oura/shared/context"
import type { AppEnv } from "./types.js"

type Row = { experiment_id: string; version: number; document_json: string; saved_at: string }
const revision = (r: Row): ExperimentRevision => ({ id: r.experiment_id, version: r.version, experiment: JSON.parse(r.document_json), savedAt: r.saved_at })
const latest = async (env: AppEnv, id: string) => {
  const row = await env.DB.prepare("SELECT * FROM experiment_revisions WHERE experiment_id = ? ORDER BY version DESC LIMIT 1").bind(id).first<Row>()
  if (!row) throw new HttpError(404, "not_found", "Experiment not found")
  return revision(row)
}
const evidenceFor = async (env: AppEnv, r: ExperimentRevision) => {
  const all: OuraRecord[] = []
  // Daily measures and context only: do not download a year of intraday HR samples.
  for (const type of ["sleep", "daily_sleep", "daily_readiness", "daily_activity", "daily_stress", "daily_spo2", "cardiovascular_age", "vo2_max", "tag", "workout", "session"]) {
    let cursor: string | null = null
    do {
      const page = await records(env, { type, start: r.experiment.beforeStart, end: shiftDay(r.experiment.afterEnd || r.experiment.end, r.experiment.alignment), cursor: cursor ?? undefined })
      all.push(...page.records); cursor = page.nextCursor
    } while (cursor !== null)
  }
  return experimentEvidence(r.experiment, all, new Date().toISOString())
}

export async function experimentsApi(request: Request, env: AppEnv, url: URL): Promise<Response> {
  const match = /^\/api\/experiments(?:\/([a-zA-Z0-9-]{1,80}))?(?:\/(evidence|snapshots|revisions))?$/.exec(url.pathname)
  if (!match) throw new HttpError(404, "not_found", "Experiment route not found")
  const [, id, action] = match
  if (request.method === "GET") {
    if (!id) {
      const rows = await env.DB.prepare("SELECT r.* FROM experiment_revisions r WHERE version = (SELECT MAX(version) FROM experiment_revisions WHERE experiment_id = r.experiment_id) ORDER BY saved_at DESC").all<Row>()
      return json(rows.results.map(revision))
    }
    const current = await latest(env, id)
    if (action === "evidence") return json({ revision: current, evidence: await evidenceFor(env, current) })
    if (action === "revisions") {
      const rows = await env.DB.prepare("SELECT * FROM experiment_revisions WHERE experiment_id = ? ORDER BY version DESC").bind(id).all<Row>()
      return json(rows.results.map(revision))
    }
    if (action === "snapshots") {
      const rows = await env.DB.prepare("SELECT snapshot_json FROM experiment_snapshots WHERE experiment_id = ? ORDER BY saved_at DESC").bind(id).all<{ snapshot_json: string }>()
      return json(rows.results.map(r => JSON.parse(r.snapshot_json)))
    }
    return json(current)
  }
  if (request.method !== "POST" && request.method !== "PUT") throw new HttpError(405, "method_not_allowed", "Method not allowed")
  requireSameOrigin(request)
  if (!request.headers.get("content-type")?.startsWith("application/json")) throw new HttpError(415, "unsupported_media_type", "Use JSON")
  let body: { experiment?: unknown; version?: number }
  try { body = JSON.parse(await readBoundedText(request, 1024 * 1024)) } catch (error) {
    if (error instanceof HttpError) throw error
    throw new HttpError(400, "invalid_json", "Invalid JSON")
  }
  if (!body || typeof body !== "object") throw new HttpError(400, "invalid_body", "Expected an object")
  if (action === "snapshots" && id && request.method === "POST") {
    const current = await latest(env, id)
    if (body.version !== current.version) throw new HttpError(409, "conflict", "Notebook changed. Reload before saving a snapshot.")
    const snapshot: ExperimentSnapshot = { id: crypto.randomUUID(), savedAt: new Date().toISOString(), revision: current, evidence: await evidenceFor(env, current) }
    await env.DB.prepare("INSERT INTO experiment_snapshots VALUES (?, ?, ?, ?)").bind(snapshot.id, id, JSON.stringify(snapshot), snapshot.savedAt).run()
    return json(snapshot, { status: 201 })
  }
  if (action || (id ? request.method !== "PUT" : request.method !== "POST")) throw new HttpError(405, "method_not_allowed", "Method not allowed")
  const version = id ? body.version : 0
  if (!Number.isSafeInteger(version) || version! < 0) throw new HttpError(400, "invalid_version", "A revision number is required")
  if (id) await latest(env, id)
  let experiment
  try { experiment = validateExperiment(body.experiment, localDay(new Date())) } catch (error) { throw new HttpError(400, "invalid_experiment", error instanceof Error ? error.message : "Invalid experiment") }
  const receipt = (p: ContextProposal) => ({ id: p.id, model: p.model, rubricVersion: p.rubricVersion, sourceHash: p.sourceHash, createdAt: p.createdAt, ...(p.reviewDay ? { reviewDay: p.reviewDay } : {}) })
  for (const c of Object.values(experiment.checkIns)) {
    delete c.provenance // Reconstruct from immutable server records, never trust submitted receipts.
    if (c.context) {
      const row = await env.DB.prepare("SELECT labels_json, proposal_id FROM context_revisions WHERE day = ? AND version = ?").bind(c.context.day, c.context.version).first<{ labels_json: string; proposal_id: string }>()
      if (!row) throw new HttpError(400, "invalid_context", "Saved context revision not found")
      c.provenance = { context: { labels: JSON.parse(row.labels_json), source: receipt(await contextProposal(env, row.proposal_id)) } }
    }
    if (c.classificationId) {
      const proposal = await contextProposal(env, c.classificationId)
      if (!id || proposal.experiment?.id !== id || !proposal.adherence || proposal.input.note !== c.note) throw new HttpError(400, "invalid_provenance", "Classification must match this notebook and the unchanged note. Reclassify after editing.")
      c.provenance = { ...c.provenance, adherence: { proposed: proposal.adherence.choice, source: receipt(proposal), planVersion: proposal.experiment.version } }
    }
  }
  const savedAt = new Date().toISOString(), experimentId = id ?? crypto.randomUUID()
  // Single atomic conditional insert: stale tabs cannot overwrite newer check-ins or plans.
  const result = await env.DB.prepare("INSERT INTO experiment_revisions (experiment_id, version, document_json, saved_at) SELECT ?, ?, ?, ? WHERE COALESCE((SELECT MAX(version) FROM experiment_revisions WHERE experiment_id = ?), 0) = ?")
    .bind(experimentId, version! + 1, JSON.stringify(experiment), savedAt, experimentId, version!).run()
  if (result.meta.changes !== 1) throw new HttpError(409, "conflict", "Notebook changed in another tab. Your edits are not saved; reload and reapply them.")
  return json({ id: experimentId, version: version! + 1, experiment, savedAt }, { status: id ? 200 : 201 })
}
