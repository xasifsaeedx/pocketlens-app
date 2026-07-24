// The demo dataset as a lazily-built singleton, plus the query helpers that stand in
// for PostgREST filters. Kept apart from demoData.ts (which only *builds* rows) so the
// seeding code and the demo branches in data/* share one instance — two copies would
// hand the Explore page different transactions than the dashboard.

import { monthBounds } from '@/lib/dates'
import { hasSplits, type Category, type Transaction, type UUID } from '@/types/domain'
import { buildDemoData, type DemoData } from './demoData'

let cached: DemoData | null = null

export function demoData(): DemoData {
  if (!cached) cached = buildDemoData()
  return cached
}

/** Reset the singleton — tests only. */
export function resetDemoData(): void {
  cached = null
}

const desc = (a: Transaction, b: Transaction) => (a.effective_date < b.effective_date ? 1 : -1)

/** Mirrors data/transactions.fetchTransactions. */
export function demoMonthTransactions(
  month: Date,
  opts: { includeExcluded?: boolean } = {},
): Transaction[] {
  const { start, end } = monthBounds(month)
  return demoData()
    .transactions.filter(
      (t) =>
        t.effective_date >= start &&
        t.effective_date <= end &&
        (opts.includeExcluded || !t.exclude_from_totals),
    )
    .sort(desc)
}

/** Mirrors data/transactions.fetchRecent. */
export function demoRecent(days: number): Transaction[] {
  const cutoff = new Date(demoData().now)
  cutoff.setDate(cutoff.getDate() - days)
  const iso = cutoff.toISOString().slice(0, 10)
  return demoData()
    .transactions.filter((t) => t.effective_date >= iso)
    .sort(desc)
}

/** Mirrors data/transactions.fetchUncategorized. */
export function demoUncategorized(month?: Date): Transaction[] {
  const bounds = month ? monthBounds(month) : null
  return demoData()
    .transactions.filter(
      (t) =>
        t.category_id == null &&
        !t.pending &&
        !t.hidden &&
        !t.exclude_from_totals &&
        !hasSplits(t) &&
        (!bounds || (t.effective_date >= bounds.start && t.effective_date <= bounds.end)),
    )
    .sort(desc)
}

/** Mirrors data/transactions.fetchTransactionsByAccount (includes excluded rows). */
export function demoAccountTransactions(accountId: UUID): Transaction[] {
  return demoData()
    .transactions.filter((t) => t.account_id === accountId)
    .sort(desc)
}

/** Stands in for the splits-aware `category_spend` view. The demo has no splits and no
 *  reimbursements, so this is a plain sum of positive amounts per category. */
export function demoSpendByCategory(month: Date): Array<{ category: Category; total: number }> {
  const byCategory = new Map<UUID, number>()
  for (const t of demoMonthTransactions(month)) {
    if (t.amount <= 0 || t.category_id == null) continue
    byCategory.set(t.category_id, (byCategory.get(t.category_id) ?? 0) + t.amount)
  }
  const catById = new Map(demoData().categories.map((c) => [c.id, c]))
  return [...byCategory.entries()]
    .map(([id, total]) => ({ category: catById.get(id)!, total }))
    .filter((r) => r.category != null)
    .sort((a, b) => b.total - a.total)
}

/** Mirrors data/transactions.fetchUncategorizedSpend. */
export function demoUncategorizedSpend(month: Date): number {
  return demoMonthTransactions(month)
    .filter((t) => t.category_id == null && t.amount > 0 && !t.is_reimbursement)
    .reduce((s, t) => s + t.amount, 0)
}

/** Substring match over merchant / description / notes, newest first — the demo stand-in
 *  for the `search_transactions` RPC (without its trigram typo tolerance). */
export function demoSearch(query: string): Transaction[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const amount = Number(q.replace(/[$,]/g, ''))
  return demoData()
    .transactions.filter((t) => {
      const haystack = [t.merchant_name, t.description, t.notes]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
      if (haystack.includes(q)) return true
      return Number.isFinite(amount) && amount > 0 && Math.abs(t.amount).toFixed(2) === amount.toFixed(2)
    })
    .sort(desc)
}

/** Transfer groups in a month: {groupId → legs}. Mirrors data/transfers.fetchTransferGroups. */
export function demoTransferGroups(month: Date): Map<UUID, Transaction[]> {
  const groups = new Map<UUID, Transaction[]>()
  for (const t of demoMonthTransactions(month, { includeExcluded: true })) {
    if (t.transfer_group_id == null) continue
    const legs = groups.get(t.transfer_group_id) ?? []
    legs.push(t)
    groups.set(t.transfer_group_id, legs)
  }
  return groups
}

/** Learned merchant→category memory, derived from what is already categorized. */
export function demoMerchantMemory(): Record<string, UUID> {
  const memory: Record<string, UUID> = {}
  for (const t of demoData().transactions) {
    const key = (t.merchant_name ?? '').trim().toLowerCase()
    if (key && t.category_id) memory[key] = t.category_id
  }
  return memory
}
