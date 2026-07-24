// Recurring-charge detection: pure analysis over a window of transactions. Groups spend
// outflows by merchant_key, and flags a group as a recurring series when its occurrences fall
// on a regular cadence (weekly / biweekly / monthly / yearly) with consistent amounts.
//
// ponytail: a client-side O(n) scan, not a precomputed table + backend job. Detection re-runs
// from live data each load so it's never stale; the ceiling is the size of the transaction
// window (fetchRecurringWindow bounds it). Upgrade path: materialize series server-side.

import { daysBetween, parseLocalDate, toISODate } from '@/lib/dates'
import { merchantKey, displayName, type Transaction } from '@/types/domain'

export type Cadence = 'weekly' | 'biweekly' | 'monthly' | 'yearly'

export interface RecurringSeries {
  merchantKey: string
  displayName: string
  cadence: Cadence
  cadenceDays: number // canonical days for the cadence (7/14/30/365)
  avgAmount: number // signed, same convention as txns (+ = spend)
  count: number
  lastDate: string // yyyy-MM-dd of the most recent occurrence
  nextExpected: string // yyyy-MM-dd = lastDate + cadenceDays
  occurrences: Transaction[] // ascending by effective_date
}

// A series needs at least this many occurrences to establish a cadence (2 gaps).
const MIN_OCCURRENCES = 3

// Cadence buckets: a median gap (in days) within [min,max] classifies as that cadence.
// Monthly is wide because calendar months are 28–31 days and posting dates drift.
const BUCKETS: { cadence: Cadence; days: number; min: number; max: number }[] = [
  { cadence: 'weekly', days: 7, min: 5, max: 9 },
  { cadence: 'biweekly', days: 14, min: 12, max: 16 },
  { cadence: 'monthly', days: 30, min: 26, max: 35 },
  { cadence: 'yearly', days: 365, min: 350, max: 380 },
]

// Amounts must be consistent for a subscription: every occurrence within this fraction of the
// median magnitude. A real subscription is near-constant; a variable-spend merchant is not.
const AMOUNT_TOLERANCE = 0.25

function median(nums: number[]): number {
  const s = [...nums].sort((x, y) => x - y)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

function classify(medianGap: number): { cadence: Cadence; days: number } | null {
  const b = BUCKETS.find((x) => medianGap >= x.min && medianGap <= x.max)
  return b ? { cadence: b.cadence, days: b.days } : null
}

/** Detect recurring series from a window of transactions. Only spend outflows (amount > 0)
 *  with a merchant key are considered. Returns series sorted by next-expected date (soonest
 *  first). Pure — no I/O, no clock. */
export function detectRecurringSeries(txns: Transaction[]): RecurringSeries[] {
  // Group spend outflows by merchant key.
  const groups = new Map<string, Transaction[]>()
  for (const t of txns) {
    if (t.amount <= 0) continue // outflows only (subscriptions are spend)
    const key = merchantKey(t)
    if (!key) continue
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(t)
  }

  const series: RecurringSeries[] = []
  for (const [key, rows] of groups) {
    if (rows.length < MIN_OCCURRENCES) continue
    const occ = [...rows].sort((a, b) => a.effective_date.localeCompare(b.effective_date))

    // Regular cadence?
    const gaps: number[] = []
    for (let i = 1; i < occ.length; i++) gaps.push(daysBetween(occ[i - 1].effective_date, occ[i].effective_date))
    const medGap = median(gaps)
    const cad = classify(medGap)
    if (!cad) continue

    // Consistent amounts?
    const amounts = occ.map((t) => t.amount)
    const medAmt = median(amounts)
    if (medAmt === 0) continue
    const consistent = amounts.every((a) => Math.abs(a - medAmt) <= Math.abs(medAmt) * AMOUNT_TOLERANCE)
    if (!consistent) continue

    const avgAmount = amounts.reduce((s, a) => s + a, 0) / amounts.length
    const lastDate = occ[occ.length - 1].effective_date
    const next = parseLocalDate(lastDate)
    next.setDate(next.getDate() + cad.days)

    series.push({
      merchantKey: key,
      displayName: displayName(occ[occ.length - 1]),
      cadence: cad.cadence,
      cadenceDays: cad.days,
      avgAmount,
      count: occ.length,
      lastDate,
      nextExpected: toISODate(next),
      occurrences: occ,
    })
  }

  return series.sort((a, b) => a.nextExpected.localeCompare(b.nextExpected))
}
