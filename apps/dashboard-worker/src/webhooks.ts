import type { AppEnv } from "./types.js"

const API_URL = "https://api.ouraring.com/v2/webhook/subscription"
const CALLBACK_URL = "https://oura-hooks.ronsanzone.dev/oura-webhook"
const renewalWindowMs = 14 * 24 * 60 * 60 * 1000

export const webhookDataTypeToRecordType: Record<string, string> = {
  daily_activity: "daily_activity",
  daily_sleep: "daily_sleep",
  daily_readiness: "daily_readiness",
  sleep: "sleep",
  workout: "workout",
  session: "session",
  enhanced_tag: "tag",
  daily_spo2: "daily_spo2",
  daily_stress: "daily_stress",
  daily_resilience: "daily_resilience",
  daily_cardiovascular_age: "cardiovascular_age",
  vo2_max: "vo2_max"
}

const eventTypes = ["create", "update", "delete"] as const

type Subscription = {
  id: string
  callback_url: string
  event_type: string
  data_type: string
  expiration_time: string
}

const credentials = (env: AppEnv): HeadersInit => {
  if (!env.OURA_CLIENT_ID || !env.OURA_CLIENT_SECRET) throw new Error("Oura webhook client credentials are not configured")
  return {
    "content-type": "application/json",
    "x-client-id": env.OURA_CLIENT_ID,
    "x-client-secret": env.OURA_CLIENT_SECRET
  }
}

const checked = async <T>(response: Response): Promise<T> => {
  if (!response.ok) throw new Error(`Oura webhook API returned HTTP ${response.status}`)
  return response.json<T>()
}

export const reconcileOuraWebhooks = async (env: AppEnv): Promise<{ created: number; renewed: number; active: number }> => {
  if (!env.OURA_WEBHOOK_VERIFICATION_TOKEN) throw new Error("Oura webhook verification token is not configured")
  const headers = credentials(env)
  const subscriptions = await checked<Subscription[]>(await fetch(API_URL, { headers }))
  let created = 0
  let renewed = 0
  let active = 0

  for (const dataType of Object.keys(webhookDataTypeToRecordType)) {
    for (const eventType of eventTypes) {
      const existing = subscriptions.find((subscription) =>
        subscription.callback_url === CALLBACK_URL &&
        subscription.data_type === dataType &&
        subscription.event_type === eventType)
      if (!existing) {
        await checked<Subscription>(await fetch(API_URL, {
          method: "POST",
          headers,
          body: JSON.stringify({
            callback_url: CALLBACK_URL,
            verification_token: env.OURA_WEBHOOK_VERIFICATION_TOKEN,
            event_type: eventType,
            data_type: dataType
          })
        }))
        created += 1
        continue
      }
      if (new Date(existing.expiration_time).getTime() - Date.now() <= renewalWindowMs) {
        await checked<Subscription>(await fetch(`${API_URL}/renew/${existing.id}`, { method: "PUT", headers }))
        renewed += 1
      } else {
        active += 1
      }
    }
  }
  return { created, renewed, active }
}
