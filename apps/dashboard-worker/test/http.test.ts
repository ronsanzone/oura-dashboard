import { describe, expect, it } from "vitest"
import { errorResponse, HttpError, json, readBoundedText } from "../src/http.js"
import { requireSameOrigin, secureResponse } from "../src/security.js"

describe("HTTP responses", () => {
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
