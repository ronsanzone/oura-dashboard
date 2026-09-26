import { useSyncExternalStore } from "react"

type Call = { id: number; at: string; request: unknown; status: number | null; duration?: number; response?: unknown; error?: string }
let calls: Call[] = [], sequence = 0
const listeners = new Set<() => void>()
const emit = () => listeners.forEach(listener => listener())
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
const snapshot = () => calls

// Session-memory only. Never capture headers, cookies, or provider exceptions.
export function traceJev(request: unknown) {
  const id = ++sequence, start = performance.now()
  calls = [{ id, at: new Date().toISOString(), request, status: null }, ...calls].slice(0, 10)
  emit()
  return (status: number | null, response?: unknown, error?: string) => {
    calls = calls.map(call => call.id === id ? { ...call, status, response, error, duration: Math.round(performance.now() - start) } : call)
    emit() // Cleared/evicted calls are deliberately not restored on completion.
  }
}

export function JevDebug() {
  const entries = useSyncExternalStore(subscribe, snapshot)
  return <details className="jev-debug panel">
    <summary>Jev debug · {entries.length} recent calls</summary>
    <p>Behind the scenes · POST /api/jev/classify → Cloudflare Workers AI → typesafe/jev</p>
    <p className="caption">Private notes and answers are visible below. Last 10 calls from this tab, in memory only; reload or Clear removes this log, not saved notebook records. Opening this panel makes no API calls. Credentials and headers are never captured.</p>
    <button onClick={() => { calls = []; emit() }} disabled={!entries.length}>Clear debug log</button>
    {!entries.length && <p>No calls yet in this session. Use Daily Debrief or Experiment Concierge to see a real request here.</p>}
    {entries.map(call => <details key={call.id} className="context-source">
      <summary>#{call.id} · {new Date(call.at).toLocaleTimeString()} · {call.duration === undefined ? "Pending…" : call.status ? `HTTP ${call.status} · ${call.duration} ms` : `Network/read error · ${call.duration} ms`}</summary>
      <h3>Browser request</h3><pre>{JSON.stringify(call.request, null, 2)}</pre>
      {call.response !== undefined && <><h3>Application response</h3><p className="caption">Successful responses include the exact model/question payload sent through the AI binding and validated answers, probabilities, model/rubric, token usage and estimated input cost. This is not raw provider HTTP traffic. Provider failures are sanitized; no automatic retry occurs.</p><pre>{JSON.stringify(call.response, null, 2)}</pre></>}
      {call.error && <p role="status">{call.error}</p>}
    </details>)}
  </details>
}
