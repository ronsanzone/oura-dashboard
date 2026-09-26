import { afterEach, describe, expect, it, vi } from "vitest"
import { collection } from "../src/oura.js"
import type { AppEnv } from "../src/types.js"
import * as storage from "../src/storage.js"

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })
describe("Oura collection windows", () => {
  it("chunks long HR history and carries rotated tokens into later collections", async () => {
    vi.spyOn(storage, "storeTokens").mockResolvedValue()
    const requests: { url: URL; auth?: string }[] = []
    let refreshed = false
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith("/oauth/token")) {
        expect(String(init.body)).toContain("refresh_token=old-refresh")
        refreshed = true
        return Response.json({ access_token: "new-access", refresh_token: "new-refresh" })
      }
      const auth = (init.headers as Record<string, string>).authorization
      requests.push({ url: new URL(url), auth })
      if (!refreshed) return new Response("expired", { status: 401 })
      expect(auth).toBe("Bearer new-access")
      return Response.json({ data: [{ bpm: 60 }] })
    }))
    const tokens = { accessToken: "old-access", refreshToken: "old-refresh", expiresAt: null, scope: null }
    const env = { OURA_CLIENT_ID: "test", OURA_CLIENT_SECRET: "test" } as AppEnv
    expect(await collection(env, "heartrate", "2026-09-01", "2026-09-29", tokens)).toHaveLength(2)
    await collection(env, "daily_sleep", "2026-09-01", "2026-09-29", tokens)
    expect(requests[1]?.url.searchParams.get("end_datetime")).toBe("2026-09-29T04:00:00.000Z")
    expect(requests[2]?.url.searchParams.get("start_datetime")).toBe("2026-09-29T04:00:00.000Z")
    expect(requests[2]?.url.searchParams.get("end_datetime")).toBe("2026-09-30T04:00:00.000Z")
    expect(tokens.refreshToken).toBe("new-refresh")
  })

  it("uses datetime parameters for HR and preserves the window across pages", async () => {
    const urls: URL[] = []
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      urls.push(new URL(url))
      return Response.json(urls.length === 1 ? { data: [{ bpm: 51 }], next_token: "page-two" } : { data: [{ bpm: 77 }] })
    }))
    const result = await collection({} as AppEnv, "heartrate", "2026-03-08", "2026-03-08", { accessToken: "test", refreshToken: "test", expiresAt: null, scope: null })
    expect(result).toEqual([{ bpm: 51 }, { bpm: 77 }])
    for (const url of urls) {
      expect(url.searchParams.get("start_datetime")).toBe("2026-03-08T05:00:00.000Z")
      expect(url.searchParams.get("end_datetime")).toBe("2026-03-09T04:00:00.000Z")
      expect(url.searchParams.has("start_date")).toBe(false)
    }
    expect(urls[1]?.searchParams.get("next_token")).toBe("page-two")
  })
  it("keeps day parameters for daily collections", async () => {
    const fetcher = vi.fn(async () => Response.json({ data: [] }))
    vi.stubGlobal("fetch", fetcher)
    await collection({} as AppEnv, "daily_sleep", "2026-09-20", "2026-09-26", { accessToken: "test", refreshToken: "test", expiresAt: null, scope: null })
    expect(fetcher).toHaveBeenCalledWith("https://api.ouraring.com/v2/usercollection/daily_sleep?start_date=2026-09-20&end_date=2026-09-26", expect.anything())
  })
})
