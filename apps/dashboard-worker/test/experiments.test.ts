import { describe, expect, it } from "vitest"
import { DatabaseSync } from "node:sqlite"
import { readFileSync } from "node:fs"
import worker from "../src/index.js"
import type { AppEnv } from "../src/types.js"
import type { Experiment, ExperimentRevision, ExperimentSnapshot } from "@oura/shared/experiments"

const plan: Experiment = { question: "Earlier dinner?", habit: "Finish by 7", primary: "averageHrv", supporting: [], rules: { followed: "by 7", partly: "by 8", not_followed: "later" }, beforeStart: "2026-03-06", beforeEnd: "2026-03-07", start: "2026-03-08", end: "2026-03-10", afterStart: "", afterEnd: "", alignment: 1, state: "active", checkIns: {}, conclusion: "", revisionNote: "Initial" }
function database() {
  const db = new DatabaseSync(":memory:")
  for (const file of ["0001_initial.sql", "0003_experiments.sql"]) db.exec(readFileSync(new URL(`../../../migrations/${file}`, import.meta.url), "utf8"))
  const env = { DEPLOYMENT_MODE: "local", DB: { prepare(sql: string) {
    const statement = db.prepare(sql); let bindings: (string | number | null)[] = []
    return { bind(...v: typeof bindings) { bindings = v; return this }, async all() { return { results: statement.all(...bindings) } }, async first() { return statement.get(...bindings) ?? null }, async run() { return { meta: { changes: Number(statement.run(...bindings).changes) } } } }
  } } } as unknown as AppEnv
  const request = (path = "", body?: unknown, method = "POST", origin = "https://oura.test") => worker.fetch(new Request(`https://oura.test/api/experiments${path}`, body === undefined ? {} : { method, headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body) }), env, {} as ExecutionContext)
  return { db, request }
}
describe("persistent experiment API", () => {
  it("saves revisions, prevents lost updates, freezes snapshots across later imports and notebook edits", async () => {
    const { db, request } = database()
    try {
      const created = await request("", { experiment: plan }); expect(created.status).toBe(201)
      const first = await created.json() as ExperimentRevision
      const add = (hrv: number) => db.prepare("INSERT OR REPLACE INTO records VALUES ('sleep','s','2026-03-09',NULL,NULL,?,'2026-03-11T12:00:00Z')").run(JSON.stringify({ day: "2026-03-09", average_hrv: hrv, total_sleep_duration: 20000 }))
      add(51)
      const snap = await (await request(`/${first.id}/snapshots`, { version: 1 })).json() as ExperimentSnapshot
      expect(snap.evidence.days.find(d => d.day === "2026-03-08")?.values.averageHrv).toBe(51)
      const experiment: Experiment = { ...plan, checkIns: { "2026-03-08": { adherence: "followed", note: "Travel", exclusion: "Travel" } }, revisionNote: "Correct check-in" }
      expect((await request(`/${first.id}`, { version: 1, experiment }, "PUT")).status).toBe(200)
      expect((await request(`/${first.id}`, { version: 1, experiment: plan }, "PUT")).status).toBe(409)
      expect((await request(`/${first.id}/snapshots`, { version: 1 })).status).toBe(409)
      add(99)
      const saved = await (await request(`/${first.id}/snapshots`)).json() as ExperimentSnapshot[]
      expect(saved[0]).toEqual(snap)
      const live = await (await request(`/${first.id}/evidence`)).json() as { evidence: ExperimentSnapshot["evidence"] }
      expect(live.evidence.days.find(d => d.day === "2026-03-08")).toMatchObject({ values: { averageHrv: 99 }, checkIn: { exclusion: "Travel" } })
      const history = await (await request(`/${first.id}/revisions`)).json() as ExperimentRevision[]
      expect(history.map(r => r.version)).toEqual([2, 1]); expect(history[1]?.experiment.checkIns).toEqual({})
      expect((await (await request()).json() as ExperimentRevision[])[0]?.version).toBe(2)
    } finally { db.close() }
  })
  it("protects all routes with Access and rejects cross-origin/invalid writes", async () => {
    const { db, request } = database()
    try {
      expect((await request("", { experiment: plan }, "POST", "https://evil.test")).status).toBe(403)
      expect((await request("", { experiment: { ...plan, beforeEnd: plan.start } })).status).toBe(400)
      expect((await request("", null)).status).toBe(400)
      for (const path of ["", "/id", "/id/evidence", "/id/snapshots", "/id/revisions"]) {
        const response = await worker.fetch(new Request(`https://oura.test/api/experiments${path}`), { DEPLOYMENT_MODE: "production", DASHBOARD_HOSTNAME: "oura.test" } as unknown as AppEnv, {} as ExecutionContext)
        expect(response.status).toBe(403)
      }
      expect((await request()).headers.get("cache-control")).toBe("no-store")
    } finally { db.close() }
  })
})
