import { useState } from "react"
import { mainSleep, type DailyPoint, type RecordIndex } from "@oura/shared"
import { Chart } from "./Chart"
import { base, clock, Empty, fmt, muted, num, palette, Panel, samples, startTime, Timeline, Trend } from "./Dashboard"

export function SleepView({ points, history, index, day }: { points: DailyPoint[]; history: DailyPoint[]; index: RecordIndex; day: string }) {
  const sleeps = index.byDayAndType.get(day)?.get("sleep") ?? []
  const main = mainSleep(sleeps)
  const [selected, setSelected] = useState("")
  const sleep = sleeps.find((record) => record.record_id === selected) ?? main
  const p = sleep?.payload
  const total = sleeps.length && sleeps.every((record) => num(record.payload.total_sleep_duration) !== undefined) ? sleeps.reduce((sum, record) => sum + Number(record.payload.total_sleep_duration), 0) / 3600 : undefined
  const stages = [["Deep", p?.deep_sleep_duration], ["REM", p?.rem_sleep_duration], ["Light", p?.light_sleep_duration], ["Awake", p?.awake_time]]
  return <div className="dashboard-grid"><Panel title="One night, not one score." meta={day} wide>
    <div className="sleep-summary"><label>Sleep episode<select value={sleep?.record_id ?? ""} onChange={(event) => setSelected(event.target.value)}>{!sleeps.length && <option>No sleep for this date</option>}{sleeps.map((record) => <option key={record.record_id} value={record.record_id}>{record === main ? "Main sleep (longest)" : "Additional sleep / nap"} · {clock(startTime(record))} · {fmt(Number(record.payload.total_sleep_duration) / 3600)} h</option>)}</select></label><div><strong>{fmt(total)} h</strong><span>Total across {sleeps.length} episodes</span></div><div><strong>{fmt(num(p?.total_sleep_duration) === undefined ? undefined : Number(p?.total_sleep_duration) / 3600)} h</strong><span>Selected episode · asleep</span></div></div>
    <div className="stage-summary">{stages.map(([label, value], index) => <div key={String(label)} style={{ borderColor: palette[index] }}><span>{String(label)}</span><b>{num(value) === undefined ? "Not measured" : `${fmt(Number(value) / 3600)} h`}</b></div>)}</div>
    <p className="caption">Daily trends and the brief use the longest episode; total daily sleep includes naps. No proprietary sleep-debt estimate is inferred.</p>
  </Panel>
    <Trend points={points} history={history} metric="totalSleepHours" title="Main sleep duration" unit="h" />
    <Trend points={points} history={history} metric="sleepEfficiency" title="Sleep efficiency" unit="%" color={palette[1]} />
    <Trend points={points} history={history} metric="sleepScore" title="Sleep score" unit="/ 100" color={palette[2]} />
    <Panel title="Selected episode physiology" meta="SOURCE SAMPLES">
      {([['heart_rate', 'Heart rate', 'bpm'], ['hrv', 'HRV', 'ms']] as const).map(([key, title, unit], index) => {
        const data = samples(p?.[key])
        return <div key={key}><p className="caption">{title} · {unit}</p>{data.some(([, value]) => value !== null) ? <Chart height={140} option={{ ...base, xAxis: { ...base.xAxis, type: "time", axisLabel: { color: muted, formatter: (value: number) => clock(value) } }, yAxis: { ...base.yAxis, scale: true }, series: [{ name: `${title} · ${unit}`, type: "line", data, showSymbol: false, connectNulls: false, lineStyle: { color: palette[index] } }] }} /> : <Empty>No {title.toLowerCase()} samples for this episode.</Empty>}</div>
      })}
    </Panel>
    <Panel title="Bed & wake rhythm" meta="EASTERN TIME" wide><div className="rhythm">{points.slice(-14).map((point) => {
      const sleep = mainSleep(index.byDayAndType.get(point.day)?.get("sleep") ?? [])
      return <div key={point.day}><span>{point.day.slice(5)}</span><b>{sleep ? clock(startTime(sleep)) : "—"}</b><span>→</span><b>{sleep?.end_datetime || sleep?.payload.bedtime_end ? clock(String(sleep.end_datetime ?? sleep.payload.bedtime_end)) : "—"}</b></div>
    })}</div><p className="caption">Last 14 days · main sleep only. Times preserve the source instant; no invented bedtime recommendations.</p></Panel>
    <div className="wide"><Timeline index={index} day={day} /></div>
  </div>
}
