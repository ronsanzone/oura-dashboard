import type { DailySummariesResponse, ObservatoryStatus, OuraRecord, RecordsPage, SelectedDayResponse } from "@oura/shared"

export type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

async function responseJson<T>(response: Response, message: string): Promise<T> {
  if (!response.ok) throw new Error(message)
  return await response.json() as T
}

export const loadStatus = async (fetcher: Fetcher, signal?: AbortSignal): Promise<ObservatoryStatus> =>
  responseJson<ObservatoryStatus>(await fetcher("/api/status", { signal }), "Unable to load connection and coverage status.")

export const loadDailySummaries = async (
  fetcher: Fetcher,
  start: string,
  end: string,
  signal?: AbortSignal
): Promise<DailySummariesResponse> => {
  const params = new URLSearchParams({ start, end })
  const result = await responseJson<DailySummariesResponse>(
    await fetcher(`/api/daily-summaries?${params}`, { signal }),
    "Daily history could not be loaded. No partial charts are shown."
  )
  if (!result || !Array.isArray(result.days)) throw new Error("Daily history response was invalid. No partial charts are shown.")
  return result
}

export const loadSelectedDay = async (
  fetcher: Fetcher,
  day: string,
  signal?: AbortSignal
): Promise<SelectedDayResponse> => {
  const result = await responseJson<SelectedDayResponse>(
    await fetcher(`/api/days/${encodeURIComponent(day)}`, { signal }),
    "Selected-day detail is unavailable."
  )
  if (!result || result.day !== day || !Array.isArray(result.records)) throw new Error("Selected-day detail response was invalid.")
  return result
}

export const loadCompleteHistory = async (
  fetcher: Fetcher,
  start: string,
  end: string,
  signal?: AbortSignal
): Promise<OuraRecord[]> => {
  const all: OuraRecord[] = []
  const seen = new Set<string>()
  let cursor: string | null = null
  do {
    const params = new URLSearchParams({ start, end })
    if (cursor) params.set("cursor", cursor)
    const page = await responseJson<RecordsPage>(
      await fetcher(`/api/records?${params}`, { signal }),
      "Complete record history could not be loaded. No partial record list is shown."
    )
    if (!page || !Array.isArray(page.records) || (page.nextCursor !== null && typeof page.nextCursor !== "string")) {
      throw new Error("Record history response was invalid. No partial record list is shown.")
    }
    all.push(...page.records)
    cursor = page.nextCursor
    if (cursor && seen.has(cursor)) throw new Error("Record history cursor repeated. No partial record list is shown.")
    if (cursor) seen.add(cursor)
  } while (cursor !== null)
  return all
}
