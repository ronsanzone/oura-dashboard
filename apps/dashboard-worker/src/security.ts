import { createRemoteJWKSet, jwtVerify } from "jose"
import { HttpError } from "./http.js"
import type { AppEnv } from "./types.js"

const accessHeader = "cf-access-jwt-assertion"

export const requireAccessIdentity = async (request: Request, env: AppEnv): Promise<void> => {
  if (env.DEPLOYMENT_MODE !== "production") return
  const token = request.headers.get(accessHeader)
  if (!token) throw new HttpError(403, "access_denied", "A valid Cloudflare Access identity is required")

  try {
    const keys = createRemoteJWKSet(new URL(`${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`))
    const { payload } = await jwtVerify(token, keys, {
      issuer: env.ACCESS_TEAM_DOMAIN,
      audience: env.ACCESS_AUD
    })
    if (payload.email !== env.ACCESS_ALLOWED_EMAIL) {
      throw new Error("Access identity is not authorized")
    }
  } catch {
    throw new HttpError(403, "access_denied", "A valid Cloudflare Access identity is required")
  }
}

export const requireSameOrigin = (request: Request): void => {
  const origin = request.headers.get("origin")
  if (!origin || origin !== new URL(request.url).origin) {
    throw new HttpError(403, "invalid_origin", "Request origin is not allowed")
  }
}

export const secureResponse = (response: Response, options: { dashboard: boolean; https: boolean }): Response => {
  const headers = new Headers(response.headers)
  headers.set("x-content-type-options", "nosniff")
  headers.set("referrer-policy", "no-referrer")
  if (options.https) headers.set("strict-transport-security", "max-age=31536000")
  if (options.dashboard) {
    headers.set("content-security-policy", [
      "default-src 'self'",
      "base-uri 'none'",
      "frame-ancestors 'none'",
      "object-src 'none'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self'",
      "connect-src 'self'",
      "form-action 'self'"
    ].join("; "))
    headers.set("cross-origin-opener-policy", "same-origin")
    headers.set("cross-origin-resource-policy", "same-origin")
    headers.set("permissions-policy", "camera=(), geolocation=(), microphone=(), payment=(), usb=()")
    headers.set("x-frame-options", "DENY")
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}
