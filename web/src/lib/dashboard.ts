// Client-side dashboard derivations. Mirrors the derived properties on
// PocketLens/Views/Home/HomeView.swift (income / scheduled / sparkline /
// scheduledItems). All computed from the month transactions the Home hooks
// already fetch — no new backend calls.
//
// Money convention (see lib/money.ts): amount > 0 = spend/out, amount < 0 = income/in.

import { isTransferCategory, sumIncome, sumNetSpend, type Transaction } from '@/types/domain'

/** One point in the hero net-cashflow sparkline. */
export interface SparkPoint {
  date: string // yyyy-MM-dd
  value: number // cumulative net cash flow (income lifts, spend drops)
}

/** Rows that count toward month totals (drops excluded/transfer legs), matching
 *  iOS `!excludeFromTotals`. The Home hook already excludes these, but filtering
 *  here keeps every derivation correct on any input. */
function counted(txns: Transaction[]): Transaction[] {
  return txns.filter((t) => !t.exclude_from_totals)
}

/** Income MTD = Σ magnitude of credit rows (amount < 0), excluding reimbursements
 *  (contra-expense, not income). Mirrors the reimbursement contra-expense rule. */
export function incomeMTD(txns: Transaction[]): number {
  return sumIncome(counted(txns))
}

/** Net spend MTD = Σ positive spend − Σ reimbursement credits.
 *  Mirrors iOS `netSpend` on HomeView — the homepage hero + net-cashflow figure. */
export function netSpendMTD(txns: Transaction[]): number {
  return sumNetSpend(counted(txns))
}

/** Monthly net cash flow = income − net spend (reimbursements net out of spend, not
 *  income, so a same-day reimbursed charge nets to its true cash impact). Positive =
 *  earned more than spent. Mirrors iOS `netCashflow` on HomeView. */
export function netCashflowMTD(txns: Transaction[]): number {
  return incomeMTD(txns) - netSpendMTD(txns)
}

/** "Scheduled" proxy = pending outflows this month (authorized, not yet cleared).
 *  Mirrors iOS `scheduled`. */
export function scheduledTotal(txns: Transaction[]): number {
  return pendingCharges(txns).reduce((s, t) => s + t.amount, 0)
}

/** The pending charges behind the Scheduled total, newest first. Mirrors iOS
 *  `scheduledItems`. */
export function pendingCharges(txns: Transaction[]): Transaction[] {
  return txns
    .filter((t) => t.pending && t.amount > 0)
    .sort((a, b) => b.effective_date.localeCompare(a.effective_date))
}

/** One point in the cumulative monthly spend line.
 *  `day` is the day-of-month (1–31); `total` is the running spend up to that day. */
export interface CumulativeSpendPoint {
  day: number
  total: number
}

/** Cumulative net spend by day-of-month for a month, sorted ascending — reimbursement
 *  credits post as a same-day dip so the line matches netSpendMTD's total.
 *  Mirrors iOS `cumulativeSpend` on HomeView — feeds the spending line chart. */
export function cumulativeSpend(txns: Transaction[]): CumulativeSpendPoint[] {
  const byDay = new Map<number, number>()
  for (const t of counted(txns)) {
    if (t.amount <= 0 && !t.is_reimbursement) continue
    const day = parseInt(t.effective_date.slice(8, 10), 10)
    const delta = t.is_reimbursement ? -Math.abs(t.amount) : t.amount
    byDay.set(day, (byDay.get(day) ?? 0) + delta)
  }
  const days = [...byDay.keys()].sort((a, b) => a - b)
  let running = 0
  return days.map((day) => {
    running += byDay.get(day)!
    return { day, total: running }
  })
}

/** Running cumulative net cash flow per day this month, oldest first. Income lifts
 *  the line, spend drops it (value is negated so income rises). Mirrors iOS
 *  `sparkline`. */
export function cumulativeNetCashflow(txns: Transaction[]): SparkPoint[] {
  const byDay = new Map<string, number>()
  for (const t of counted(txns)) {
    // Skip transfer-in/out legs: a self-deposit isn't cash earned, matching sumIncome.
    if (t.amount < 0 && isTransferCategory(t)) continue
    byDay.set(t.effective_date, (byDay.get(t.effective_date) ?? 0) + t.amount)
  }
  let running = 0
  return [...byDay.keys()]
    .sort()
    .map((day) => {
      running += byDay.get(day)! // positive = spend
      return { date: day, value: -running } // invert so income rises
    })
}
