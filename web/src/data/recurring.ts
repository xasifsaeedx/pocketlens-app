// Recurring charges: fetch a window of recent transactions, detect series client-side
// (lib/recurring.ts), and merge the user's per-merchant overrides (confirm/ignore/remove).
// Direct PostgREST; no backend job. Mirrors nothing on iOS yet (web-first); the overrides
// schema is shared so iOS can adopt later.

import { supabase } from '@/lib/supabase'
import { toISODate } from '@/lib/dates'
import { detectRecurringSeries, type RecurringSeries } from '@/lib/recurring'
import type { Transaction, UUID } from '@/types/domain'

const SELECT =
  '*, categories(*), transaction_tags(tag_id, tags(*)), transaction_splits(*, categories(*))'

/** How far back to scan for recurring patterns. ~13 months so a yearly charge shows ≥1 repeat
 *  and monthly charges show a full year of occurrences. */
export const WINDOW_DAYS = 400

export type RecurringStatus = 'suggested' | 'confirmed' | 'ignored' | 'removed'

export interface RecurringSeriesCard extends RecurringSeries {
  status: RecurringStatus
}

async function fetchRecurringWindow(): Promise<Transaction[]> {
  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - WINDOW_DAYS)
  const { data, error } = await supabase
    .from('transactions')
    .select(SELECT)
    .gte('effective_date', toISODate(cutoff))
    .eq('pending', false)
    .order('effective_date', { ascending: false })
  if (error) throw error
  return (data ?? []) as unknown as Transaction[]
}

async function fetchOverrides(): Promise<Map<string, RecurringStatus>> {
  const { data, error } = await supabase
    .from('recurring_overrides')
    .select('merchant_key, status')
  if (error) throw error
  const m = new Map<string, RecurringStatus>()
  for (const r of (data ?? []) as { merchant_key: string; status: RecurringStatus }[]) {
    m.set(r.merchant_key, r.status)
  }
  return m
}

/** Detected series with each user's decision applied. `removed` series are dropped entirely;
 *  the caller decides whether to show `ignored` ones. Sorted soonest-next-expected first. */
export async function fetchRecurringSeries(): Promise<RecurringSeriesCard[]> {
  const [txns, overrides] = await Promise.all([fetchRecurringWindow(), fetchOverrides()])
  return detectRecurringSeries(txns)
    .map((s) => ({ ...s, status: overrides.get(s.merchantKey) ?? ('suggested' as RecurringStatus) }))
    .filter((s) => s.status !== 'removed')
}

/** Set (upsert) a user's decision for a merchant's series. */
export async function setRecurringStatus(
  merchantKey: string,
  status: Exclude<RecurringStatus, 'suggested'>,
): Promise<void> {
  const { error } = await supabase
    .from('recurring_overrides')
    .upsert({ merchant_key: merchantKey, status }, { onConflict: 'user_id,merchant_key' })
  if (error) throw error
}

/** Clear a decision (back to "suggested") by deleting the override row. */
export async function clearRecurringStatus(merchantKey: string): Promise<void> {
  const { error } = await supabase
    .from('recurring_overrides')
    .delete()
    .eq('merchant_key', merchantKey)
  if (error) throw error
}

/** Apply a category to every occurrence of a series (bulk recategorize). Reuses the plain
 *  category update — no merchant re-learn, since the user is acting on the whole series. */
export async function categorizeRecurringSeries(
  occurrenceIds: UUID[],
  categoryId: UUID,
): Promise<void> {
  if (occurrenceIds.length === 0) return
  const { error } = await supabase
    .from('transactions')
    .update({ category_id: categoryId })
    .in('id', occurrenceIds)
  if (error) throw error
}
