import ReactEChartsCore from "echarts-for-react/lib/core"
import * as echarts from "echarts/core"
import { BarChart, LineChart, ScatterChart } from "echarts/charts"
import { AriaComponent, GraphicComponent, GridComponent, MarkLineComponent, TooltipComponent } from "echarts/components"
import { CanvasRenderer } from "echarts/renderers"

echarts.use([
  AriaComponent,
  BarChart,
  CanvasRenderer,
  GraphicComponent,
  GridComponent,
  LineChart,
  MarkLineComponent,
  ScatterChart,
  TooltipComponent
])

type ChartProps = {
  option: object
  height?: number
  onEvents?: Record<string, (event: { value?: [number, number | null] }) => void>
}

export function Chart({ option, height = 240, onEvents }: ChartProps) {
  return <ReactEChartsCore
    echarts={echarts}
    option={{ ...option, aria: { enabled: true } }}
    style={{ height }}
    opts={{ renderer: "canvas" }}
    notMerge
    onEvents={onEvents}
  />
}
