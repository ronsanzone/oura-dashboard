import { errorResponse, HttpError, json } from "./http.js"
import { exchangeAuthorizationCode, syncOura } from "./oura.js"
import { randomState, sha256 } from "./crypto.js"
import { records, status } from "./storage.js"
import type { Env } from "./types.js"
import { reconcileOuraWebhooks, webhookDataTypeToRecordType } from "./webhooks.js"

const datePattern = /^\d{4}-\d{2}-\d{2}$/
const pacificDate = (date: Date): string => new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Los_Angeles",
  year: "numeric",
  month: "2-digit",
  day: "2-digit"
}).format(date)

const timingSafeEqual = (left: string, right: string): boolean => {
  if (left.length !== right.length) return false
  let mismatch = 0
  for (let index = 0; index < left.length; index += 1) mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index)
  return mismatch === 0
}

const webhookSignature = async (secret: string, timestamp: string, body: string): Promise<string> => {
  const encoder = new TextEncoder()
  const secretBytes = encoder.encode(secret)
  const messageBytes = encoder.encode(timestamp + body)
  const key = await crypto.subtle.importKey("raw", secretBytes.buffer as ArrayBuffer, { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, messageBytes.buffer as ArrayBuffer))
  return [...signature].map((byte) => byte.toString(16).padStart(2, "0")).join("").toUpperCase()
}

const webhook = async (request: Request, env: Env, url: URL, ctx: ExecutionContext): Promise<Response> => {
  if (url.pathname === "/_health") return json({ ok: true, service: "oura-webhook", mode: env.DEPLOYMENT_MODE })
  if (url.pathname !== "/oura-webhook") throw new HttpError(404, "not_found", "Webhook route not found")
  if (request.method === "GET") {
    const token = url.searchParams.get("verification_token")
    const challenge = url.searchParams.get("challenge")
    if (!env.OURA_WEBHOOK_VERIFICATION_TOKEN || !token || !timingSafeEqual(token, env.OURA_WEBHOOK_VERIFICATION_TOKEN)) {
      throw new HttpError(401, "invalid_verification_token", "Webhook verification failed")
    }
    if (!challenge) throw new HttpError(400, "missing_challenge", "Webhook challenge is required")
    return json({ challenge })
  }
  if (request.method !== "POST") throw new HttpError(405, "method_not_allowed", "Method not allowed")
  if (!env.OURA_CLIENT_SECRET) throw new HttpError(503, "oura_not_configured", "Oura webhook secret is not configured")
  const signature = request.headers.get("x-oura-signature")
  const timestamp = request.headers.get("x-oura-timestamp")
  if (!signature || !timestamp) throw new HttpError(401, "missing_signature", "Oura signature headers are required")
  const body = await request.text()
  const expected = await webhookSignature(env.OURA_CLIENT_SECRET, timestamp, body)
  if (!timingSafeEqual(signature.toUpperCase(), expected)) throw new HttpError(401, "invalid_signature", "Oura signature is invalid")
  const event = JSON.parse(body) as { event_type?: string; data_type?: string; object_id?: string; user_id?: string }
  const eventId = `${timestamp}:${event.user_id ?? "unknown"}:${event.data_type ?? "unknown"}:${event.object_id ?? "unknown"}:${event.event_type ?? "unknown"}`
  const inserted = await env.DB.prepare(`
    INSERT INTO webhook_events (event_id, received_at, payload_json)
    VALUES (?, ?, ?) ON CONFLICT(event_id) DO NOTHING RETURNING event_id
  `).bind(eventId, new Date().toISOString(), body).first()
  if (inserted) {
    if (event.event_type === "delete" && event.data_type && event.object_id) {
      const recordType = webhookDataTypeToRecordType[event.data_type]
      if (recordType) await env.DB.prepare("DELETE FROM records WHERE data_type = ? AND record_id = ?")
        .bind(recordType, event.object_id).run()
      await env.DB.prepare("UPDATE webhook_events SET processed_at = ? WHERE event_id = ?")
        .bind(new Date().toISOString(), eventId).run()
      return new Response("OK", { status: 200 })
    }
    const end = new Date()
    const start = new Date(end)
    start.setUTCDate(start.getUTCDate() - 7)
    ctx.waitUntil(syncOura(env, pacificDate(start), pacificDate(end))
      .then(() => env.DB.prepare("UPDATE webhook_events SET processed_at = ? WHERE event_id = ?").bind(new Date().toISOString(), eventId).run())
      .catch((error: unknown) => console.error("webhook sync failed", error)))
  }
  return new Response("OK", { status: 200 })
}

const serveAsset = (request: Request, env: Env): Promise<Response> => {
  const url = new URL(request.url)
  const assetUrl = new URL(request.url)
  if (!url.pathname.includes(".")) assetUrl.pathname = "/index.html"
  return env.ASSETS.fetch(new Request(assetUrl, request))
}

const api = async (request: Request, env: Env, url: URL): Promise<Response> => {
  if (url.pathname === "/api/status" && request.method === "GET") return json(await status(env))
  if (url.pathname === "/api/records" && request.method === "GET") {
    const start = url.searchParams.get("start") ?? undefined
    const end = url.searchParams.get("end") ?? undefined
    const type = url.searchParams.get("type") ?? undefined
    if ((start && !datePattern.test(start)) || (end && !datePattern.test(end))) {
      throw new HttpError(400, "invalid_date", "Dates must use YYYY-MM-DD")
    }
    return json(await records(env, { start, end, type }))
  }
  if (url.pathname === "/api/sync" && request.method === "POST") {
    const body: { start?: string; end?: string } = await request.json<{ start?: string; end?: string }>().catch(() => ({}))
    const end = body.end && datePattern.test(body.end) ? body.end : pacificDate(new Date())
    const defaultStart = new Date(`${end}T00:00:00Z`)
    defaultStart.setUTCDate(defaultStart.getUTCDate() - 90)
    const start = body.start && datePattern.test(body.start) ? body.start : defaultStart.toISOString().slice(0, 10)
    return json(await syncOura(env, start, end))
  }
  throw new HttpError(404, "not_found", "API route not found")
}

const oauth = async (request: Request, env: Env, url: URL): Promise<Response> => {
  if (!env.OURA_CLIENT_ID) throw new HttpError(503, "oura_not_configured", "Oura OAuth is not configured")
  if (url.pathname === "/oauth/start") {
    const state = randomState()
    const now = new Date()
    const expires = new Date(now.getTime() + 10 * 60_000)
    await env.DB.prepare("INSERT INTO oauth_states (state_hash, expires_at, created_at) VALUES (?, ?, ?)")
      .bind(await sha256(state), expires.toISOString(), now.toISOString()).run()
    const authorize = new URL("https://cloud.ouraring.com/oauth/authorize")
    authorize.search = new URLSearchParams({
      response_type: "code",
      client_id: env.OURA_CLIENT_ID,
      redirect_uri: env.OURA_REDIRECT_URI,
      scope: "email personal daily heartrate workout tag session spo2 ring_configuration stress heart_health",
      state
    }).toString()
    return Response.redirect(authorize, 302)
  }
  if (url.pathname === "/oauth/callback") {
    const code = url.searchParams.get("code")
    const state = url.searchParams.get("state")
    if (!code || !state) throw new HttpError(400, "invalid_oauth_callback", "OAuth callback omitted code or state")
    const stateHash = await sha256(state)
    const stored = await env.DB.prepare("SELECT expires_at FROM oauth_states WHERE state_hash = ?")
      .bind(stateHash).first<{ expires_at: string }>()
    await env.DB.prepare("DELETE FROM oauth_states WHERE state_hash = ?").bind(stateHash).run()
    if (!stored || stored.expires_at < new Date().toISOString()) throw new HttpError(400, "invalid_oauth_state", "OAuth state is invalid or expired")
    await exchangeAuthorizationCode(env, code)
    return Response.redirect(new URL("/?connected=1", request.url), 302)
  }
  throw new HttpError(404, "not_found", "OAuth route not found")
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      const url = new URL(request.url)
      if (url.hostname === "oura-hooks.ronsanzone.dev") return await webhook(request, env, url, ctx)
      if (url.pathname === "/_health") return json({ ok: true, service: "oura-observatory", mode: env.DEPLOYMENT_MODE })
      if (url.pathname.startsWith("/api/")) return await api(request, env, url)
      if (url.pathname.startsWith("/oauth/")) return await oauth(request, env, url)
      if (request.method !== "GET" && request.method !== "HEAD") throw new HttpError(405, "method_not_allowed", "Method not allowed")
      return await serveAsset(request, env)
    } catch (error) {
      if (error instanceof HttpError) return errorResponse(error.status, error.code, error.message)
      console.error("unhandled request error", error)
      return errorResponse(500, "internal_error", "The observatory encountered an unexpected error")
    }
  },
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const end = new Date()
    const start = new Date(end)
    start.setUTCDate(start.getUTCDate() - 7)
    ctx.waitUntil(Promise.allSettled([
      syncOura(env, pacificDate(start), pacificDate(end)),
      reconcileOuraWebhooks(env)
    ]).then((results) => {
      for (const result of results) if (result.status === "rejected") console.error("scheduled task failed", result.reason)
    }))
  }
} satisfies ExportedHandler<Env>
