import { DatabaseSync } from "node:sqlite"
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"

const source = resolve(process.argv[2] ?? "data/oura.db")
const target = resolve(process.argv[3] ?? ".wrangler/oura-records.import.sql")
const database = new DatabaseSync(source, { readOnly: true })
const rows = database.prepare(`
  SELECT data_type, record_id, record_date, start_datetime,
         end_datetime, payload_json, synced_at
  FROM records
  ORDER BY data_type, record_date, start_datetime
`).all()

const sql = (value) => value === null || value === undefined
  ? "NULL"
  : `'${String(value).replaceAll("'", "''")}'`

const statements = rows.map((row) => `INSERT INTO records (
  data_type, record_id, record_date, start_datetime, end_datetime, payload_json, synced_at
) VALUES (${sql(row.data_type)}, ${sql(row.record_id)}, ${sql(row.record_date)}, ${sql(row.start_datetime)}, ${sql(row.end_datetime)}, ${sql(row.payload_json)}, ${sql(row.synced_at)})
ON CONFLICT(data_type, record_id) DO UPDATE SET
  record_date = excluded.record_date,
  start_datetime = excluded.start_datetime,
  end_datetime = excluded.end_datetime,
  payload_json = excluded.payload_json,
  synced_at = excluded.synced_at;`)

mkdirSync(dirname(target), { recursive: true })
writeFileSync(target, `${statements.join("\n\n")}\n`, { mode: 0o600 })
process.stdout.write(`Prepared ${rows.length} records for D1 at ${target}\n`)
