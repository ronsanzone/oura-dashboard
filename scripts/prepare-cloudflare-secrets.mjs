import { randomBytes } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"

const source = resolve(process.argv[2] ?? ".env")
const target = resolve(process.argv[3] ?? ".wrangler/production-secrets.json")
const parsed = Object.fromEntries(
  readFileSync(source, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim() && !line.trim().startsWith("#"))
    .map((line) => {
      const index = line.indexOf("=")
      return [line.slice(0, index).trim(), line.slice(index + 1).trim()]
    })
)

for (const key of ["OURA_CLIENT_ID", "OURA_CLIENT_SECRET"]) {
  if (!parsed[key]) throw new Error(`${key} is missing from ${source}`)
}

const existing = existsSync(target)
  ? JSON.parse(readFileSync(target, "utf8"))
  : {}
const stableSecret = (key, create) => {
  const value = existing[key] ?? parsed[key]
  return typeof value === "string" && value ? value : create()
}

const secrets = {
  OURA_CLIENT_ID: parsed.OURA_CLIENT_ID,
  OURA_CLIENT_SECRET: parsed.OURA_CLIENT_SECRET,
  OURA_TOKEN_ENCRYPTION_KEY: stableSecret("OURA_TOKEN_ENCRYPTION_KEY", () => randomBytes(32).toString("base64")),
  OURA_WEBHOOK_VERIFICATION_TOKEN: stableSecret("OURA_WEBHOOK_VERIFICATION_TOKEN", () => randomBytes(32).toString("base64url"))
}
mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
writeFileSync(target, `${JSON.stringify(secrets)}\n`, { mode: 0o600 })
chmodSync(target, 0o600)
process.stdout.write(`Prepared stable mode-0600 payload containing: ${Object.keys(secrets).join(", ")}\n`)
