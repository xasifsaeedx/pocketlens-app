// Mirrors PocketLens/Services/TransactionService.swift. Direct PostgREST.

import { supabase } from '@/lib/supabase'
import { isDemoMode } from '@/demo/demoMode'
import { demoSearch } from '@/demo/demoStore'
import { monthBounds } from '@/lib/dates'
import { fetchCategories, fetchRules } from './categories'
import { logCategorize, logHide } from './activity'
import { resolveCategorization } from '@/lib/categorySuggester'
import type { Category, Transaction, UUID } from '@/types/domain'
import { hasSplits, merchantKey } from '@/types/domain'

const SELECT =
  '*, categories(*), transaction_tags(tag_id, tags(*)), transaction_splits(*, categories(*))'

/** Transactions in the month containing `month`, filtered+ordered by effective_date
 *  (= authorized_date ?? date) so day-grouping matches. Excludes exclude_from_totals
 *  by default; pass `includeExcluded` to keep excluded/transfer rows (the Transactions
 *  page shows them, badged, so the user can unlink — but still leaves them out of totals). */
export async function fetchTransactions(
  month: Date,
  opts: { includeExcluded?: boolean } = {},
): Promise<Transaction[]> {
  const { start, end } = monthBounds(month)
  let q = supabase
    .from('transactions')
    .select(SELECT)
    .gte('effective_date', start)
    .lte('effective_date', end)
  if (!opts.includeExcluded) q = q.eq('exclude_from_totals', false)
  const { data, error } = await q.order('effective_date', { ascending: false })
  if (error) throw error
  return (data ?? []) as unknown as Transaction[]
}

/** Transactions in the last `days` days (Home recent list). */
export async function fetchRecent(days: number): Promise<Transaction[]> {
  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - days)
  const iso = cutoff.toISOString().slice(0, 10)
  const { data, error } = await supabase
    .from('transactions')
    .select(SELECT)
    .gte('effective_date', iso)
    .order('effective_date', { ascending: false })
  if (error) throw error
  return (data ?? []) as unknown as Transaction[]
}

/** Max rows the search RPC returns in one call. The client applies category/tag
 *  filters over this set, so a small cap silently under-reported filtered search
 *. Raised from the RPC's default 50; when a result hits this many rows
 *  the caller shows a "refine your search" notice so the truncation isn't silent. */
export const SEARCH_LIMIT = 200

/** Server-side search across all months (search_transactions RPC: substring +
 *  trigram typo tolerance on merchant/description/notes, plus |amount| match).
 *  The RPC returns ids only; the rows are re-fetched with the standard SELECT
 *  so embeds decode exactly like every other list. Newest first. */
export async function searchTransactions(query: string): Promise<Transaction[]> {
  // The RPC is unavailable in demo mode (no DB) — match the fixtures in memory so
  // search still works on the landing page.
  if (isDemoMode()) return demoSearch(query).slice(0, SEARCH_LIMIT)
  const { data, error } = await supabase.rpc('search_transactions', {
    p_query: query,
    p_limit: SEARCH_LIMIT,
  })
  if (error) throw error
  const ids = ((data ?? []) as { id: UUID }[]).map((r) => r.id)
  if (ids.length === 0) return []
  const res = await supabase
    .from('transactions')
    .select(SELECT)
    .in('id', ids)
    .order('effective_date', { ascending: false })
  if (res.error) throw res.error
  return (res.data ?? []) as unknown as Transaction[]
}

/** All transactions for a single account, newest first. Includes transfers/excluded rows
 *  so the account ledger is complete (mirrors iOS AccountDetailView). */
export async function fetchTransactionsByAccount(accountId: UUID): Promise<Transaction[]> {
  const { data, error } = await supabase
    .from('transactions')
    .select(SELECT)
    .eq('account_id', accountId)
    .order('effective_date', { ascending: false })
  if (error) throw error
  return (data ?? []) as unknown as Transaction[]
}

/** Pass `month` to scope the queue to that calendar month (the banner + review flow the
 *  user browses month-by-month); omit it for the all-months set the bulk flows need
 *  (uncategorizedSameMerchant, autoCategorizeUncategorized). */
export async function fetchUncategorized(month?: Date): Promise<Transaction[]> {
  let q = supabase
    .from('transactions')
    .select(SELECT)
    .is('category_id', null)
    .eq('pending', false)
    .eq('hidden', false) // hidden txns shouldn't nag in the categorize queue
    .eq('exclude_from_totals', false) // nor should transfer legs — they're moved money
    // Uncategorized reimbursements DO belong here: a card refund auto-flagged at sync
    // (categorizer._is_card_refund) has is_reimbursement=true but no category yet, and it
    // only nets its category once the user buckets it. Categorized reimbursements carry a
    // category_id and are already excluded by the `.is('category_id', null)` filter above.
  if (month) {
    const { start, end } = monthBounds(month)
    q = q.gte('effective_date', start).lte('effective_date', end)
  }
  const { data, error } = await q.order('effective_date', { ascending: false })
  if (error) throw error
  // A split txn has a null category_id but is categorized via its splits — confirming it here
  // would re-learn merchant memory from a non-spend parent. PostgREST can't cheaply test the
  // embed's absence in this select, so drop split parents client-side (mirrors iOS
  // `isUncategorizedQueueEligible`, which filters `hasSplits`).
  return ((data ?? []) as unknown as Transaction[]).filter((t) => !hasSplits(t))
}

/** exclude_from_totals after a hidden change: hidden always excludes; unhiding
 *  re-includes only when the txn isn't still a transfer leg. Exported for testing. */
export function excludeAfterHiddenChange(txn: Transaction, hidden: boolean): boolean {
  return hidden || txn.transfer_group_id != null
}

/** Hide/unhide a transaction. Hidden txns are kept (and keep their category) but
 *  drop out of totals via exclude_from_totals, which every totals query already
 *  filters on. Logs a hide/unhide activity entry unless `opts.log === false`
 *  (undo, and the implicit unhide inside setCategory, both suppress logging). */
export async function setHidden(
  txn: Transaction,
  hidden: boolean,
  opts: { log?: boolean } = {},
): Promise<void> {
  const wasHidden = txn.hidden
  const { error } = await supabase
    .from('transactions')
    .update({ hidden, exclude_from_totals: excludeAfterHiddenChange(txn, hidden) })
    .eq('id', txn.id)
  if (error) throw error
  if (opts.log !== false) void logHide(txn, wasHidden, hidden)
}

/** Single transaction by id (undo needs the full row to reconstruct hide state). */
export async function fetchTransactionById(id: UUID): Promise<Transaction | null> {
  const { data, error } = await supabase.from('transactions').select(SELECT).eq('id', id).maybeSingle()
  if (error) throw error
  return (data as unknown as Transaction) ?? null
}

/** Set a category WITHOUT learning (bulk/auto application). */
export async function updateCategory(
  transactionId: UUID,
  categoryId: UUID | null,
): Promise<void> {
  const { error } = await supabase
    .from('transactions')
    .update({ category_id: categoryId })
    .eq('id', transactionId)
  if (error) throw error
}

/** Mark/unmark a credit as a reimbursement (contra-expense), writing `is_reimbursement`
 *  and `category_id` together: a reimbursement MUST carry the category it offsets, so
 *  marking always sets both. Unmarking clears the flag and keeps whatever category is
 *  passed (callers pass the existing category to leave it a normal categorized credit).
 *  No merchant-memory learning — a reimbursement isn't a spend categorization. Mirrors iOS. */
export async function setReimbursement(
  transactionId: UUID,
  isReimbursement: boolean,
  categoryId: UUID | null,
): Promise<void> {
  const { error } = await supabase
    .from('transactions')
    .update({
      is_reimbursement: isReimbursement,
      // Turning it off reverts the row to a plain uncategorized credit: the offset
      // category only has meaning while it's a reimbursement, so clear it (matches
      // iOS TransactionService.setReimbursement + the category_spend view). Enforced
      // here regardless of the caller so both clients agree.
      category_id: isReimbursement ? categoryId : null,
    })
    .eq('id', transactionId)
  if (error) throw error
}

/** Explicit user categorization: set the category AND teach merchant memory.
 *  Also unhides — explicitly picking a bucket moves the txn out of Hidden. */
export async function setCategory(
  txn: Transaction,
  categoryId: UUID | null,
  opts: { log?: boolean } = {},
): Promise<void> {
  const before = txn.category_id
  if (txn.hidden) await setHidden(txn, false, { log: false }) // implicit unhide isn't its own entry
  await updateCategory(txn.id, categoryId)
  // Teach merchant memory, capturing what it mapped to *before* so Undo can restore
  // (or forget) the learning this categorization caused.
  const key = merchantKey(txn)
  let learnedKey: string | null = null
  let priorMerchantCategory: UUID | null = null
  if (categoryId && key) {
    try {
      priorMerchantCategory = await merchantCategoryForKey(key)
      await learnMerchant(key, categoryId)
      learnedKey = key
    } catch {
      // learning is best-effort, mirrors iOS `try?`
    }
  }
  if (opts.log !== false) void logCategorize(txn, before, categoryId, learnedKey, priorMerchantCategory)
}

/** Upsert merchant_key -> category (latest wins). user_id defaults to auth.uid(). */
export async function learnMerchant(key: string, categoryId: UUID): Promise<void> {
  const { error } = await supabase
    .from('merchant_categories')
    .upsert(
      { merchant_key: key, category_id: categoryId },
      { onConflict: 'user_id,merchant_key' },
    )
  if (error) throw error
}

/** The merchant-memory category currently mapped to `key` (null if none). Read before
 *  `learnMerchant` overwrites it, so Undo can restore the prior mapping. */
export async function merchantCategoryForKey(key: string): Promise<UUID | null> {
  const { data, error } = await supabase
    .from('merchant_categories')
    .select('category_id')
    .eq('merchant_key', key)
    .limit(1)
    .maybeSingle()
  if (error) return null
  return ((data?.category_id as UUID) ?? null)
}

/** Forget a learned merchant→category mapping (Undo of the categorization that taught it). */
export async function forgetMerchant(key: string): Promise<void> {
  const { error } = await supabase.from('merchant_categories').delete().eq('merchant_key', key)
  if (error) throw error
}

export async function fetchMerchantMemory(): Promise<Record<string, UUID>> {
  const { data, error } = await supabase
    .from('merchant_categories')
    .select('merchant_key, category_id')
  if (error) throw error
  const out: Record<string, UUID> = {}
  for (const row of (data ?? []) as { merchant_key: string; category_id: UUID }[]) {
    if (out[row.merchant_key] == null) out[row.merchant_key] = row.category_id
  }
  return out
}

/** Other uncategorized txns from the same merchant (retroactive bulk prompt). */
export async function uncategorizedSameMerchant(
  key: string,
  excludingId: UUID | null,
): Promise<Transaction[]> {
  const all = await fetchUncategorized()
  return all.filter((t) => merchantKey(t) === key && t.id !== excludingId)
}

/** Accept the bulk prompt: apply the category to all of the merchant's remaining
 *  uncategorized txns. No re-learning — the triggering setCategory already taught
 *  merchant memory. Mirrors iOS TransactionsViewModel.applyBulk. */
export async function bulkCategorizeSameMerchant(
  key: string,
  categoryId: UUID,
): Promise<void> {
  const others = await uncategorizedSameMerchant(key, null)
  for (const t of others) await updateCategory(t.id, categoryId)
}

/** Max ids per `.in('id', …)` update — keeps the PostgREST request URL under length
 *  limits (a 500-match category becomes 3 requests, not 1 giant one). */
export const AUTO_CATEGORIZE_CHUNK = 200

/** Split `arr` into sub-arrays of at most `size` items. */
export function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

/** One-tap "Auto-categorize uncategorized": apply learned merchant memory + keyword rules
 *  to every uncategorized txn, persisting each confident hit. No re-learning — an auto-guess
 *  isn't an explicit user choice (deliberately uses a raw `category_id` update, never
 *  setCategory, so merchant memory is untouched). Returns how many were categorized.
 *  Matches are grouped by category and applied in one bulk update per category (chunked
 *  to ≤200 ids), instead of one round-trip per txn. Mirrors iOS
 *  CategoryRulesView.autoCategorize(). */
export async function autoCategorizeUncategorized(): Promise<number> {
  const [uncategorized, memory, rules, categories] = await Promise.all([
    fetchUncategorized(),
    fetchMerchantMemory(),
    fetchRules(),
    fetchCategories(),
  ])
  // Group matched txn ids by the category they matched (in-memory, fast). A
  // conditional rule can also flag a reimbursement — collected separately
  // and written in its own bulk pass, since it's an orthogonal action.
  const byCategory = new Map<UUID, UUID[]>()
  const reimburseIds: UUID[] = []
  const touched = new Set<UUID>()
  for (const txn of uncategorized) {
    const { categoryId, setReimbursement } = resolveCategorization(txn, memory, rules, categories)
    if (categoryId) {
      const ids = byCategory.get(categoryId)
      if (ids) ids.push(txn.id)
      else byCategory.set(categoryId, [txn.id])
      touched.add(txn.id)
    }
    if (setReimbursement) {
      reimburseIds.push(txn.id)
      touched.add(txn.id)
    }
  }
  // One bulk write per category (chunked), not one per txn.
  for (const [catId, ids] of byCategory) {
    for (const batch of chunk(ids, AUTO_CATEGORIZE_CHUNK)) {
      const { error } = await supabase.from('transactions').update({ category_id: catId }).in('id', batch)
      if (error) throw error
    }
  }
  // Then flag reimbursements (the category set above is the one each offsets).
  for (const batch of chunk(reimburseIds, AUTO_CATEGORIZE_CHUNK)) {
    const { error } = await supabase
      .from('transactions')
      .update({ is_reimbursement: true })
      .in('id', batch)
    if (error) throw error
  }
  return touched.size
}

// ── CSV import (WEB-12) ────────────────────────────────────────────────────

/** One parsed CSV line ready to insert. `amount` already in DB convention
 *  (positive = spend, negative = income); `categoryId` optional auto-guess. */
export interface ImportRow {
  date: string // yyyy-MM-dd
  amount: number
  merchant: string
  categoryId?: UUID | null
}

export interface ImportResult {
  inserted: number
  duplicates: number
}

/** Deterministic synthetic id so re-importing the same file is idempotent: the same
 *  (account, date, amount, merchant) tuple yields the same id and is skipped as a
 *  duplicate. Genuinely repeated rows in one file (e.g. two identical coffees) get an
 *  occurrence suffix so both survive. */
function syntheticId(accountId: UUID, row: ImportRow, occurrence: number): string {
  const cents = Math.round(row.amount * 100)
  const slug = row.merchant
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  const base = `csv:${accountId}:${row.date}:${cents}:${slug}`
  return occurrence === 0 ? base : `${base}:${occurrence}`
}

/** Insert CSV-imported transactions for `accountId`. Rows are upserted on the unique
 *  `plaid_transaction_id` with duplicates ignored, so re-imports don't double-count.
 *  Returns how many were newly inserted vs skipped as duplicates. user_id auto-stamps
 *  via the column default (auth.uid()). */
export async function importTransactions(
  accountId: UUID,
  rows: ImportRow[],
): Promise<ImportResult> {
  const seen = new Map<string, number>()
  const payload = rows.map((r) => {
    const key = `${r.date}|${Math.round(r.amount * 100)}|${r.merchant.toLowerCase()}`
    const occ = seen.get(key) ?? 0
    seen.set(key, occ + 1)
    return {
      plaid_transaction_id: syntheticId(accountId, r, occ),
      account_id: accountId,
      date: r.date,
      amount: r.amount,
      merchant_name: r.merchant || null,
      description: r.merchant || null,
      category_id: r.categoryId ?? null,
      pending: false,
    }
  })

  // Chunk to keep request bodies reasonable for large statements.
  const CHUNK = 500
  let inserted = 0
  for (let i = 0; i < payload.length; i += CHUNK) {
    const slice = payload.slice(i, i + CHUNK)
    const { data, error } = await supabase
      .from('transactions')
      .upsert(slice, { onConflict: 'plaid_transaction_id', ignoreDuplicates: true })
      .select('id')
    if (error) throw error
    inserted += data?.length ?? 0
  }
  return { inserted, duplicates: rows.length - inserted }
}

/** Spend total per category for a month (amount > 0 only; splits-aware). Reads the
 *  `category_spend` view — the single source of truth shared with iOS — instead of
 *  recomputing client-side. Semantics live in the view (migration
 *  20260716043438_category_spend_view). */
export async function fetchSpendByCategory(
  month: Date,
): Promise<Array<{ category: Category; total: number }>> {
  const { start } = monthBounds(month) // view months are first-of-month dates
  const [cats, res] = await Promise.all([
    fetchCategories(),
    supabase.from('category_spend').select('category_id, spent').eq('month', start),
  ])
  if (res.error) throw res.error
  const catById = new Map(cats.map((c) => [c.id, c]))
  return ((res.data ?? []) as Array<{ category_id: UUID; spent: number | string }>)
    .map((r) => ({ category: catById.get(r.category_id), total: Number(r.spent) }))
    .filter((x): x is { category: Category; total: number } => x.category != null)
    .sort((a, b) => b.total - a.total)
}

/** Total spend for transactions with NO category this month.
 *  The category_spend view requires category_id IS NOT NULL, so uncategorized spend
 *  is a blind spot there — we query the transactions table directly using the same
 *  guards (exclude_from_totals=false, amount>0, not a reimbursement). Split legs
 *  that are uncategorized are also included via transaction_splits. */
export async function fetchUncategorizedSpend(month: Date): Promise<number> {
  const { start, end } = monthBounds(month)

  // Unsplit transactions with no category
  const { data: txnData, error: txnError } = await supabase
    .from('transactions')
    .select('id, amount')
    .gte('effective_date', start)
    .lte('effective_date', end)
    .is('category_id', null)
    .eq('exclude_from_totals', false)
    .eq('is_reimbursement', false)
    .gt('amount', 0)
  if (txnError) throw txnError

  // Split legs with no category (join via RPC isn't available here; fetch splits for
  // the month's transactions and filter client-side — split tables are small per month)
  const { data: splitData, error: splitError } = await supabase
    .from('transaction_splits')
    .select('amount, transactions!inner(effective_date, exclude_from_totals, is_reimbursement)')
    .is('category_id', null)
    .gt('amount', 0)
    .gte('transactions.effective_date', start)
    .lte('transactions.effective_date', end)
    .eq('transactions.exclude_from_totals', false)
    .eq('transactions.is_reimbursement', false)
  if (splitError) throw splitError

  const txnTotal = (txnData ?? []).reduce((s, r) => s + Number(r.amount), 0)
  const splitTotal = (splitData ?? []).reduce((s, r) => s + Number(r.amount), 0)
  return txnTotal + splitTotal
}
