// Group budget limits — mirrors data/budgets.ts in structure but keyed on group_id.
//
// Effective-dating contract (identical to budget_limits):
//   The limit in effect for a group at month M = the row with the greatest
//   effective_month ≤ M. monthly_limit = 0 is the "explicitly unbudgeted"
//   sentinel; a hard delete would let an older positive row resurface.
//
// Floor rules (enforced by callers, not this layer):
//   1. All categories in group have budgets  → auto-suggest Σ, user may raise freely.
//   2. Some categories have budgets          → groupLimit ≥ Σ budgeted category limits.
//   3. No categories have budgets            → free entry, no floor.

import { supabase } from '@/lib/supabase'
import { parseLocalDate, toISODate } from '@/lib/dates'
import type { GroupBudgetLimit, UUID } from '@/types/domain'

function firstOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1)
}

export async function fetchGroupBudgetLimits(): Promise<GroupBudgetLimit[]> {
  const { data, error } = await supabase
    .from('group_budget_limits')
    .select('*')
    .order('effective_month', { ascending: true })
  if (error) throw error
  return (data ?? []) as GroupBudgetLimit[]
}

/** As-of resolver: the limit for `groupId` at `month` = monthly_limit of the row with the
 *  greatest effective_month ≤ month; 0 when no such row exists (unbudgeted). Pure. */
export function resolveGroupLimit(
  rows: GroupBudgetLimit[],
  groupId: UUID,
  month: Date,
): number {
  const cutoff = firstOfMonth(month).getTime()
  let best: GroupBudgetLimit | null = null
  for (const r of rows) {
    if (r.group_id !== groupId) continue
    const eff = parseLocalDate(r.effective_month).getTime()
    if (eff > cutoff) continue
    if (!best || parseLocalDate(best.effective_month).getTime() < eff) best = r
  }
  return best ? Number(best.monthly_limit) : 0
}

/** As-of map groupId → resolved limit for `month`. Only groups with a row on/before
 *  `month` appear (value may be 0 for the unbudgeted sentinel). Pure. */
export function resolveGroupLimits(
  rows: GroupBudgetLimit[],
  month: Date,
): Map<UUID, number> {
  const cutoff = firstOfMonth(month).getTime()
  const best = new Map<UUID, GroupBudgetLimit>()
  for (const r of rows) {
    if (parseLocalDate(r.effective_month).getTime() > cutoff) continue
    const cur = best.get(r.group_id)
    if (
      !cur ||
      parseLocalDate(cur.effective_month).getTime() <
        parseLocalDate(r.effective_month).getTime()
    ) {
      best.set(r.group_id, r)
    }
  }
  const out = new Map<UUID, number>()
  for (const [gid, r] of best) out.set(gid, Number(r.monthly_limit))
  return out
}

/** Upsert a group's monthly limit at `opts.month` (default: current month).
 *  Other months keep whatever row was in effect then. */
export async function saveGroupBudget(
  groupId: UUID,
  monthlyLimit: number,
  opts: { month?: Date } = {},
): Promise<void> {
  const effectiveMonth = toISODate(firstOfMonth(opts.month ?? new Date()))
  const { error } = await supabase
    .from('group_budget_limits')
    .upsert(
      { group_id: groupId, effective_month: effectiveMonth, monthly_limit: monthlyLimit },
      { onConflict: 'user_id,group_id,effective_month' },
    )
  if (error) throw error
}

/** Remove a group's budget = write a 0 sentinel at `opts.month` (default: current month).
 *  Never a hard delete — deleting would let an older positive row resurface. */
export async function deleteGroupBudget(
  groupId: UUID,
  opts: { month?: Date } = {},
): Promise<void> {
  const effectiveMonth = toISODate(firstOfMonth(opts.month ?? new Date()))
  const { error } = await supabase
    .from('group_budget_limits')
    .upsert(
      { group_id: groupId, effective_month: effectiveMonth, monthly_limit: 0 },
      { onConflict: 'user_id,group_id,effective_month' },
    )
  if (error) throw error
}
