export interface Env {
  DB: D1Database
  ASSETS: Fetcher
  DEPLOYMENT_MODE: string
  OURA_REDIRECT_URI: string
  OURA_CLIENT_ID?: string
  OURA_CLIENT_SECRET?: string
  OURA_TOKEN_ENCRYPTION_KEY?: string
  OURA_WEBHOOK_VERIFICATION_TOKEN?: string
}

export type StoredTokens = {
  accessToken: string
  refreshToken: string
  expiresAt: string | null
  scope: string | null
}
