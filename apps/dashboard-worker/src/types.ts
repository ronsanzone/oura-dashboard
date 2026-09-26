export type AppEnv = Omit<Env, "JEV_ENABLED"> & {
  JEV_ENABLED: string
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
