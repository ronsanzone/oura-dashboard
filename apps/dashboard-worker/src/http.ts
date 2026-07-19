export const json = (body: unknown, init: ResponseInit = {}): Response => {
  const headers = new Headers(init.headers)
  headers.set("content-type", "application/json; charset=utf-8")
  headers.set("cache-control", "no-store")
  headers.set("x-content-type-options", "nosniff")
  return new Response(JSON.stringify(body), { ...init, headers })
}

export const errorResponse = (status: number, code: string, message: string): Response =>
  json({ error: code, message }, { status })

export const readBoundedText = async (request: Request, maxBytes: number): Promise<string> => {
  const declaredLength = request.headers.get("content-length")
  if (declaredLength && Number(declaredLength) > maxBytes) {
    throw new HttpError(413, "payload_too_large", "Request body is too large")
  }
  if (!request.body) return ""

  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel()
      throw new HttpError(413, "payload_too_large", "Request body is too large")
    }
    chunks.push(value)
  }

  const body = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(body)
  } catch {
    throw new HttpError(400, "invalid_encoding", "Request body must be valid UTF-8")
  }
}

export class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
  }
}
