import { describe, expect, it, vi } from "vitest"
import { loadCompleteHistory, loadDailySummaries, loadSelectedDay, type Fetcher } from "./data"
import type { OuraRecord } from "@oura/shared"

const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json" }
})
const record = (id: string): OuraRecord => ({
  data_type: "heart_rate", record_id: id, record_date: null,
  start_datetime: "2026-09-20T12:00:00-04:00", end_datetime: null,
  payload: { bpm: 60 }, synced_at: "2026-09-20T16:01:00Z"
})

describe("progressive dashboard data", () => {
  it("publishes compact summaries without waiting for selected-day detail", async () => {
    let releaseDay!: (value: Response) => void
    const dayResponse = new Promise<Response>((resolve) => { releaseDay = resolve })
    const fetcher = vi.fn(((input: RequestInfo | URL) => String(input).startsWith("/api/daily-summaries")
      ? Promise.resolve(response({ days: [{ day: "2026-09-20", steps: 0 }] }))
      : dayResponse) as Fetcher)

    const summariesPromise = loadDailySummaries(fetcher, "2026-09-01", "2026-09-20")
    const detailPromise = loadSelectedDay(fetcher, "2026-09-20")
    let detailSettled = false
    void detailPromise.finally(() => { detailSettled = true })

    await expect(summariesPromise).resolves.toEqual({ days: [{ day: "2026-09-20", steps: 0 }] })
    expect(detailSettled).toBe(false)
    releaseDay(response({ day: "2026-09-20", records: [] }))
    await expect(detailPromise).resolves.toEqual({ day: "2026-09-20", records: [] })
  })

  it("does not resolve complete history until the terminal keyset page arrives", async () => {
    const fetcher = vi.fn<Fetcher>()
      .mockResolvedValueOnce(response({ records: [record("a")], nextCursor: "cursor-1" }))
      .mockResolvedValueOnce(response({ records: [record("b")], nextCursor: null }))

    await expect(loadCompleteHistory(fetcher, "2026-09-01", "2026-09-20")).resolves.toEqual([record("a"), record("b")])
    expect(fetcher).toHaveBeenNthCalledWith(1, "/api/records?start=2026-09-01&end=2026-09-20", { signal: undefined })
    expect(fetcher).toHaveBeenNthCalledWith(2, "/api/records?start=2026-09-01&end=2026-09-20&cursor=cursor-1", { signal: undefined })
  })

  it("rejects a failed or looping page instead of returning partial health history", async () => {
    const failed = vi.fn<Fetcher>()
      .mockResolvedValueOnce(response({ records: [record("a")], nextCursor: "cursor-1" }))
      .mockResolvedValueOnce(response({ message: "failed" }, 500))
    await expect(loadCompleteHistory(failed, "2026-09-01", "2026-09-20")).rejects.toThrow("No partial record list")

    const looping = vi.fn<Fetcher>()
      .mockImplementation(async () => response({ records: [record("a")], nextCursor: "cursor-1" }))
    await expect(loadCompleteHistory(looping, "2026-09-01", "2026-09-20")).rejects.toThrow("cursor repeated")
  })
})
