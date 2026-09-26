import { dayStart, shiftDay, type DatasetCount, type ObservatoryStatus, type RecordsPage } from "@oura/shared"
import { decrypt, encrypt, randomState, sha256 } from "./crypto.js"
import type { AppEnv, StoredTokens } from "./types.js"

type RecordRow = {
  data_type: string
  record_id: string
  record_date: string | null
  start_datetime: string | null
  end_datetime: string | null
  payload_json: string
  synced_at: string
}

export const status = async (env: AppEnv): Promise<ObservatoryStatus> => {
  const [summary, datasets, token, sync] = await Promise.all([
    env.DB.prepare(`
      SELECT COUNT(*) AS records, COUNT(DISTINCT record_date) AS days,
             MIN(record_date) AS first_date, MAX(record_date) AS last_date,
             MAX(synced_at) AS last_sync
      FROM records
    `).first<{ records: number; days: number; first_date: string | null; last_date: string | null; last_sync: string | null }>(),
    env.DB.prepare(`
      SELECT data_type, COUNT(*) AS count, MIN(record_date) AS first_date, MAX(record_date) AS last_date
      FROM records GROUP BY data_type ORDER BY data_type
    `).all<DatasetCount>(),
    env.DB.prepare("SELECT scope FROM oauth_tokens WHERE account_id = 'primary'").first<{ scope: string | null }>(),
    env.DB.prepare("SELECT started_at, finished_at, status, details FROM sync_log ORDER BY id DESC LIMIT 1")
      .first<{ started_at: string; finished_at: string | null; status: string; details: string | null }>()
  ])
  return {
    mode: env.DEPLOYMENT_MODE,
    connected: token !== null,
    records: summary?.records ?? 0,
    days: summary?.days ?? 0,
    first_date: summary?.first_date ?? null,
    last_date: summary?.last_date ?? null,
    last_sync: summary?.last_sync ?? null,
    datasets: datasets.results,
    scopes: token?.scope?.split(/[ ,]+/).filter(Boolean) ?? [],
    sync: sync ? { started_at: sync.started_at, finished_at: sync.finished_at, status: sync.status, skipped: sync.details ? JSON.parse(sync.details).skipped ?? {} : {} } : null
  }
}

export const records = async (
  env: AppEnv,
  options: { start?: string; end?: string; type?: string; offset?: number }
): Promise<RecordsPage> => {
  const clauses: string[] = []
  const bindings: (string | number)[] = []
  const date = "COALESCE(record_date, json_extract(payload_json, '$.start_day'), json_extract(payload_json, '$.day'))"
  const timestamp = "COALESCE(start_datetime, json_extract(payload_json, '$.timestamp'), json_extract(payload_json, '$.bedtime_start'))"
  if (options.type) {
    clauses.push("data_type = ?")
    bindings.push(options.type)
  }
  if (options.start) {
    clauses.push(`(CASE WHEN ${date} IS NOT NULL THEN ${date} >= ? ELSE julianday(${timestamp}) >= julianday(?) END)`)
    bindings.push(options.start, dayStart(options.start))
  }
  if (options.end) {
    clauses.push(`(CASE WHEN ${date} IS NOT NULL THEN ${date} <= ? ELSE julianday(${timestamp}) < julianday(?) END)`)
    bindings.push(options.end, dayStart(shiftDay(options.end, 1)))
  }
  const where = clauses.length === 0 ? "" : `WHERE ${clauses.join(" AND ")}`
  const result = await env.DB.prepare(`
    SELECT data_type, record_id, record_date, start_datetime, end_datetime, payload_json, synced_at
    FROM records ${where}
    ORDER BY COALESCE(record_date, start_datetime), data_type, record_id
    LIMIT 2001 OFFSET ?
  `).bind(...bindings, options.offset ?? 0).all<RecordRow>()
  return {
    records: result.results.slice(0, 2000).map(({ payload_json, ...row }) => ({ ...row, payload: JSON.parse(payload_json) as Record<string, unknown> })),
    nextOffset: result.results.length > 2000 ? (options.offset ?? 0) + 2000 : null
  }
}

const recordId = async (dataType: string, item: Record<string, unknown>): Promise<string> => {
  for (const key of ["id", "timestamp", "day", "start_datetime"]) {
    if (typeof item[key] === "string") return item[key]
  }
  return `${dataType}-${await sha256(JSON.stringify(item))}`
}

export const upsertRecords = async (
  env: AppEnv,
  dataType: string,
  items: readonly Record<string, unknown>[]
): Promise<number> => {
  const syncedAt = new Date().toISOString()
  const statements: D1PreparedStatement[] = []
  for (const item of items) {
    statements.push(env.DB.prepare(`
      INSERT INTO records (
        data_type, record_id, record_date, start_datetime, end_datetime, payload_json, synced_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(data_type, record_id) DO UPDATE SET
        record_date = excluded.record_date,
        start_datetime = excluded.start_datetime,
        end_datetime = excluded.end_datetime,
        payload_json = excluded.payload_json,
        synced_at = excluded.synced_at
      WHERE records.payload_json IS NOT excluded.payload_json
    `).bind(
      dataType,
      await recordId(dataType, item),
      item.day ?? item.date ?? item.start_day ?? null,
      item.start_datetime ?? item.bedtime_start ?? item.timestamp ?? item.start_time ?? null,
      item.end_datetime ?? item.bedtime_end ?? item.end_time ?? null,
      JSON.stringify(item),
      syncedAt
    ))
  }
  for (let offset = 0; offset < statements.length; offset += 75) {
    await env.DB.batch(statements.slice(offset, offset + 75))
  }
  return statements.length
}

const syncLockName = "oura"
const syncLockTtlMs = 30 * 60 * 1000

export const acquireSyncLock = async (env: AppEnv): Promise<string | null> => {
  const ownerToken = randomState()
  const acquiredAt = new Date()
  const expiresAt = new Date(acquiredAt.getTime() + syncLockTtlMs)
  const row = await env.DB.prepare(`
    INSERT INTO sync_locks (lock_name, owner_token, acquired_at, expires_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(lock_name) DO UPDATE SET
      owner_token = excluded.owner_token,
      acquired_at = excluded.acquired_at,
      expires_at = excluded.expires_at
    WHERE sync_locks.expires_at <= excluded.acquired_at
    RETURNING owner_token
  `).bind(syncLockName, ownerToken, acquiredAt.toISOString(), expiresAt.toISOString())
    .first<{ owner_token: string }>()
  return row?.owner_token === ownerToken ? ownerToken : null
}

export const releaseSyncLock = async (env: AppEnv, ownerToken: string): Promise<void> => {
  await env.DB.prepare("DELETE FROM sync_locks WHERE lock_name = ? AND owner_token = ?")
    .bind(syncLockName, ownerToken).run()
}

const requireEncryptionKey = (env: AppEnv): string => {
  if (!env.OURA_TOKEN_ENCRYPTION_KEY) throw new Error("OURA_TOKEN_ENCRYPTION_KEY is not configured")
  return env.OURA_TOKEN_ENCRYPTION_KEY
}

export const storeTokens = async (env: AppEnv, tokens: StoredTokens): Promise<void> => {
  const key = requireEncryptionKey(env)
  await env.DB.prepare(`
    INSERT INTO oauth_tokens (
      account_id, access_token_ciphertext, refresh_token_ciphertext, expires_at, scope, updated_at
    ) VALUES ('primary', ?, ?, ?, ?, ?)
    ON CONFLICT(account_id) DO UPDATE SET
      access_token_ciphertext = excluded.access_token_ciphertext,
      refresh_token_ciphertext = excluded.refresh_token_ciphertext,
      expires_at = excluded.expires_at,
      scope = excluded.scope,
      updated_at = excluded.updated_at
  `).bind(
    await encrypt(tokens.accessToken, key),
    await encrypt(tokens.refreshToken, key),
    tokens.expiresAt,
    tokens.scope,
    new Date().toISOString()
  ).run()
}

export const loadTokens = async (env: AppEnv): Promise<StoredTokens | null> => {
  const row = await env.DB.prepare(`
    SELECT access_token_ciphertext, refresh_token_ciphertext, expires_at, scope
    FROM oauth_tokens WHERE account_id = 'primary'
  `).first<{ access_token_ciphertext: string; refresh_token_ciphertext: string; expires_at: string | null; scope: string | null }>()
  if (!row) return null
  const key = requireEncryptionKey(env)
  return {
    accessToken: await decrypt(row.access_token_ciphertext, key),
    refreshToken: await decrypt(row.refresh_token_ciphertext, key),
    expiresAt: row.expires_at,
    scope: row.scope
  }
}
