// InlineNetWorthTrend — prop-based API (snapshots + isLoading + rangeIdx).
// Range state and the range-selector buttons live in AccountsPage; this
// component only renders the chart, the signed-% delta pill, and empty states.

import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { InlineNetWorthTrend } from './InlineNetWorthTrend'
import { clipToRange, signedPercentChange, DEFAULT_RANGE_IDX, NET_WORTH_RANGES } from '@/lib/netWorthTrend'
import type { NetWorthSnapshot } from '@/types/domain'

function daysAgoISO(n: number): string {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return d.toISOString().slice(0, 10)
}

function snap(date: string, netWorth: number): NetWorthSnapshot {
  return { id: date, date, total_assets: netWorth, total_liabilities: 0, net_worth: netWorth }
}

// Index for each named range (mirrors NET_WORTH_RANGES order: 1W=0, 1M=1, 6M=2, 1Y=3, All=4)
const IDX_6M = DEFAULT_RANGE_IDX // 2
const IDX_1W = 0

describe('net-worth range helpers', () => {
  it('clipToRange keeps only snapshots within the lookback window; null = all', () => {
    const all = [snap(daysAgoISO(200), 1), snap(daysAgoISO(20), 2), snap(daysAgoISO(1), 3)]
    expect(clipToRange(all, 30).map((s) => s.net_worth)).toEqual([2, 3]) // 1M drops the 200-day-old
    expect(clipToRange(all, 7).map((s) => s.net_worth)).toEqual([3]) // 1W keeps only the newest
    expect(clipToRange(all, null)).toHaveLength(3) // All
  })

  it('signedPercentChange is (end-start)/|start| across the range, or null when < 2 points', () => {
    expect(signedPercentChange([snap('2026-01-01', 10000), snap('2026-02-01', 12000)])).toBeCloseTo(20)
    expect(signedPercentChange([snap('2026-01-01', 20000), snap('2026-02-01', 15000)])).toBeCloseTo(-25)
    expect(signedPercentChange([snap('2026-01-01', 100)])).toBeNull()
    expect(signedPercentChange([snap('2026-01-01', 0), snap('2026-02-01', 5)])).toBeNull()
  })
})

describe('InlineNetWorthTrend', () => {
  // Three snapshots: 100 days ago (10k), 10 days ago (11k), today (12k)
  // At the 6M range all three are in window → delta = +20.0%
  // At the 1W range only the 0-day snapshot is in window → delta pill absent
  let snapshots: NetWorthSnapshot[]

  beforeEach(() => {
    snapshots = [
      snap(daysAgoISO(100), 10000),
      snap(daysAgoISO(10), 11000),
      snap(daysAgoISO(0), 12000),
    ]
  })

  it('shows a signed delta pill when the 6M range has ≥2 points (+20.0% · 6M)', () => {
    render(<InlineNetWorthTrend snapshots={snapshots} isLoading={false} rangeIdx={IDX_6M} />)
    // The delta pill text combines sign + percent + label
    expect(screen.getByText('+20.0% · 6M')).toBeInTheDocument()
  })

  it('renders the Net Worth Trend section heading', () => {
    render(<InlineNetWorthTrend snapshots={snapshots} isLoading={false} rangeIdx={IDX_6M} />)
    expect(screen.getByText('Net Worth Trend')).toBeInTheDocument()
  })

  it('suppresses the delta pill when the range clips to fewer than 2 points (1W)', () => {
    // 1W window: only the 0-day snapshot qualifies → < 2 points → no delta
    render(<InlineNetWorthTrend snapshots={snapshots} isLoading={false} rangeIdx={IDX_1W} />)
    expect(screen.queryByText(/% ·/)).not.toBeInTheDocument()
    expect(screen.getByText(/Not enough history/)).toBeInTheDocument()
  })

  it('shows an empty state with no history', () => {
    render(<InlineNetWorthTrend snapshots={[]} isLoading={false} rangeIdx={IDX_6M} />)
    expect(screen.getByText('No net-worth history yet.')).toBeInTheDocument()
  })

  it('shows a loading state while data is loading', () => {
    render(<InlineNetWorthTrend snapshots={[]} isLoading={true} rangeIdx={IDX_6M} />)
    expect(screen.getByText('Loading…')).toBeInTheDocument()
  })

  it('NET_WORTH_RANGES exposes the five iOS ranges in the expected order', () => {
    const labels = NET_WORTH_RANGES.map((r) => r.label)
    expect(labels).toEqual(['1W', '1M', '6M', '1Y', 'All'])
  })
})
