// Reusable area-trend primitive: a gradient-filled area chart with rounded caps, the
// shared theme-aware Recharts tooltip, an optional draw-in animation, optional axes, and
// an optional hero readout slot. One place to tune how every net-worth / balance trend
// area looks so InlineNetWorthTrend and AccountsPage stay in sync.

import type { ReactNode } from 'react'
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import {
  chartTooltipItemStyle,
  chartTooltipLabelStyle,
  chartTooltipStyle,
} from '@/lib/chartTooltip'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Point = Record<string, any>

type TrendAreaChartProps = {
  /** Rows to plot. */
  data: Point[]
  /** Key on each row holding the numeric value drawn as the area. */
  yKey: string
  /** Key used for the x-axis category (only rendered when `showAxes`). */
  xKey?: string
  /** Full CSS color for the stroke + gradient base, e.g. "hsl(var(--brand))". */
  color?: string
  /** Unique id for this chart's <linearGradient> (avoid collisions on one page). */
  gradientId: string
  /** Chart height; a number (px) or a CSS string. Defaults to fill the parent. */
  height?: number | string
  /** Render grid + x/y axes (detail view) vs. a bare inline sparkline-style area. */
  showAxes?: boolean
  /** Formats a numeric value for the tooltip (and y-axis ticks when axes show). */
  valueFormatter?: (n: number) => string
  /** Series name shown in the tooltip row. */
  tooltipLabel?: string
  /** Formats the tooltip's heading (usually the date); receives Recharts label+payload. */
  labelFormatter?: (label: unknown, payload: ReadonlyArray<{ payload?: Point }>) => string
  /** Optional big-number readout rendered above the chart. */
  hero?: ReactNode
  /** Extra classes on the outer wrapper. */
  className?: string
  /** Passed to the outer wrapper for screen readers when no hero is provided. */
  ariaLabel?: string
  strokeWidth?: number
  fillFrom?: number
  fillTo?: number
  margin?: { top?: number; right?: number; bottom?: number; left?: number }
  /** Override the y-axis domain, e.g. ['dataMin * 0.9', 'dataMax * 1.05'].
   *  Accepts any value Recharts' YAxis `domain` prop accepts. */
  yDomain?: [number | string, number | string]
  /** Override the x-axis domain to pin the full range, e.g. [1, 31].
   *  Accepts any value Recharts' XAxis `domain` prop accepts. */
  xDomain?: [number | string, number | string]
  /** X-axis scale type. Use 'number' for numeric keys (e.g. day-of-month) and
   *  'category' (default) for string labels like formatted dates. */
  xType?: 'category' | 'number'
}

export function TrendAreaChart({
  data,
  yKey,
  xKey,
  color = 'hsl(var(--brand))',
  gradientId,
  height = '100%',
  showAxes = false,
  valueFormatter = (n) => String(n),
  tooltipLabel,
  labelFormatter,
  hero,
  className,
  ariaLabel,
  strokeWidth = 2.5,
  fillFrom = 0.3,
  fillTo = 0.02,
  margin,
  yDomain,
  xDomain,
  xType = 'category',
}: TrendAreaChartProps) {
  const chart = (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart
        data={data}
        margin={margin ?? (showAxes ? { top: 6, right: 8, bottom: 0, left: 4 } : { top: 6, right: 0, bottom: 0, left: 0 })}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={fillFrom} />
            <stop offset="100%" stopColor={color} stopOpacity={fillTo} />
          </linearGradient>
        </defs>
        {showAxes && (
          <CartesianGrid strokeDasharray="3 3" opacity={0.2} vertical={false} />
        )}
        {xKey && (
          <XAxis
            dataKey={xKey}
            domain={xDomain}
            type={xType}
            fontSize={11}
            tickLine={false}
            axisLine={false}
            tick={showAxes ? undefined : { fontSize: 10, fill: 'hsl(var(--muted-foreground))' }}
            hide={!showAxes && !xDomain}
          />
        )}
        {showAxes ? (
          <YAxis
            domain={yDomain}
            fontSize={11}
            tickLine={false}
            width={80}
            tickFormatter={(v) => valueFormatter(Number(v))}
          />
        ) : yDomain ? (
          // Hidden axis — only sets the scale, renders nothing
          <YAxis domain={yDomain} hide />
        ) : null}
        <Tooltip
          cursor={{ stroke: 'hsl(var(--border))' }}
          contentStyle={chartTooltipStyle}
          itemStyle={chartTooltipItemStyle}
          labelStyle={chartTooltipLabelStyle}
          formatter={(v: number) => [valueFormatter(Number(v)), tooltipLabel ?? '']}
          labelFormatter={labelFormatter}
        />
        <Area
          type="monotone"
          dataKey={yKey}
          stroke={color}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeLinejoin="round"
          fill={`url(#${gradientId})`}
          dot={false}
          animationDuration={600}
          animationEasing="ease-out"
        />
      </AreaChart>
    </ResponsiveContainer>
  )

  if (hero == null && !className && !ariaLabel) return chart

  return (
    <div className={className} role={ariaLabel ? 'img' : undefined} aria-label={ariaLabel}>
      {hero != null && <div className="mb-2">{hero}</div>}
      {chart}
    </div>
  )
}
