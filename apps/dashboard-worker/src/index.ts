import { constantTimeEqual, randomState, sha256 } from "./crypto.js"
import { localDay } from "@oura/shared"
import { errorResponse, HttpError, json, readBoundedText } from "./http.js"
import { exchangeAuthorizationCode, syncOura } from "./oura.js"
import { requireAccessIdentity, requireSameOrigin, secureResponse } from "./security.js"
import { records, status } from "./storage.js"
import { experimentsApi } from "./experiments.js"
import type { AppEnv } from "./types.js"
import { reconcileOuraWebhooks, webhookDataTypeToRecordType } from "./webhooks.js"

const maxWebhookBodyBytes = 64 * 1024
const maxSyncBodyBytes = 4 * 1024
const routineSyncDays = 2
const datePattern = /^\d{4}-\d{2}-\d{2}$/

const validDate = (value: string): boolean => {
  if (!datePattern.test(value)) return false
  const parsed = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

const validateDateRange = (start: string, end: string): void => {
  if (!validDate(start) || !validDate(end)) throw new HttpError(400, "invalid_date", "Dates must use YYYY-MM-DD")
  const startTime = Date.parse(`${start}T00:00:00Z`)
  const endTime = Date.parse(`${end}T00:00:00Z`)
  if (startTime > endTime) throw new HttpError(400, "invalid_date_range", "Start date must not follow end date")
  if ((endTime - startTime) / 86_400_000 > 366) {
    throw new HttpError(400, "date_range_too_large", "Date range must not exceed 366 days")
  }
}

const webhookSignature = async (secret: string, timestamp: string, body: string): Promise<string> => {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(timestamp + body)))
  return [...signature].map((byte) => byte.toString(16).padStart(2, "0")).join("").toUpperCase()
}

const enforceWebhookRateLimit = async (request: Request, env: AppEnv): Promise<void> => {
  const methodClass = request.method === "GET" ? "verification" : "events"
  const { success } = await env.WEBHOOK_RATE_LIMITER.limit({ key: `oura-webhook:${methodClass}` })
  if (!success) throw new HttpError(429, "rate_limited", "Webhook request rate exceeded")
}

const webhook = async (request: Request, env: AppEnv, url: URL): Promise<Response> => {
  if (url.pathname === "/_health") return json({ ok: true, service: "oura-webhook", mode: env.DEPLOYMENT_MODE })
  if (url.pathname !== "/oura-webhook") throw new HttpError(404, "not_found", "Webhook route not found")
  await enforceWebhookRateLimit(request, env)

  if (request.method === "GET") {
    const token = url.searchParams.get("verification_token")
    const challenge = url.searchParams.get("challenge")
    if (!env.OURA_WEBHOOK_VERIFICATION_TOKEN || !token || !await constantTimeEqual(token, env.OURA_WEBHOOK_VERIFICATION_TOKEN)) {
      throw new HttpError(401, "invalid_verification_token", "Webhook verification failed")
    }
    if (!challenge) throw new HttpError(400, "missing_challenge", "Webhook challenge is required")
    return json({ challenge })
  }

  if (request.method !== "POST") throw new HttpError(405, "method_not_allowed", "Method not allowed")
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    throw new HttpError(415, "unsupported_media_type", "Webhook body must be JSON")
  }
  if (!env.OURA_CLIENT_SECRET) throw new HttpError(503, "oura_not_configured", "Oura webhook secret is not configured")
  const signature = request.headers.get("x-oura-signature")
  const timestamp = request.headers.get("x-oura-timestamp")
  if (!signature || !timestamp) throw new HttpError(401, "missing_signature", "Oura signature headers are required")

  const body = await readBoundedText(request, maxWebhookBodyBytes)
  const expected = await webhookSignature(env.OURA_CLIENT_SECRET, timestamp, body)
  if (!await constantTimeEqual(signature.toUpperCase(), expected)) {
    throw new HttpError(401, "invalid_signature", "Oura signature is invalid")
  }

  let event: { event_type?: string; data_type?: string; object_id?: string; user_id?: string }
  try {
    event = JSON.parse(body) as typeof event
  } catch {
    throw new HttpError(400, "invalid_json", "Webhook body must be valid JSON")
  }
  if (!event || typeof event !== "object") throw new HttpError(400, "invalid_event", "Webhook event is invalid")

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
    }
    // Webhooks are event notifications. The scheduled sync coalesces create/update
    // events instead of starting one full API sync per notification.
    await env.DB.prepare("UPDATE webhook_events SET processed_at = ? WHERE event_id = ?")
      .bind(new Date().toISOString(), eventId).run()
  }
  return new Response("OK", { status: 200 })
}

const serveAsset = (request: Request, env: AppEnv): Promise<Response> => {
  const url = new URL(request.url)
  const assetUrl = new URL(request.url)
  if (!url.pathname.includes(".")) assetUrl.pathname = "/index.html"
  return env.ASSETS.fetch(new Request(assetUrl, request))
}

const api = async (request: Request, env: AppEnv, url: URL): Promise<Response> => {
  if (url.pathname === "/api/experiments" || url.pathname.startsWith("/api/experiments/")) return experimentsApi(request, env, url)
  if (url.pathname === "/api/status" && request.method === "GET") return json(await status(env))
  if (url.pathname === "/api/records" && request.method === "GET") {
    const start = url.searchParams.get("start") ?? undefined
    const end = url.searchParams.get("end") ?? undefined
    const type = url.searchParams.get("type") ?? undefined
    if ((start && !validDate(start)) || (end && !validDate(end))) {
      throw new HttpError(400, "invalid_date", "Dates must use YYYY-MM-DD")
    }
    if (start && end) validateDateRange(start, end)
    const offset = Number(url.searchParams.get("offset") ?? 0)
    if (!Number.isSafeInteger(offset) || offset < 0) throw new HttpError(400, "invalid_offset", "Offset must be a non-negative integer")
    return json(await records(env, { start, end, type, offset }))
  }
  if (url.pathname === "/api/sync" && request.method === "POST") {
    requireSameOrigin(request)
    if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
      throw new HttpError(415, "unsupported_media_type", "Sync body must be JSON")
    }
    const text = await readBoundedText(request, maxSyncBodyBytes)
    let body: { start?: unknown; end?: unknown } = {}
    try {
      body = text ? JSON.parse(text) as typeof body : {}
    } catch {
      throw new HttpError(400, "invalid_json", "Sync body must be valid JSON")
    }
    if (!body || typeof body !== "object") throw new HttpError(400, "invalid_body", "Sync body must be a JSON object")
    if (body.start !== undefined && typeof body.start !== "string") throw new HttpError(400, "invalid_date", "Start date must use YYYY-MM-DD")
    if (body.end !== undefined && typeof body.end !== "string") throw new HttpError(400, "invalid_date", "End date must use YYYY-MM-DD")
    const end = body.end ?? localDay(new Date())
    const defaultStart = new Date(`${end}T00:00:00Z`)
    if (Number.isNaN(defaultStart.getTime())) throw new HttpError(400, "invalid_date", "End date must use YYYY-MM-DD")
    defaultStart.setUTCDate(defaultStart.getUTCDate() - 90)
    const start = body.start ?? defaultStart.toISOString().slice(0, 10)
    validateDateRange(start, end)
    return json(await syncOura(env, start, end, "manual"))
  }
  throw new HttpError(404, "not_found", "API route not found")
}

const oauth = async (request: Request, env: AppEnv, url: URL): Promise<Response> => {
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
      scope: "daily heartrate workout tag session spo2 stress heart_health",
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

const httpsRedirect = (url: URL): Response => {
  const destination = new URL(url)
  destination.protocol = "https:"
  return Response.redirect(destination, 308)
}

export default {
  async fetch(request: Request, env: AppEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)
    const isWebhookHost = url.hostname === env.WEBHOOK_HOSTNAME
    const isDashboardHost = url.hostname === env.DASHBOARD_HOSTNAME || env.DEPLOYMENT_MODE !== "production"
    let response: Response
    try {
      if (env.DEPLOYMENT_MODE === "production" && url.protocol !== "https:") {
        response = httpsRedirect(url)
      } else if (isWebhookHost) {
        response = await webhook(request, env, url)
      } else if (!isDashboardHost) {
        throw new HttpError(404, "not_found", "Host not found")
      } else {
        await requireAccessIdentity(request, env)
        if (url.pathname === "/_health") response = json({ ok: true, service: "oura-observatory", mode: env.DEPLOYMENT_MODE })
        else if (url.pathname.startsWith("/api/")) response = await api(request, env, url)
        else if (url.pathname.startsWith("/oauth/")) response = await oauth(request, env, url)
        else {
          if (request.method !== "GET" && request.method !== "HEAD") throw new HttpError(405, "method_not_allowed", "Method not allowed")
          response = await serveAsset(request, env)
        }
      }
    } catch (error) {
      if (error instanceof HttpError) {
        const headers = error.status === 429 ? { "retry-after": "60" } : undefined
        response = errorResponse(error.status, error.code, error.message)
        if (headers) for (const [name, value] of Object.entries(headers)) response.headers.set(name, value)
      } else {
        console.error("unhandled request error", error)
        response = errorResponse(500, "internal_error", "The observatory encountered an unexpected error")
      }
    }
    return secureResponse(response, { dashboard: !isWebhookHost, https: url.protocol === "https:" })
  },
  async scheduled(_controller: ScheduledController, env: AppEnv, ctx: ExecutionContext): Promise<void> {
    const end = new Date()
    const start = new Date(end)
    start.setUTCDate(start.getUTCDate() - routineSyncDays)
    ctx.waitUntil(Promise.allSettled([
      syncOura(env, localDay(start), localDay(end), "scheduled"),
      reconcileOuraWebhooks(env)
    ]).then((results) => {
      for (const result of results) if (result.status === "rejected") console.error("scheduled task failed", result.reason)
    }))
  }
} satisfies ExportedHandler<AppEnv>
