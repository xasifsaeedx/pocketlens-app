// Theme-aware Recharts tooltip styling. A raw <Tooltip> renders a hard-coded white
// box that becomes unreadable in dark mode; these shared style objects re-skin it with
// the popover tokens so the tooltip matches the surrounding surface in both themes.
//
// Usage on every Recharts <Tooltip>:
//   <Tooltip
//     contentStyle={chartTooltipStyle}
//     itemStyle={chartTooltipItemStyle}
//     labelStyle={chartTooltipLabelStyle}
//   />

import type { CSSProperties } from 'react'

/** Outer tooltip container: popover surface, 1px border, rounded, subtle elevation. */
export const chartTooltipStyle: CSSProperties = {
  background: 'hsl(var(--popover))',
  border: '1px solid hsl(var(--border))',
  color: 'hsl(var(--popover-foreground))',
  borderRadius: 10,
  padding: '8px 12px',
  boxShadow: 'var(--shadow-overlay)',
}

/** Per-series rows inside the tooltip (value lines). */
export const chartTooltipItemStyle: CSSProperties = {
  color: 'hsl(var(--popover-foreground))',
  padding: 0,
}

/** The tooltip label (usually the x-axis value / date). */
export const chartTooltipLabelStyle: CSSProperties = {
  color: 'hsl(var(--muted-foreground))',
  marginBottom: 4,
  fontWeight: 600,
}
