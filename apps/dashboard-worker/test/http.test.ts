import { describe, expect, it } from "vitest"
import { errorResponse, json } from "../src/http.js"

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
})
