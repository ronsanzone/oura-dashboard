import {
  buildDailyPoints,
  effectiveDay,
  shiftDay,
  type DailySummariesResponse,
  type DatasetCount,
  type ObservatoryStatus,
  type OuraRecord,
  type RecordsPage,
  type SelectedDayResponse
} from "@oura/shared"
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
  effective_date: string
}

type RecordKey = { effectiveDate: string; dataType: string; recordId: string }
export class InvalidRecordsCursorError extends Error {}

const encodeCursor = (row: RecordRow): string => {
  const bytes = new TextEncoder().encode(JSON.stringify([row.effective_date, row.data_type, row.record_id]))
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")
}

const decodeCursor = (cursor: string): RecordKey => {
  try {
    const base64 = cursor.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(cursor.length / 4) * 4, "=")
    const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0))
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown
    if (!Array.isArray(parsed) || parsed.length !== 3 || parsed.some((value) => typeof value !== "string")) throw new Error()
    const [effectiveDate, dataType, recordId] = parsed as [string, string, string]
    return { effectiveDate, dataType, recordId }
  } catch {
    throw new InvalidRecordsCursorError("Records cursor is invalid")
  }
}

const rowToRecord = ({ payload_json, effective_date: _effectiveDate, ...row }: RecordRow): OuraRecord => ({
  ...row,
  payload: JSON.parse(payload_json) as Record<string, unknown>
})

const exactEffectiveDate = (row: RecordRow): string => effectiveDay(rowToRecord(row))

export const status = async (env: AppEnv): Promise<ObservatoryStatus> => {
  const [summary, datasets, token, sync] = await Promise.all([
    env.DB.prepare(`
      SELECT record_count AS records, day_count AS days, first_date, last_date, last_sync
      FROM record_status WHERE singleton = 1
    `).first<{ records: number; days: number; first_date: string | null; last_date: string | null; last_sync: string | null }>(),
    env.DB.prepare(`
      SELECT data_type, record_count AS count, first_date, last_date
      FROM record_dataset_status ORDER BY data_type
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
  options: { start?: string; end?: string; type?: string; cursor?: string }
): Promise<RecordsPage> => {
  const clauses: string[] = []
  const bindings: (string | number)[] = []
  if (options.type) {
    clauses.push("data_type = ?")
    bindings.push(options.type)
  }
  if (options.start) {
    clauses.push("effective_date >= ?")
    // Existing timestamps may be UTC or carry a source offset. The one-day
    // index window is narrowed exactly in code using the account timezone.
    bindings.push(shiftDay(options.start, -1))
  }
  if (options.end) {
    clauses.push("effective_date <= ?")
    bindings.push(shiftDay(options.end, 1))
  }
  if (options.cursor) {
    const cursor = decodeCursor(options.cursor)
    clauses.push(`(
      effective_date > ? OR
      (effective_date = ? AND data_type > ?) OR
      (effective_date = ? AND data_type = ? AND record_id > ?)
    )`)
    bindings.push(cursor.effectiveDate, cursor.effectiveDate, cursor.dataType, cursor.effectiveDate, cursor.dataType, cursor.recordId)
  }
  const where = clauses.length === 0 ? "" : `WHERE ${clauses.join(" AND ")}`
  const result = await env.DB.prepare(`
    SELECT data_type, record_id, record_date, start_datetime, end_datetime, payload_json, synced_at, effective_date
    FROM records ${where}
    ORDER BY effective_date, data_type, record_id
    LIMIT 2001
  `).bind(...bindings).all<RecordRow>()
  const candidates = result.results.slice(0, 2000)
  const page = candidates.filter((row) => {
    const day = exactEffectiveDate(row)
    return (!options.start || day >= options.start) && (!options.end || day <= options.end)
  })
  return {
    records: page.map(rowToRecord),
    nextCursor: result.results.length > 2000 ? encodeCursor(candidates[candidates.length - 1]!) : null
  }
}

const dailyTypes = [
  "daily_sleep", "sleep", "daily_readiness", "daily_activity", "daily_stress",
  "daily_spo2", "cardiovascular_age", "vo2_max"
] as const

export const dailySummaries = async (
  env: AppEnv,
  options: { start: string; end: string }
): Promise<DailySummariesResponse> => {
  const placeholders = dailyTypes.map(() => "?").join(", ")
  const result = await env.DB.prepare(`
    SELECT data_type, record_id, record_date, start_datetime, end_datetime, payload_json, synced_at, effective_date
    FROM records
    WHERE effective_date >= ? AND effective_date <= ? AND data_type IN (${placeholders})
    ORDER BY effective_date, data_type, record_id
  `).bind(shiftDay(options.start, -1), shiftDay(options.end, 1), ...dailyTypes).all<RecordRow>()
  const exact = result.results.filter((row) => {
    const day = exactEffectiveDate(row)
    return day >= options.start && day <= options.end
  })
  return { days: buildDailyPoints(exact.map(rowToRecord)) }
}

const selectedDayTypes = ["sleep", "daily_activity", "heart_rate", "tag", "session", "workout"] as const

export const selectedDay = async (env: AppEnv, day: string): Promise<SelectedDayResponse> => {
  const placeholders = selectedDayTypes.map(() => "?").join(", ")
  const result = await env.DB.prepare(`
    SELECT data_type, record_id, record_date, start_datetime, end_datetime, payload_json, synced_at, effective_date
    FROM records
    WHERE effective_date >= ? AND effective_date <= ? AND data_type IN (${placeholders})
    ORDER BY effective_date, data_type, record_id
  `).bind(shiftDay(day, -1), shiftDay(day, 1), ...selectedDayTypes).all<RecordRow>()
  return { day, records: result.results.map(rowToRecord) }
}

const recordId = async (dataType: string, item: Record<string, unknown>): Promise<string> => {
  for (const key of ["id", "timestamp", "day", "start_datetime"]) {
    if (typeof item[key] === "string") return item[key]
  }
  return `${dataType}-${await sha256(JSON.stringify(item))}`
}

const firstString = (values: readonly unknown[]): string | null =>
  values.find((value): value is string => typeof value === "string" && value.length > 0) ?? null

export const upsertRecords = async (
  env: AppEnv,
  dataType: string,
  items: readonly Record<string, unknown>[]
): Promise<number> => {
  const syncedAt = new Date().toISOString()
  const statements: D1PreparedStatement[] = []
  for (const item of items) {
    const recordDate = firstString([item.day, item.start_day, item.date])
    const startDatetime = firstString([item.start_datetime, item.bedtime_start, item.timestamp, item.start_time])
    statements.push(env.DB.prepare(`
      INSERT INTO records (
        data_type, record_id, record_date, start_datetime, end_datetime, payload_json, synced_at, effective_date
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(data_type, record_id) DO UPDATE SET
        record_date = excluded.record_date,
        start_datetime = excluded.start_datetime,
        end_datetime = excluded.end_datetime,
        payload_json = excluded.payload_json,
        synced_at = excluded.synced_at,
        effective_date = excluded.effective_date
      WHERE records.payload_json IS NOT excluded.payload_json
         OR records.effective_date IS NOT excluded.effective_date
    `).bind(
      dataType,
      await recordId(dataType, item),
      recordDate,
      startDatetime,
      item.end_datetime ?? item.bedtime_end ?? item.end_time ?? null,
      JSON.stringify(item),
      syncedAt,
      effectiveDay({ payload: item, record_date: recordDate, start_datetime: startDatetime })
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
