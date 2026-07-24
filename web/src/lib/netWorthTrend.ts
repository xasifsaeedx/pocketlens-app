// Pure derivations for the inline net-worth trend on the Balances page. Mirrors the
// range clipping + rangeDelta computed properties on
// PocketLens/Views/Accounts/AccountsView.swift. Kept out of the component file so the
// React-refresh boundary stays component-only.

import { toISODate } from '@/lib/dates'
import type { NetWorthSnapshot } from '@/types/domain'

// Day-based lookbacks mirroring iOS NetWorthRange; `days: null` = all history.
export const NET_WORTH_RANGES = [
  { label: '1W', days: 7 },
  { label: '1M', days: 30 },
  { label: '6M', days: 182 },
  { label: '1Y', days: 365 },
  { label: 'All', days: null },
] as const

export const DEFAULT_RANGE_IDX = 2 // 6M, matching iOS default

/** Snapshots within the last `days` (oldest-first order preserved). `null` = all. */
export function clipToRange(snapshots: NetWorthSnapshot[], days: number | null): NetWorthSnapshot[] {
  if (days == null) return snapshots
  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - days)
  const cutoffISO = toISODate(cutoff)
  return snapshots.filter((s) => s.date >= cutoffISO)
}

/** Signed % change across the clipped range (negative = losing money). Null when
 *  there isn't enough history or the start is zero. Mirrors iOS `rangeDelta`. */
export function signedPercentChange(pts: NetWorthSnapshot[]): number | null {
  if (pts.length < 2) return null
  const start = Number(pts[0].net_worth)
  const end = Number(pts[pts.length - 1].net_worth)
  if (start === 0) return null
  return ((end - start) / Math.abs(start)) * 100
}
