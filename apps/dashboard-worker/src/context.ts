import { validContextDay, validateContextSave, type ContextProposal, type ContextRevision } from "@oura/shared/context"
import { HttpError, json, readBoundedText } from "./http.js"
import { requireSameOrigin } from "./security.js"
import type { AppEnv } from "./types.js"

type Row = { day: string; version: number; document_json: string; labels_json: string; reason: string; saved_at: string }
const revision = (r: Row): ContextRevision => ({ day: r.day, version: r.version, proposal: JSON.parse(r.document_json), labels: JSON.parse(r.labels_json), reason: r.reason, savedAt: r.saved_at })
export async function contextProposal(env: AppEnv, id: string): Promise<ContextProposal> {
  const row = await env.DB.prepare("SELECT document_json FROM context_proposals WHERE id = ?").bind(id).first<{ document_json: string }>()
  if (!row) throw new HttpError(404, "not_found", "Classification not found. Classify the note again.")
  return JSON.parse(row.document_json)
}
export async function contextApi(request: Request, env: AppEnv, url: URL): Promise<Response> {
  if (url.pathname === "/api/context" && request.method === "GET") {
    const start = url.searchParams.get("start") ?? "", end = url.searchParams.get("end") ?? ""
    if (!validContextDay(start) || !validContextDay(end) || start > end || (Date.parse(end) - Date.parse(start)) / 86400000 > 365) throw new HttpError(400, "invalid_range", "Choose up to 366 elapsed calendar days")
    const rows = await env.DB.prepare("SELECT r.*, p.document_json FROM context_revisions r JOIN context_proposals p ON p.id = r.proposal_id WHERE r.day >= ? AND r.day <= ? AND r.version = (SELECT MAX(version) FROM context_revisions WHERE day = r.day) ORDER BY r.day").bind(start, end).all<Row>()
    return json(rows.results.map(revision))
  }
  const match = /^\/api\/context\/(\d{4}-\d{2}-\d{2})(\/revisions)?$/.exec(url.pathname)
  if (!match || !validContextDay(match[1]!)) throw new HttpError(400, "invalid_day", "Choose a valid elapsed calendar date.")
  const day = match[1]!, history = !!match[2]
  const query = "SELECT r.*, p.document_json FROM context_revisions r JOIN context_proposals p ON p.id = r.proposal_id WHERE r.day = ? ORDER BY r.version DESC"
  if (request.method === "GET") {
    if (history) return json((await env.DB.prepare(query).bind(day).all<Row>()).results.map(revision))
    const row = await env.DB.prepare(`${query} LIMIT 1`).bind(day).first<Row>()
    return json(row ? revision(row) : null)
  }
  if (request.method !== "PUT" || history) throw new HttpError(405, "method_not_allowed", "Use GET or PUT")
  requireSameOrigin(request)
  if (!request.headers.get("content-type")?.startsWith("application/json")) throw new HttpError(415, "unsupported_media_type", "Use JSON")
  const text = await readBoundedText(request, 8192)
  let body
  try { body = validateContextSave(JSON.parse(text)) } catch (error) { throw new HttpError(400, "invalid_context", error instanceof Error ? error.message : "Invalid context") }
  const proposal = await contextProposal(env, body.proposalId)
  if (proposal.reviewDay && proposal.reviewDay !== day) throw new HttpError(400, "invalid_review_day", "This retrospective proposal belongs to a different day")
  const savedAt = new Date().toISOString()
  const result = await env.DB.prepare("INSERT INTO context_revisions (day, version, proposal_id, labels_json, reason, saved_at) SELECT ?, ?, ?, ?, ?, ? WHERE COALESCE((SELECT MAX(version) FROM context_revisions WHERE day = ?), 0) = ?")
    .bind(day, body.version + 1, proposal.id, JSON.stringify(body.labels), body.reason, savedAt, day, body.version).run()
  if (result.meta.changes !== 1) throw new HttpError(409, "conflict", "This day changed in another tab. Copy your edits before reloading.")
  return json({ day, version: body.version + 1, savedAt, proposal, labels: body.labels, reason: body.reason } satisfies ContextRevision)
}
