import { describe, expect, it, vi } from "vitest"
import { createHash } from "node:crypto"
import worker from "../src/index.js"
import type { AppEnv } from "../src/types.js"

function setup() {
  const run = vi.fn(async (_model: string, input: { questions: Record<string, unknown> }) => ({
    state: "Completed", result: {
      model: "jev-1.13.0", usage: { input_tokens: 2345, output_tokens: 201 },
      answers: Object.fromEntries(Object.keys(input.questions).map(id => [id, {
        type: "choice", choice: id === "evening_work" ? "present" : "unknown", confidence: 0.9,
        probabilities: id === "evening_work" ? { present: 0.925, absent: 0.025, unknown: 0.025, conflicting: 0.025 }
          : { present: 0.025, absent: 0.025, unknown: 0.925, conflicting: 0.025 }
      }]))
    }
  }))
  const limit = vi.fn(async () => ({ success: true }))
  const stored = vi.fn(async () => ({ meta: { changes: 1 } }))
  const env = { DEPLOYMENT_MODE: "local", JEV_ENABLED: "true", AI: { run }, JEV_RATE_LIMITER: { limit }, DB: { prepare: () => ({ bind: () => ({ run: stored }) }) } } as unknown as AppEnv
  const request = (body: unknown = { note: "Worked after dinner.", consent: true }, options: { method?: string; origin?: string; host?: string } = {}) => {
    const url = `https://${options.host ?? "oura.test"}/api/jev/classify`
    const method = options.method ?? "POST"
    return worker.fetch(new Request(url, { method,
      headers: { origin: options.origin ?? new URL(url).origin, "content-type": "application/json" },
      ...(method === "GET" ? {} : { body: JSON.stringify(body) }) }), env, {} as ExecutionContext)
  }
  return { env, run, limit, request }
}

describe("Jev classification boundary (provider mocked, not an accuracy test)", () => {
  it("sends only submitted text and fixed questions, preserves unknowns and returns validated provenance", async () => {
    const { request, run } = setup()
    const response = await request()
    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("no-store")
    const body = await response.json() as Record<string, any>
    expect(run).toHaveBeenCalledTimes(1)
    expect(run.mock.calls[0]?.[0]).toBe("typesafe/jev")
    expect(run.mock.calls[0]?.[1]).toMatchObject({ state: { note: "Worked after dinner." } })
    expect(body).toMatchObject({ model: "jev-1.13.0", rubricVersion: "context-2", reviewRequired: true,
      answers: { evening_work: { choice: "present" }, zepbound: { choice: "unknown" } },
      usage: { input_tokens: 2345, output_tokens: 201 } })
    expect(body.estimatedInputCostUsd).toBeCloseTo(0.00009849, 10)
    expect(body.sourceHash).toBe(createHash("sha256").update(JSON.stringify({ note: "Worked after dinner.", responses: {} })).digest("base64"))
    expect(body.input).toEqual({ note: "Worked after dinner.", responses: {} })
    expect(body.debug).toEqual({ model: "typesafe/jev", input: run.mock.calls[0]![1] })
    expect(Object.keys(body.answers)).toHaveLength(12)
    expect(body.answers).not.toHaveProperty("alcohol")
  })

  it("rejects absent consent, unexpected fields, oversized and empty notes before inference", async () => {
    const { request, run } = setup()
    for (const body of [{ note: "hello" }, { note: "hello", consent: "true" },
      { note: "hello", consent: true, outcomes: { stress: 2 } },
      { note: " ", consent: true }, { note: "x".repeat(4001), consent: true }, null]) {
      expect((await request(body)).status).toBe(400)
    }
    expect((await request({ note: "界".repeat(4000), consent: true })).status).toBe(413)
    expect(run).not.toHaveBeenCalled()
  })

  it("enforces method, same-origin, kill switch, rate limit, Access and webhook separation", async () => {
    const { env, request, run, limit } = setup()
    expect((await request(undefined, { method: "GET" })).status).toBe(405)
    expect((await request(undefined, { origin: "https://evil.test" })).status).toBe(403)
    env.JEV_ENABLED = "false"
    expect((await request()).status).toBe(503)
    env.JEV_ENABLED = "true"
    limit.mockResolvedValue({ success: false })
    expect((await request()).status).toBe(429)
    env.DEPLOYMENT_MODE = "production"
    env.DASHBOARD_HOSTNAME = "oura.ronsanzone.dev"
    env.WEBHOOK_HOSTNAME = "oura-hooks.ronsanzone.dev"
    expect((await request(undefined, { host: env.DASHBOARD_HOSTNAME })).status).toBe(403)
    expect((await request(undefined, { host: env.WEBHOOK_HOSTNAME })).status).toBe(404)
    expect(run).not.toHaveBeenCalled()
  })

  it("does not expose provider exceptions or retry them", async () => {
    const { request, run } = setup()
    run.mockRejectedValue(new Error("sensitive provider input"))
    const response = await request()
    expect(response.status).toBe(502)
    expect(await response.text()).not.toContain("sensitive")
    expect(run).toHaveBeenCalledTimes(1)
  })

  it("rejects missing answers, invalid probabilities, and invalid usage instead of publishing them", async () => {
    for (const mutate of [
      (r: any) => { r.state = "Running" },
      (r: any) => { delete r.result },
      (r: any) => { delete r.result.answers.zepbound },
      (r: any) => { r.result.answers.caffeine.probabilities.unknown = 2 },
      (r: any) => { r.result.answers.caffeine.choice = "diagnosis" },
      (r: any) => { r.result.usage.input_tokens = -1 }
    ]) {
      const { request, run } = setup()
      const original = run.getMockImplementation()!
      run.mockImplementation(async (...args) => { const result = await original(...args); mutate(result); return result })
      const response = await request()
      expect(response.status).toBe(502)
      expect(await response.json()).toMatchObject({ error: "invalid_jev_response" })
    }
  })
})
