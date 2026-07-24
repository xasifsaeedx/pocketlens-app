// Inline net-worth trend for the Balances hero: a mini area chart + signed % delta pill.
// Range state is owned by the parent (AccountsPage) so the same range drives both the
// trend chart and the Assets vs Liabilities bar chart.

import { ArrowDownRight, ArrowUpRight } from 'lucide-react'
import { TrendAreaChart } from '@/components/finance/TrendAreaChart'
import { formatCurrency } from '@/lib/money'
import { formatShortDate } from '@/lib/dates'
import {
  NET_WORTH_RANGES,
  clipToRange,
  signedPercentChange,
} from '@/lib/netWorthTrend'
import { cn } from '@/lib/utils'
import type { NetWorthSnapshot } from '@/types/domain'

interface Props {
  snapshots: NetWorthSnapshot[]
  isLoading: boolean
  rangeIdx: number
}

export function InlineNetWorthTrend({ snapshots, isLoading, rangeIdx }: Props) {
  const range = NET_WORTH_RANGES[rangeIdx]

  const clipped = clipToRange(snapshots, range.days)
  const delta = signedPercentChange(clipped)
  const isUp = (delta ?? 0) >= 0
  // Green (sage) when the range gained, red (destructive) when it lost value.
  const trendClass = isUp ? 'text-secondary' : 'text-destructive'
  const strokeVar = isUp ? 'hsl(var(--secondary))' : 'hsl(var(--destructive))'

  const data = clipped.map((s) => ({
    date: s.date,
    value: Number(s.net_worth),
  }))

  return (
    <div className="space-y-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Net Worth Trend
      </p>

      {delta != null && (
        <div
          className={cn(
            'inline-flex items-center gap-1 rounded-full bg-surface-container px-2.5 py-1 text-xs font-semibold tabular-nums',
            trendClass,
          )}
        >
          {isUp ? (
            <ArrowUpRight className="h-3.5 w-3.5" aria-hidden />
          ) : (
            <ArrowDownRight className="h-3.5 w-3.5" aria-hidden />
          )}
          {`${isUp ? '+' : '−'}${Math.abs(delta).toFixed(1)}% · ${range.label}`}
        </div>
      )}

      <div className="h-[240px]" role="img" aria-label="Net worth trend">
        {isLoading ? (
          <div className="flex h-full items-center text-sm text-muted-foreground">Loading…</div>
        ) : data.length < 2 ? (
          <div className="flex h-full items-center text-sm text-muted-foreground">
            {snapshots.length === 0 ? 'No net-worth history yet.' : 'Not enough history for this range.'}
          </div>
        ) : (
          <TrendAreaChart
            data={data}
            yKey="value"
            color={strokeVar}
            gradientId="inline-nw"
            tooltipLabel="Net worth"
            valueFormatter={formatCurrency}
            labelFormatter={(_, p) =>
              p?.[0]?.payload ? formatShortDate(String(p[0].payload.date)) : ''
            }
          />
        )}
      </div>
    </div>
  )
}
