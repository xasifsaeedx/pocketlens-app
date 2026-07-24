// Views data layer — replaces the old /api/views FastAPI endpoint.
// Builds aggregations client-side from a direct Supabase transaction fetch,
// filtered by date range, account, category group, category,
// tags, and amount bounds.

import { supabase } from '@/lib/supabase'
import { isDemoMode } from '@/demo/demoMode'
import { demoData } from '@/demo/demoStore'
import type { Category, CategoryGroup, Tag, Transaction, UUID } from '@/types/domain'
import { txnTags } from '@/types/domain'

const SELECT =
  '*, categories(*), transaction_tags(tag_id, tags(*)), transaction_splits(*, categories(*))'

export interface ViewsFilters {
  startDate: string // yyyy-MM-dd
  endDate: string // yyyy-MM-dd
  accountId: UUID | null
  categoryGroupId: UUID | null
  categoryId: UUID | null
  tagIds: UUID[]
  tagsMatchAny: boolean
  minAmount: number | undefined
  maxAmount: number | undefined
}

export interface BreakdownRow {
  name: string
  total: number
  count: number
  percent: number
  // optional for grouping in table tabs
  category?: string
  category_id?: UUID
  /** Stored hex from the categories/category_groups/tags row, so a category keeps the
   *  SAME hue in every chart instead of getting a rank-assigned palette color. */
  color?: string
}

export interface ViewsResult {
  start_date: string
  end_date: string
  /** Signed net over non-transfer rows in DB sign (positive = net outflow). */
  total: number
  total_spending: number // sum of positive (debit) amounts — non-income only
  /** Magnitude of credits (income/refunds) over non-transfer rows. */
  total_income: number
  transaction_count: number
  /** Per-day inflow/outflow split, both as positive magnitudes. Excludes transfers. */
  daily_activity: Array<{ date: string; income: number; spending: number }>
  by_category: BreakdownRow[]
  by_category_group: BreakdownRow[]
  by_tag: BreakdownRow[]
  transactions: TxnRow[]
}

export interface TxnRow {
  id: UUID
  Date: string
  Merchant: string
  Amount: number
  Category: string
  /** Category-group name, so the by-group chart can find its rows without a re-lookup. */
  Group: string
  Tags: string
  Notes: string
  Acct: string
  account_id: UUID
  is_transfer: boolean
}

/** Group + account metadata the aggregations need for labelling. */
interface ViewsLookups {
  groups: Pick<CategoryGroup, 'id' | 'name' | 'color'>[]
  accountNames: Map<UUID, string>
}

export async function fetchViewsData(f: ViewsFilters): Promise<ViewsResult> {
  if (isDemoMode()) {
    const d = demoData()
    return buildViewsResult(demoViewRows(f), f, {
      groups: d.groups,
      accountNames: new Map(d.accounts.map((a) => [a.id, a.name])),
    })
  }
  const rows = await fetchViewRows(f)
  return buildViewsResult(rows, f, await fetchViewsLookups(rows))
}

async function fetchViewsLookups(rows: Transaction[]): Promise<ViewsLookups> {
  const accountIds = [...new Set(rows.map((t) => t.account_id))]
  const [groupRes, acctRes] = await Promise.all([
    supabase.from('category_groups').select('id, name, color').order('sort_order', { ascending: true }),
    accountIds.length > 0
      ? supabase.from('accounts').select('id, name').in('id', accountIds)
      : Promise.resolve({ data: [] as { id: UUID; name: string }[] }),
  ])
  return {
    groups: (groupRes.data ?? []) as Pick<CategoryGroup, 'id' | 'name' | 'color'>[],
    accountNames: new Map(
      ((acctRes.data ?? []) as { id: UUID; name: string }[]).map((r) => [r.id, r.name]),
    ),
  }
}

/** Step 1 — the rows PostgREST can filter for us. */
async function fetchViewRows(f: ViewsFilters): Promise<Transaction[]> {
  let q = supabase
    .from('transactions')
    .select(SELECT)
    .gte('effective_date', f.startDate)
    .lte('effective_date', f.endDate)
    .eq('pending', false)
    .eq('hidden', false)
    .eq('exclude_from_totals', false)
    .order('effective_date', { ascending: false })

  if (f.accountId) q = q.eq('account_id', f.accountId)
  if (f.categoryId) q = q.eq('category_id', f.categoryId)

  const { data, error } = await q
  if (error) throw error
  return (data ?? []) as unknown as Transaction[]
}

/** The same rows, from the demo fixtures — the filters `fetchViewRows` pushes down to
 *  PostgREST, applied in memory. Keeps the Explore page fully interactive offline. */
function demoViewRows(f: ViewsFilters): Transaction[] {
  return demoData()
    .transactions.filter(
      (t) =>
        t.effective_date >= f.startDate &&
        t.effective_date <= f.endDate &&
        !t.pending &&
        !t.hidden &&
        !t.exclude_from_totals &&
        (!f.accountId || t.account_id === f.accountId) &&
        (!f.categoryId || t.category_id === f.categoryId),
    )
    .sort((a, b) => (a.effective_date < b.effective_date ? 1 : -1))
}

/** Steps 2–5 — pure: the filters PostgREST can't express, then the aggregations. */
function buildViewsResult(
  rows: Transaction[],
  f: ViewsFilters,
  lookups: ViewsLookups,
): ViewsResult {
  let txns = rows

  // ── 2. Client-side filters that PostgREST can't express cleanly ──────────

  // Category group filter: keep txns whose category has group_id = categoryGroupId
  if (f.categoryGroupId) {
    txns = txns.filter((t) => {
      const cat = t.categories as Category | null
      return cat?.group_id === f.categoryGroupId
    })
  }

  // Tag filter
  if (f.tagIds.length > 0) {
    txns = txns.filter((t) => {
      const ids = txnTags(t).map((tg) => tg.id)
      return f.tagsMatchAny
        ? f.tagIds.some((id) => ids.includes(id))
        : f.tagIds.every((id) => ids.includes(id))
    })
  }

  // Amount filter (on |amount|)
  if (f.minAmount !== undefined) {
    txns = txns.filter((t) => Math.abs(t.amount) >= f.minAmount!)
  }
  if (f.maxAmount !== undefined) {
    txns = txns.filter((t) => Math.abs(t.amount) <= f.maxAmount!)
  }

  // ── 3. Compute aggregate totals ──────────────────────────────────────────
  // DB sign: positive = spend (debit), negative = income (credit).
  // Transfers are excluded from every headline total — a transfer moves money
  // between your own accounts, it is neither spending nor income.
  const nonTransfer = txns.filter((t) => !t.transfer_group_id)
  const netTotal = nonTransfer.reduce((s, t) => s + t.amount, 0)
  const spendTxns = nonTransfer.filter((t) => t.amount > 0)
  const spendTotal = spendTxns.reduce((s, t) => s + t.amount, 0)
  const incomeTotal = -nonTransfer.filter((t) => t.amount < 0).reduce((s, t) => s + t.amount, 0)

  // ── 4. Daily activity (by effective_date) ────────────────────────────────
  // Inflow and outflow are kept apart rather than netted: a day with $2,000 in and
  // $2,000 out is a busy day, not an empty one, and netting hid exactly that.
  // Both are reported as positive magnitudes; the chart decides which way to draw them.
  const byDate = new Map<string, { income: number; spending: number }>()
  for (const t of nonTransfer) {
    const d = t.effective_date.slice(0, 10)
    const entry = byDate.get(d) ?? { income: 0, spending: 0 }
    if (t.amount > 0) entry.spending += t.amount
    else entry.income += -t.amount
    byDate.set(d, entry)
  }
  const daily_activity = [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, v]) => ({ date, income: v.income, spending: v.spending }))

  // ── 5. By category ───────────────────────────────────────────────────────
  const catMap = new Map<
    UUID,
    { name: string; groupId: UUID | null; color: string; total: number; count: number }
  >()
  for (const t of spendTxns) {
    const cat = t.categories as Category | null
    if (!cat) continue
    const existing = catMap.get(cat.id)
    if (existing) {
      existing.total += t.amount
      existing.count += 1
    } else {
      catMap.set(cat.id, {
        name: cat.name,
        groupId: cat.group_id,
        color: cat.color,
        total: t.amount,
        count: 1,
      })
    }
  }
  const by_category: BreakdownRow[] = [...catMap.entries()]
    .map(([id, v]) => ({
      name: v.name,
      category: v.name,
      category_id: id,
      color: v.color,
      total: v.total,
      count: v.count,
      percent: spendTotal > 0 ? (v.total / spendTotal) * 100 : 0,
    }))
    .sort((a, b) => b.total - a.total)

  // ── 6. By category group ─────────────────────────────────────────────────
  // Group metadata labels ungrouped categories as "Other".
  const groupById = new Map(lookups.groups.map((g) => [g.id, g]))

  const groupMap = new Map<string, { name: string; color?: string; total: number; count: number }>()
  for (const t of spendTxns) {
    const cat = t.categories as Category | null
    const groupId = cat?.group_id ?? null
    const group = groupId ? groupById.get(groupId) : undefined
    const groupName = groupId ? (group?.name ?? 'Other') : 'Ungrouped'
    const key = groupId ?? '__ungrouped__'
    const existing = groupMap.get(key)
    if (existing) {
      existing.total += t.amount
      existing.count += 1
    } else {
      groupMap.set(key, { name: groupName, color: group?.color, total: t.amount, count: 1 })
    }
  }
  const by_category_group: BreakdownRow[] = [...groupMap.entries()]
    .map(([, v]) => ({
      name: v.name,
      category: v.name,
      color: v.color,
      total: v.total,
      count: v.count,
      percent: spendTotal > 0 ? (v.total / spendTotal) * 100 : 0,
    }))
    .sort((a, b) => b.total - a.total)

  // ── 7. By tag ────────────────────────────────────────────────────────────
  const tagMap = new Map<UUID, { name: string; color: string; total: number; count: number }>()
  for (const t of spendTxns) {
    for (const tag of txnTags(t)) {
      const existing = tagMap.get(tag.id)
      if (existing) {
        existing.total += t.amount
        existing.count += 1
      } else {
        tagMap.set(tag.id, { name: tag.name, color: tag.color, total: t.amount, count: 1 })
      }
    }
  }
  const by_tag: BreakdownRow[] = [...tagMap.entries()]
    .map(([, v]) => ({
      name: v.name,
      tag: v.name,
      color: v.color,
      total: v.total,
      count: v.count,
      percent: spendTotal > 0 ? (v.total / spendTotal) * 100 : 0,
    }))
    .sort((a, b) => b.total - a.total)

  // ── 8. Flat transaction rows for the table ───────────────────────────────
  const acctNameMap = lookups.accountNames

  const transactions: TxnRow[] = txns.map((t) => {
    const cat = t.categories as Category | null
    const catName = cat?.name ?? ''
    // Mirrors the labelling in the by-group aggregation above.
    const groupName = cat?.group_id ? (groupById.get(cat.group_id)?.name ?? 'Other') : 'Ungrouped'
    const tags = txnTags(t)
      .map((tg: Tag) => tg.name)
      .join(', ')
    return {
      id: t.id,
      Date: t.effective_date.slice(0, 10),
      Merchant: t.merchant_name ?? t.description ?? '',
      Amount: t.amount,
      Category: catName,
      Group: groupName,
      Tags: tags,
      Notes: t.notes ?? '',
      Acct: acctNameMap.get(t.account_id) ?? '',
      account_id: t.account_id,
      is_transfer: t.transfer_group_id != null,
    }
  })

  return {
    start_date: f.startDate,
    end_date: f.endDate,
    total: netTotal,
    total_spending: spendTotal,
    total_income: incomeTotal,
    transaction_count: txns.length,
    daily_activity,
    by_category,
    by_category_group,
    by_tag,
    transactions,
  }
}
