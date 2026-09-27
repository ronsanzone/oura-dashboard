export function TimelineSkeleton() {
  return <section className="panel timeline timeline-skeleton" aria-busy="true" aria-label="Loading selected-day detail">
    <header className="panel-head"><div><span className="eyebrow">THE BODY TIMELINE</span><h2>Your day, in its own rhythm.</h2></div><div className="skeleton-block skeleton-toggle" /></header>
    <div className="skeleton-block skeleton-line" />
    <div className="skeleton-block skeleton-chart" />
    <div className="skeleton-block skeleton-control" />
    <div className="skeleton-block skeleton-moment" />
    <p className="caption" role="status">Loading measured samples and logged context for this day…</p>
  </section>
}

export function DashboardSkeleton({ today = false }: { today?: boolean }) {
  return <div className="dashboard-skeleton" aria-busy="true" aria-label="Loading daily summaries">
    {today && <>
      <section className="brief skeleton-brief"><div><span className="eyebrow">YOUR MORNING BRIEF</span><div className="skeleton-block skeleton-heading" /><div className="skeleton-block skeleton-copy" /></div><div className="skeleton-block skeleton-next" /></section>
      <div className="brief-metrics">{[0, 1, 2].map((index) => <article className="metric skeleton-metric" key={index}><div className="skeleton-block skeleton-line" /><div className="skeleton-block skeleton-value" /><div className="skeleton-block skeleton-copy" /></article>)}</div>
      <TimelineSkeleton />
    </>}
    <div className="dashboard-grid">{[0, 1].map((index) => <section className="panel skeleton-panel" key={index}><div className="skeleton-block skeleton-line" /><div className="skeleton-block skeleton-value" /><div className="skeleton-block skeleton-chart" /></section>)}</div>
    <span className="sr-only" role="status">Loading daily summaries…</span>
  </div>
}
