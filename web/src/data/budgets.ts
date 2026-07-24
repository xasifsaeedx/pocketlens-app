// Mirrors PocketLens/Services/BudgetService.swift.
//
// Effective-dated limits: `budget_limits` stores one row per (category, effective_month).
// The limit in effect for a category at a month is the row with the greatest
// effective_month ≤ that month (a `monthly_limit` of 0 = explicitly unbudgeted from then on).
// Editing writes the row at the target month (default: current); other months keep the limit
// that was in effect then.

import { supabase } from '@/lib/supabase'
import { logDeleteBudget, logSetBudget } from './activity'
import { parseLocalDate, toISODate } from '@/lib/dates'
import type { BudgetLimit, UUID } from '@/types/domain'

/** First-of-month Date for the month containing `d` (the effective_month grain). */
function firstOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1)
}

export async function fetchBudgetLimits(): Promise<BudgetLimit[]> {
  const { data, error } = await supabase
    .from('budget_limits')
    .select('*')
    .order('effective_month', { ascending: true })
  if (error) throw error
  return (data ?? []) as BudgetLimit[]
}

/** The row in effect for `categoryId` at `month`: the greatest effective_month ≤ month, or
 *  null when the category has no row on/before that month (i.e. unbudgeted). Pure helper. */
function resolveRow(rows: BudgetLimit[], categoryId: UUID, month: Date): BudgetLimit | null {
  const cutoff = firstOfMonth(month).getTime()
  let best: BudgetLimit | null = null
  for (const r of rows) {
    if (r.category_id !== categoryId) continue
    const eff = parseLocalDate(r.effective_month).getTime()
    if (eff > cutoff) continue
    if (!best || parseLocalDate(best.effective_month).getTime() < eff) best = r
  }
  return best
}

/** As-of resolution: the limit for `categoryId` at `month` = the monthly_limit of the row with
 *  the greatest effective_month ≤ month; 0 (unbudgeted) when there's no such row. Pure. */
export function resolveLimit(rows: BudgetLimit[], categoryId: UUID, month: Date): number {
  const row = resolveRow(rows, categoryId, month)
  return row ? Number(row.monthly_limit) : 0
}

/** As-of map categoryId→resolved limit for `month` (the value can be 0 when the in-effect row
 *  is an unbudgeted sentinel). Only categories with a row on/before `month` appear. Pure. */
export function resolveLimits(rows: BudgetLimit[], month: Date): Map<UUID, number> {
  const cutoff = firstOfMonth(month).getTime()
  const best = new Map<UUID, BudgetLimit>()
  for (const r of rows) {
    if (parseLocalDate(r.effective_month).getTime() > cutoff) continue
    const cur = best.get(r.category_id)
    if (!cur || parseLocalDate(cur.effective_month).getTime() < parseLocalDate(r.effective_month).getTime()) {
      best.set(r.category_id, r)
    }
  }
  const out = new Map<UUID, number>()
  for (const [cid, r] of best) out.set(cid, Number(r.monthly_limit))
  return out
}

/** Set a category's monthly limit at `opts.month` (default: the CURRENT month). Past months keep
 *  the row that was in effect then. Logs the prior→new resolved limit AS-OF the target month
 *  unless `opts.log === false` (undo). */
export async function saveBudget(
  categoryId: UUID,
  monthlyLimit: number,
  opts: { log?: boolean; month?: Date } = {},
): Promise<void> {
  const targetMonth = opts.month ?? new Date()
  const effectiveMonth = toISODate(firstOfMonth(targetMonth))
  // Capture the prior resolved limit as-of the target month (null = no row existed) so undo can
  // restore or remove it.
  let priorLimit: number | null = null
  if (opts.log !== false) {
    const row = resolveRow(await fetchBudgetLimits(), categoryId, targetMonth)
    priorLimit = row ? Number(row.monthly_limit) : null
  }
  const { data, error } = await supabase
    .from('budget_limits')
    .upsert(
      { category_id: categoryId, effective_month: effectiveMonth, monthly_limit: monthlyLimit },
      { onConflict: 'user_id,category_id,effective_month' },
    )
    .select('id')
    .single()
  if (error) throw error
  if (opts.log !== false) {
    void logSetBudget((data as { id: UUID }).id, categoryId, priorLimit, monthlyLimit)
  }
}

/** Remove a category's budget = write a 0 (unbudgeted) row at `opts.month` (default: the CURRENT
 *  month). Never a hard delete: dropping the row would let an older positive limit resurface.
 *  Takes the categoryId (not a row id) so both the UI and the delete_budget undo handler can call
 *  it. */
export async function deleteBudget(
  categoryId: UUID,
  opts: { log?: boolean; month?: Date } = {},
): Promise<void> {
  const targetMonth = opts.month ?? new Date()
  const effectiveMonth = toISODate(firstOfMonth(targetMonth))
  // Capture the prior resolved limit as-of the target month so undo can re-set the budget.
  let priorLimit = 0
  if (opts.log !== false) {
    priorLimit = resolveLimit(await fetchBudgetLimits(), categoryId, targetMonth)
  }
  const { error } = await supabase
    .from('budget_limits')
    .upsert(
      { category_id: categoryId, effective_month: effectiveMonth, monthly_limit: 0 },
      { onConflict: 'user_id,category_id,effective_month' },
    )
  if (error) throw error
  if (opts.log !== false) void logDeleteBudget(categoryId, priorLimit)
}
