// Monthly reports, computed client-side from Supabase — replacing Keep's dead
// FastAPI `/api/reports/monthly`. Mirrors the metrics the iOS reports screen shows
// (IOS-12, PocketLens/Views/Reports/ReportsView.swift) so web and iOS agree:
//   * totalSpend  = Σ positive amounts of counted txns (transaction-level).
//   * income      = Σ |amount| of counted credits (amount < 0).
//   * avgTransaction = mean amount over spending txns (amount > 0) only.
//   * savingsRate = (income − spend) / income; null when there's no income.
//   * cumulative  = per-day running total of positive amounts, this vs prior month.
//   * category breakdown = the splits-aware `category_spend` Postgres view (the
//     cross-client source of truth), so split txns are attributed to their split
//     categories exactly like iOS + budgets/ZBB.
//
// Money convention (lib/money.ts): amount > 0 = spend/out, amount < 0 = income/in.
// Transfers + hidden rows already carry exclude_from_totals (fetchTransactions drops
// them). Spend/income totals are transaction-level to match iOS — only the category
// pie is split-aware (via the view).

import { parseLocalDate } from '@/lib/dates'
import { fetchCategories } from './categories'
import { fetchCategoryGroups } from './categoryGroups'
import { fetchSpendByCategory, fetchTransactions } from './transactions'
import { sumIncome, sumNetSpend, type Category, type CategoryGroup, type Transaction, type UUID } from '@/types/domain'
import type { BreakdownRow } from '@/components/reports/SpendBreakdownCharts'

export interface CumPoint {
  day_of_month: number
  this_month: number | null
  last_month: number | null
}

export interface ReportData {
  year: number
  month: number
  prevMonthYear: number
  prevMonth: number
  totalSpending: number
  totalIncome: number
  avgTransactionAmount: number
  transactionCount: number
  /** (income − spending) ÷ income, as a percentage; null when there's no income. */
  savingsRatePct: number | null
  cumulativeComparison: CumPoint[]
  byCategory: BreakdownRow[]
  bySubcategory: BreakdownRow[]
  byCategoryGroup: BreakdownRow[]
  byTag: BreakdownRow[]
}

type CategoryMap = Map<UUID, Category>

/** Rows that count toward totals (defensive — fetchTransactions already excludes these). */
function counted(txns: Transaction[]): Transaction[] {
  return txns.filter((t) => !t.exclude_from_totals)
}

/** Day-of-month (1–31) for an effective_date string, local-midnight parsed. */
function dayOfMonth(effectiveDate: string): number {
  return parseLocalDate(effectiveDate).getDate()
}

function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate()
}

/** How far the "this month" line runs: through today for the in-progress current
 *  month, else the full calendar month. Prior months always run their full length. */
function monthCapDays(year: number, month: number, now = new Date()): number {
  if (year === now.getFullYear() && month === now.getMonth() + 1) return now.getDate()
  return daysInMonth(year, month)
}

/** Stat cards: total spending, income, avg transaction, count, savings rate.
 *  Transaction-level (not split-aware), matching ReportsViewModel on iOS. */
export function computeMetrics(
  txns: Transaction[],
): Pick<
  ReportData,
  'totalSpending' | 'totalIncome' | 'avgTransactionAmount' | 'transactionCount' | 'savingsRatePct'
> {
  const rows = counted(txns)
  const spends = rows.filter((t) => t.amount > 0) // reimbursements are credits (amount < 0)
  const grossSpend = spends.reduce((s, t) => s + t.amount, 0)
  // Net spend + income net out reimbursements (contra-expense);
  // the avg stays over gross positive-spend txns so a reimbursement doesn't skew it.
  const totalSpending = sumNetSpend(rows)
  const totalIncome = sumIncome(rows)
  const avgTransactionAmount = spends.length > 0 ? grossSpend / spends.length : 0
  const savingsRatePct = totalIncome > 0 ? ((totalIncome - totalSpending) / totalIncome) * 100 : null
  return {
    totalSpending,
    totalIncome,
    avgTransactionAmount,
    transactionCount: rows.length,
    savingsRatePct,
  }
}

/** Running cumulative spend per day-of-month, length `capDays` (carries the line flat
 *  across days with no spending). Positive amounts only, matching iOS. */
function cumulativeByDay(txns: Transaction[], capDays: number): number[] {
  const perDay = new Array<number>(capDays + 1).fill(0) // 1-indexed by day-of-month
  for (const t of counted(txns)) {
    if (t.amount <= 0) continue
    const day = dayOfMonth(t.effective_date)
    if (day >= 1 && day <= capDays) perDay[day] += t.amount
  }
  const out: number[] = []
  let running = 0
  for (let d = 1; d <= capDays; d++) {
    running += perDay[d]
    out.push(running)
  }
  return out
}

function prevMonthOf(year: number, month: number): { prevMonthYear: number; prevMonth: number } {
  return month === 1 ? { prevMonthYear: year - 1, prevMonth: 12 } : { prevMonthYear: year, prevMonth: month - 1 }
}

/** Day-by-day cumulative spend, this month vs the prior month. */
export function buildComparison(
  thisTxns: Transaction[],
  prevTxns: Transaction[],
  year: number,
  month: number,
  now = new Date(),
): CumPoint[] {
  const thisCap = monthCapDays(year, month, now)
  const { prevMonthYear, prevMonth } = prevMonthOf(year, month)
  const prevCap = daysInMonth(prevMonthYear, prevMonth)
  const thisCum = cumulativeByDay(thisTxns, thisCap)
  const prevCum = cumulativeByDay(prevTxns, prevCap)
  const maxLen = Math.max(thisCap, prevCap)
  const points: CumPoint[] = []
  for (let d = 1; d <= maxLen; d++) {
    points.push({
      day_of_month: d,
      this_month: d <= thisCap ? thisCum[d - 1] : null,
      last_month: d <= prevCap ? prevCum[d - 1] : null,
    })
  }
  return points
}

/** Break split-aware category spend into the pie rows the charts expect. `total` is
 *  stored NEGATIVE (outflow) because SpendPieCard plots rows with `signedTotal < 0`.
 *  Categories roll up to their top-level parent for `byCategory`; `bySubcategory`
 *  keeps the leaf, tagging it with the parent id so a category-slice click filters it. */
export function buildCategoryRows(
  spend: Array<{ category: Category; total: number }>,
  catById: CategoryMap,
): { byCategory: BreakdownRow[]; bySubcategory: BreakdownRow[] } {
  const topTotals = new Map<UUID, number>()
  const topNames = new Map<UUID, string>()
  const bySubcategory: BreakdownRow[] = []

  for (const { category, total } of spend) {
    if (category.kind === 'income' || total <= 0) continue
    const parent = category.parent_id ? catById.get(category.parent_id) : undefined
    const topId = parent?.id ?? category.id
    const topName = parent?.name ?? category.name
    topNames.set(topId, topName)
    topTotals.set(topId, (topTotals.get(topId) ?? 0) + total)
    bySubcategory.push({
      total: -total,
      percent: 0,
      category: topName,
      subcategory: category.name,
      category_id: topId,
    })
  }

  const byCategory: BreakdownRow[] = [...topTotals.entries()].map(([id, total]) => ({
    total: -total,
    percent: 0,
    category: topNames.get(id) ?? 'Unknown',
    category_id: id,
  }))

  return { byCategory, bySubcategory }
}

/** Spend per category group. Categories whose `group_id` is null are grouped together
 *  under "Ungrouped". `total` is negated (outflow) to match the pie convention. */
export function buildCategoryGroupRows(
  spend: Array<{ category: Category; total: number }>,
  catById: CategoryMap,
  groups: CategoryGroup[],
): BreakdownRow[] {
  const groupTotals = new Map<string, number>()
  const groupNames = new Map<string, string>()

  // Build a lookup from group_id → group name.
  for (const g of groups) {
    groupNames.set(g.id, g.name)
  }

  for (const { category, total } of spend) {
    if (category.kind === 'income' || total <= 0) continue
    // Resolve the top-level (parent) category to find its group.
    const parent = category.parent_id ? catById.get(category.parent_id) : undefined
    const topCategory = parent ?? category
    const groupId = topCategory.group_id ?? '__ungrouped__'
    const groupName = groupId === '__ungrouped__' ? 'Ungrouped' : (groupNames.get(groupId) ?? 'Ungrouped')
    groupNames.set(groupId, groupName)
    groupTotals.set(groupId, (groupTotals.get(groupId) ?? 0) + total)
  }

  return [...groupTotals.entries()].map(([groupId, total]) => ({
    total: -total,
    percent: 0,
    category: groupNames.get(groupId) ?? 'Ungrouped',
  }))
}

/** Spend per tag, from the month's transactions (tags live on the transaction, so a
 *  tagged txn contributes its whole spend amount to each of its tags). Credits and
 *  untagged rows are dropped; `total` is negated for the outflow pie. */
export function buildTagRows(txns: Transaction[]): BreakdownRow[] {
  const byTag = new Map<string, number>()
  for (const t of counted(txns)) {
    if (t.amount <= 0) continue
    for (const tt of t.transaction_tags ?? []) {
      const name = tt.tags?.name
      if (!name) continue
      byTag.set(name, (byTag.get(name) ?? 0) + t.amount)
    }
  }
  return [...byTag.entries()].map(([tag, total]) => ({ total: -total, percent: 0, tag }))
}

/** Assemble a full report from already-fetched inputs. Pure — the network lives in
 *  `fetchReport`; this is what the unit tests exercise. */
export function buildReport(input: {
  year: number
  month: number
  thisTxns: Transaction[]
  prevTxns: Transaction[]
  spend: Array<{ category: Category; total: number }>
  categories: Category[]
  groups?: CategoryGroup[]
  now?: Date
}): ReportData {
  const { year, month, thisTxns, prevTxns, spend, categories, groups = [], now = new Date() } = input
  const catById: CategoryMap = new Map(categories.map((c) => [c.id, c]))
  const { prevMonthYear, prevMonth } = prevMonthOf(year, month)
  const { byCategory, bySubcategory } = buildCategoryRows(spend, catById)
  return {
    year,
    month,
    prevMonthYear,
    prevMonth,
    ...computeMetrics(thisTxns),
    cumulativeComparison: buildComparison(thisTxns, prevTxns, year, month, now),
    byCategory,
    bySubcategory,
    byCategoryGroup: buildCategoryGroupRows(spend, catById, groups),
    byTag: buildTagRows(thisTxns),
  }
}

/** Fetch the month's data from Supabase and derive the report. Per-category spend
 *  comes from the splits-aware `category_spend` view; the totals + cumulative come from
 *  the month transactions (this + prior month for the comparison). */
export async function fetchReport(year: number, month: number): Promise<ReportData> {
  const thisMonthDate = new Date(year, month - 1, 1)
  const prevMonthDate = new Date(year, month - 2, 1)
  const [thisTxns, prevTxns, spend, categories, groups] = await Promise.all([
    fetchTransactions(thisMonthDate),
    fetchTransactions(prevMonthDate),
    fetchSpendByCategory(thisMonthDate),
    fetchCategories(),
    fetchCategoryGroups(),
  ])
  return buildReport({ year, month, thisTxns, prevTxns, spend, categories, groups })
}
