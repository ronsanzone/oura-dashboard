import { HttpError } from "./http.js"
import { loadTokens, storeTokens, upsertRecords } from "./storage.js"
import type { Env, StoredTokens } from "./types.js"

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

const requireClient = (env: Env): { clientId: string; clientSecret: string } => {
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

export const exchangeAuthorizationCode = async (env: Env, code: string): Promise<void> => {
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

const refresh = async (env: Env, refreshToken: string): Promise<StoredTokens> => {
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

const collection = async (
  env: Env,
  endpoint: string,
  start: string,
  end: string,
  originalTokens: StoredTokens
): Promise<Record<string, unknown>[]> => {
  let tokens = originalTokens
  let url = `${API_ROOT}/${endpoint}`
  let params = new URLSearchParams({ start_date: start, end_date: end })
  const items: Record<string, unknown>[] = []
  let refreshed = false

  while (url) {
    let response = await fetch(`${url}?${params}`, { headers: { authorization: `Bearer ${tokens.accessToken}` } })
    if (response.status === 401 && !refreshed) {
      tokens = await refresh(env, tokens.refreshToken)
      refreshed = true
      response = await fetch(`${url}?${params}`, { headers: { authorization: `Bearer ${tokens.accessToken}` } })
    }
    if (!response.ok) throw new HttpError(response.status, "oura_collection_failed", `${endpoint} returned HTTP ${response.status}`)
    const payload = await response.json<{ data?: Record<string, unknown>[]; next_token?: string }>()
    items.push(...(payload.data ?? []))
    if (payload.next_token) {
      params = new URLSearchParams({ next_token: payload.next_token })
    } else {
      url = ""
    }
  }
  return items
}

export const syncOura = async (env: Env, start: string, end: string): Promise<Record<string, unknown>> => {
  const tokens = await loadTokens(env)
  if (!tokens) throw new HttpError(409, "oura_not_connected", "Connect the Oura account before syncing")
  const startedAt = new Date().toISOString()
  const log = await env.DB.prepare("INSERT INTO sync_log (started_at, status) VALUES (?, 'running') RETURNING id")
    .bind(startedAt).first<{ id: number }>()
  const synced: Record<string, number> = {}
  const skipped: Record<string, string> = {}

  for (const [dataType, endpoint] of Object.entries(endpoints)) {
    try {
      const items = await collection(env, endpoint, start, end, tokens)
      synced[dataType] = await upsertRecords(env, dataType, items)
    } catch (error) {
      skipped[dataType] = error instanceof HttpError ? `HTTP ${error.status}` : "unexpected_error"
    }
  }
  const result = { start, end, synced, skipped }
  if (log) {
    await env.DB.prepare("UPDATE sync_log SET finished_at = ?, status = ?, details = ? WHERE id = ?")
      .bind(new Date().toISOString(), Object.keys(synced).length === 0 ? "failed" : "complete", JSON.stringify(result), log.id).run()
  }
  return result
}
