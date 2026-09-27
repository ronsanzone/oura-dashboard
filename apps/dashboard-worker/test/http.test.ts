import { describe, expect, it } from "vitest"
import { errorResponse, HttpError, json, readBoundedText } from "../src/http.js"
import { requireSameOrigin, secureResponse } from "../src/security.js"
import worker from "../src/index.js"
import type { AppEnv } from "../src/types.js"

describe("HTTP responses", () => {
  it("only caches successful fingerprinted assets immutably and revalidates HTML", async () => {
    const assetRequests: string[] = []
    const env = {
      DEPLOYMENT_MODE: "local",
      DASHBOARD_HOSTNAME: "localhost",
      WEBHOOK_HOSTNAME: "oura-hooks.localhost",
      ASSETS: {
        fetch: async (request: Request) => {
          const pathname = new URL(request.url).pathname
          assetRequests.push(pathname)
          return new Response(pathname === "/index.html" ? "<main>Dashboard</main>" : "asset", {
            status: pathname === "/assets/missing-abcdefgh.js" ? 404 : 200,
            headers: { "cache-control": "public, max-age=14400" }
          })
        }
      }
    } as unknown as AppEnv
    const fetch = (path: string) => worker.fetch(new Request(`http://localhost${path}`), env, {} as ExecutionContext)

    expect((await fetch("/")).headers.get("cache-control")).toBe("no-cache")
    expect((await fetch("/sleep")).headers.get("cache-control")).toBe("no-cache")
    expect((await fetch("/index.html")).headers.get("cache-control")).toBe("no-cache")
    expect((await fetch("/favicon.svg")).headers.get("cache-control")).toBe("no-cache")
    expect((await fetch("/assets/index-Ab12_cd3.js")).headers.get("cache-control")).toBe("public, max-age=31536000, immutable")
    expect((await fetch("/assets/runtime.js")).headers.get("cache-control")).toBe("no-cache")
    expect((await fetch("/downloads/index-Ab12_cd3.js")).headers.get("cache-control")).toBe("no-cache")
    expect((await fetch("/assets/missing-abcdefgh.js")).headers.get("cache-control")).toBe("no-cache")
    expect(assetRequests.slice(0, 3)).toEqual(["/index.html", "/index.html", "/index.html"])
  })

  it("keeps API errors out of caches", async () => {
    const env = { DEPLOYMENT_MODE: "local", DASHBOARD_HOSTNAME: "localhost", WEBHOOK_HOSTNAME: "oura-hooks.localhost" } as unknown as AppEnv
    const response = await worker.fetch(new Request("http://localhost/api/not-found"), env, {} as ExecutionContext)
    expect(response.status).toBe(404)
    expect(response.headers.get("cache-control")).toBe("no-store")
  })

  it("protects production UI and read APIs before touching storage", async () => {
    const env = { DEPLOYMENT_MODE: "production", DASHBOARD_HOSTNAME: "oura.example" } as unknown as AppEnv
    for (const path of ["/", "/api/status", "/api/records", "/api/daily-summaries?start=2026-09-01&end=2026-09-02", "/api/days/2026-09-02"]) {
      const response = await worker.fetch(new Request(`https://oura.example${path}`), env, {} as ExecutionContext)
      expect(response.status).toBe(403)
      expect(await response.json()).toMatchObject({ error: "access_denied" })
    }
  })

  it("validates summary ranges, selected days and opaque record cursors before querying D1", async () => {
    const env = { DEPLOYMENT_MODE: "local" } as unknown as AppEnv
    const cases = [
      ["/api/daily-summaries", "missing_date_range"],
      ["/api/daily-summaries?start=2026-09-03&end=2026-09-01", "invalid_date_range"],
      ["/api/days/2026-13-40", "invalid_date"],
      ["/api/records?cursor=not-a-cursor", "invalid_cursor"]
    ]
    for (const [path, error] of cases) {
      const response = await worker.fetch(new Request(`http://localhost${path}`), env, {} as ExecutionContext)
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({ error })
    }
  })

  it("returns private JSON with security headers", async () => {
    const response = json({ ok: true })
    expect(response.headers.get("content-type")).toContain("application/json")
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(await response.json()).toEqual({ ok: true })
  })

  it("uses the stable error envelope", async () => {
    const response = errorResponse(400, "invalid", "Invalid input")
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: "invalid", message: "Invalid input" })
  })

  it("rejects a body that exceeds its byte limit", async () => {
    const request = new Request("https://oura.example/api/sync", { method: "POST", body: "12345" })
    await expect(readBoundedText(request, 4)).rejects.toMatchObject({ status: 413, code: "payload_too_large" })
  })

  it("requires an exact same-origin mutation", () => {
    expect(() => requireSameOrigin(new Request("https://oura.example/api/sync", {
      method: "POST",
      headers: { origin: "https://attacker.example" }
    }))).toThrow(HttpError)
    expect(() => requireSameOrigin(new Request("https://oura.example/api/sync", {
      method: "POST",
      headers: { origin: "https://oura.example" }
    }))).not.toThrow()
  })

  it("adds browser isolation and transport headers", () => {
    const response = secureResponse(new Response("ok"), { dashboard: true, https: true })
    expect(response.headers.get("strict-transport-security")).toContain("max-age=")
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'")
    expect(response.headers.get("permissions-policy")).toContain("camera=()")
    expect(response.headers.get("x-frame-options")).toBe("DENY")
  })
})
