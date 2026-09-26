import { HttpError } from "./http.js"
import { dayStart, shiftDay } from "@oura/shared"
import { acquireSyncLock, loadTokens, releaseSyncLock, storeTokens, upsertRecords } from "./storage.js"
import type { AppEnv, StoredTokens } from "./types.js"

const API_ROOT = "https://api.ouraring.com/v2/usercollection"
const TOKEN_URL = "https://api.ouraring.com/oauth/token"

export const endpoints: Record<string, string> = {
  daily_activity: "daily_activity",
  daily_sleep: "daily_sleep",
  daily_readiness: "daily_readiness",
  sleep: "sleep",
  heart_rate: "heartrate",
  workout: "workout",
  session: "session",
  tag: "enhanced_tag",
  daily_spo2: "daily_spo2",
  daily_stress: "daily_stress",
  daily_resilience: "daily_resilience",
  cardiovascular_age: "daily_cardiovascular_age",
  vo2_max: "vO2_max"
}

const requireClient = (env: AppEnv): { clientId: string; clientSecret: string } => {
  if (!env.OURA_CLIENT_ID || !env.OURA_CLIENT_SECRET) throw new HttpError(503, "oura_not_configured", "Oura OAuth is not configured")
  return { clientId: env.OURA_CLIENT_ID, clientSecret: env.OURA_CLIENT_SECRET }
}

type TokenPayload = {
  access_token: string
  refresh_token?: string
  expires_in?: number
  scope?: string
}

const parseTokenPayload = (payload: TokenPayload, fallbackRefresh?: string): StoredTokens => {
  const refreshToken = payload.refresh_token ?? fallbackRefresh
  if (!payload.access_token || !refreshToken) throw new Error("Oura token response omitted required tokens")
  return {
    accessToken: payload.access_token,
    refreshToken,
    expiresAt: typeof payload.expires_in === "number" ? new Date(Date.now() + payload.expires_in * 1000).toISOString() : null,
    scope: payload.scope ?? null
  }
}

export const exchangeAuthorizationCode = async (env: AppEnv, code: string): Promise<void> => {
  const client = requireClient(env)
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: env.OURA_REDIRECT_URI,
      client_id: client.clientId,
      client_secret: client.clientSecret
    })
  })
  if (!response.ok) throw new HttpError(502, "oauth_exchange_failed", `Oura token exchange failed with HTTP ${response.status}`)
  await storeTokens(env, parseTokenPayload(await response.json<TokenPayload>()))
}

const refresh = async (env: AppEnv, refreshToken: string): Promise<StoredTokens> => {
  const client = requireClient(env)
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: client.clientId,
      client_secret: client.clientSecret
    })
  })
  if (!response.ok) throw new HttpError(502, "token_refresh_failed", `Oura token refresh failed with HTTP ${response.status}`)
  const tokens = parseTokenPayload(await response.json<TokenPayload>(), refreshToken)
  await storeTokens(env, tokens)
  return tokens
}

export const collection = async (
  env: AppEnv,
  endpoint: string,
  start: string,
  end: string,
  originalTokens: StoredTokens
): Promise<Record<string, unknown>[]> => {
  // Bound high-volume HR requests; 28 calendar days also stay below 30 elapsed
  // days across DST. Pagination still applies within each chunk.
  if (endpoint === "heartrate" && shiftDay(start, 27) < end) {
    const items: Record<string, unknown>[] = []
    for (let cursor = start; cursor <= end; cursor = shiftDay(cursor, 28)) {
      const chunkEnd = shiftDay(cursor, 27) < end ? shiftDay(cursor, 27) : end
      items.push(...await collection(env, endpoint, cursor, chunkEnd, originalTokens))
    }
    return items
  }
  let tokens = originalTokens
  let url = `${API_ROOT}/${endpoint}`
  const range: Record<string, string> = endpoint === "heartrate"
    ? { start_datetime: dayStart(start), end_datetime: dayStart(shiftDay(end, 1)) }
    : { start_date: start, end_date: end }
  const params = new URLSearchParams(range)
  const items: Record<string, unknown>[] = []
  let refreshed = false

  while (url) {
    let response = await fetch(`${url}?${params}`, { headers: { authorization: `Bearer ${tokens.accessToken}` } })
    if (response.status === 401 && !refreshed) {
      tokens = await refresh(env, tokens.refreshToken)
      Object.assign(originalTokens, tokens)
      refreshed = true
      response = await fetch(`${url}?${params}`, { headers: { authorization: `Bearer ${tokens.accessToken}` } })
    }
    if (!response.ok) throw new HttpError(response.status, "oura_collection_failed", `${endpoint} returned HTTP ${response.status}`)
    const payload = await response.json<{ data?: Record<string, unknown>[]; next_token?: string }>()
    items.push(...(payload.data ?? []))
    if (payload.next_token) {
      params.set("next_token", payload.next_token)
    } else {
      url = ""
    }
  }
  return items
}

export type SyncTrigger = "manual" | "scheduled"

export const syncOura = async (
  env: AppEnv,
  start: string,
  end: string,
  trigger: SyncTrigger
): Promise<Record<string, unknown>> => {
  const tokens = await loadTokens(env)
  if (!tokens) throw new HttpError(409, "oura_not_connected", "Connect the Oura account before syncing")
  const ownerToken = await acquireSyncLock(env)
  if (!ownerToken) {
    return { start, end, trigger, fetched: {}, skipped: { sync: "already_running" } }
  }
  const startedAt = new Date().toISOString()
  try {
    const log = await env.DB.prepare("INSERT INTO sync_log (started_at, status) VALUES (?, 'running') RETURNING id")
      .bind(startedAt).first<{ id: number }>()
    const fetched: Record<string, number> = {}
    const skipped: Record<string, string> = {}

    for (const [dataType, endpoint] of Object.entries(endpoints)) {
      try {
        const items = await collection(env, endpoint, start, end, tokens)
        fetched[dataType] = await upsertRecords(env, dataType, items)
      } catch (error) {
        skipped[dataType] = error instanceof HttpError ? `HTTP ${error.status}` : "unexpected_error"
      }
    }
    const result = { start, end, trigger, fetched, skipped }
    if (log) {
      await env.DB.prepare("UPDATE sync_log SET finished_at = ?, status = ?, details = ? WHERE id = ?")
        .bind(new Date().toISOString(), Object.keys(fetched).length === 0 ? "failed" : Object.keys(skipped).length ? "partial" : "complete", JSON.stringify(result), log.id).run()
    }
    return result
  } finally {
    try {
      await releaseSyncLock(env, ownerToken)
    } catch (error) {
      console.error("sync lock release failed", error)
    }
  }
}
