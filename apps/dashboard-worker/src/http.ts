export const json = (body: unknown, init: ResponseInit = {}): Response => {
  const headers = new Headers(init.headers)
  headers.set("content-type", "application/json; charset=utf-8")
  headers.set("cache-control", "no-store")
  headers.set("x-content-type-options", "nosniff")
  return new Response(JSON.stringify(body), { ...init, headers })
}

export const errorResponse = (status: number, code: string, message: string): Response =>
  json({ error: code, message }, { status })

export class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
  }
}
