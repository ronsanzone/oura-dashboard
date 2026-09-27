import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { DashboardSkeleton, TimelineSkeleton } from "./Loading"

describe("stable loading layout", () => {
  it("reserves the Today brief, metrics, timeline and trend grid", () => {
    const markup = renderToStaticMarkup(<DashboardSkeleton today />)
    expect(markup).toContain("aria-label=\"Loading daily summaries\"")
    expect(markup).toContain("skeleton-brief")
    expect(markup.match(/skeleton-metric/g)).toHaveLength(3)
    expect(markup).toContain("timeline-skeleton")
    expect(markup.match(/skeleton-panel/g)).toHaveLength(2)
  })

  it("keeps selected-day loading distinct from an empty measured day", () => {
    const markup = renderToStaticMarkup(<TimelineSkeleton />)
    expect(markup).toContain("aria-busy=\"true\"")
    expect(markup).toContain("Loading measured samples and logged context for this day")
    expect(markup).not.toContain("No samples available")
  })
})
