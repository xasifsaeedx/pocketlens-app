// Activity log + one-tap Undo. A persistent, per-user feed of notable mutations,
// written by BOTH clients (iOS + web) into the same `activity_log` table — so the
// `before`/`after` JSON shapes here are a strict cross-client contract (see
// ACTIVITY_SPEC.md). Mirrors the direct-PostgREST style of data/transactions.ts.
//
// Logging is best-effort: an insert failure (e.g. the table not yet live in prod)
// is swallowed and never blocks or fails the underlying mutation. The log* helpers
// are called fire-and-forget (`void log…()`) from the instrumented data fns after
// the mutation succeeds; each fully swallows its own errors so it can't reject.

import { supabase } from '@/lib/supabase'
import { formatCurrency } from '@/lib/money'
import { displayName } from '@/types/domain'
import type { ActivityEntry, ActivityInsert, Transaction, UUID } from '@/types/domain'
import { addRule, categoryNameById, deleteRule } from './categories'
import { deleteBudget, saveBudget } from './budgets'
import {
  fetchTransactionById,
  forgetMerchant,
  learnMerchant,
  setHidden,
  updateCategory,
} from './transactions'

/** Insert one activity row. Best-effort — swallows every error (never throws), so a
 *  missing table or transient failure can't break the mutation that triggered it. */
export async function logActivity(entry: ActivityInsert): Promise<void> {
  try {
    const { error } = await supabase.from('activity_log').insert(entry)
    if (error) throw error
  } catch {
    // best-effort: the activity feed is non-critical, never block the real mutation
  }
}

/** Newest-first activity for the current user, capped at 100. Tolerates errors
 *  (e.g. table briefly absent) by returning an empty list. */
export async function fetchActivity(): Promise<ActivityEntry[]> {
  try {
    const { data, error } = await supabase
      .from('activity_log')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(100)
    if (error) throw error
    return (data ?? []) as ActivityEntry[]
  } catch {
    return []
  }
}

/** Mark an entry reverted so its Undo button disappears and it can't be undone twice. */
export async function markUndone(id: UUID): Promise<void> {
  const { error } = await supabase
    .from('activity_log')
    .update({ undone: true, undone_at: new Date().toISOString() })
    .eq('id', id)
  if (error) throw error
}

/** Apply the inverse of `entry` by dispatching on action_type to the matching data
 *  fn (called with logging OFF so undo never creates a new entry), then mark it
 *  undone. See the ACTIVITY_SPEC.md undo column for each inverse. */
export async function undoActivity(entry: ActivityEntry): Promise<void> {
  if (!entry.reversible || entry.undone) return
  switch (entry.action_type) {
    case 'categorize': {
      if (!entry.entity_id) return
      const before = entry.before as {
        category_id: UUID | null
        merchant_key?: string
        merchant_prev_category_id?: UUID | null
      } | null
      // Raw update — updateCategory skips learning + logging.
      await updateCategory(entry.entity_id, before?.category_id ?? null)
      // If this categorization taught merchant memory, un-teach it: restore the prior
      // mapping, or forget the key entirely if nothing was mapped before.
      if (before?.merchant_key) {
        if (before.merchant_prev_category_id) {
          await learnMerchant(before.merchant_key, before.merchant_prev_category_id)
        } else {
          await forgetMerchant(before.merchant_key)
        }
      }
      break
    }
    case 'hide':
    case 'unhide': {
      if (!entry.entity_id) return
      const before = entry.before as { hidden: boolean } | null
      const txn = await fetchTransactionById(entry.entity_id)
      if (!txn) return // row gone — nothing to restore
      await setHidden(txn, before?.hidden ?? false, { log: false })
      break
    }
    case 'set_budget': {
      const before = entry.before as { category_id: UUID; monthly_limit: number | null } | null
      if (!before) return
      if (before.monthly_limit != null) {
        await saveBudget(before.category_id, before.monthly_limit, { log: false })
      } else {
        // No budget existed before — write a 0 (unbudgeted) row at the current month.
        await deleteBudget(before.category_id, { log: false })
      }
      break
    }
    case 'delete_budget': {
      const before = entry.before as { category_id: UUID; monthly_limit: number } | null
      if (!before) return
      await saveBudget(before.category_id, before.monthly_limit, { log: false })
      break
    }
    case 'add_rule': {
      const after = entry.after as { id: UUID } | null
      if (after?.id) await deleteRule(after.id, { log: false })
      break
    }
    case 'delete_rule': {
      const before = entry.before as { keyword: string; category_id: UUID } | null
      if (before)
        await addRule({ keyword: before.keyword, categoryId: before.category_id }, { log: false })
      break
    }
  }
  await markUndone(entry.id)
}

// ── log builders — one per instrumented mutation. Each builds the summary from the
//    merchant/category/amount at hand, then fire-and-forgets logActivity. All errors
//    swallowed so an unawaited call can never surface an unhandled rejection. ──────

export async function logCategorize(
  txn: Transaction,
  before: UUID | null,
  after: UUID | null,
  merchantKey: string | null = null,
  merchantPrevCategoryId: UUID | null = null,
): Promise<void> {
  try {
    const merchant = displayName(txn)
    const summary = after
      ? `Categorized ${merchant} as ${await categoryNameById(after)}`
      : `Uncategorized ${merchant}`
    // Record the merchant-memory prior state only when this action taught it, so Undo
    // can restore/forget the learning.
    const beforeJson: Record<string, unknown> = { category_id: before }
    if (merchantKey) {
      beforeJson.merchant_key = merchantKey
      beforeJson.merchant_prev_category_id = merchantPrevCategoryId
    }
    await logActivity({
      action_type: 'categorize',
      entity_type: 'transaction',
      entity_id: txn.id,
      summary,
      before: beforeJson,
      after: { category_id: after },
    })
  } catch {
    /* best-effort */
  }
}

export async function logHide(
  txn: Transaction,
  wasHidden: boolean,
  hidden: boolean,
): Promise<void> {
  try {
    const merchant = displayName(txn)
    await logActivity({
      action_type: hidden ? 'hide' : 'unhide',
      entity_type: 'transaction',
      entity_id: txn.id,
      summary: hidden ? `Hid ${merchant}` : `Unhid ${merchant}`,
      before: { hidden: wasHidden },
      after: { hidden },
    })
  } catch {
    /* best-effort */
  }
}

export async function logSetBudget(
  budgetId: UUID,
  categoryId: UUID,
  beforeLimit: number | null,
  afterLimit: number,
): Promise<void> {
  try {
    const name = await categoryNameById(categoryId)
    await logActivity({
      action_type: 'set_budget',
      entity_type: 'budget',
      entity_id: budgetId,
      summary: `Set ${name} budget to ${formatCurrency(afterLimit)}`,
      before: { category_id: categoryId, monthly_limit: beforeLimit },
      after: { category_id: categoryId, monthly_limit: afterLimit },
    })
  } catch {
    /* best-effort */
  }
}

export async function logDeleteBudget(categoryId: UUID, limit: number): Promise<void> {
  try {
    const name = await categoryNameById(categoryId)
    await logActivity({
      action_type: 'delete_budget',
      entity_type: 'budget',
      entity_id: null,
      summary: `Removed ${name} budget`,
      before: { category_id: categoryId, monthly_limit: limit },
      after: null,
    })
  } catch {
    /* best-effort */
  }
}

export async function logAddRule(
  ruleId: UUID,
  keyword: string,
  categoryId: UUID,
): Promise<void> {
  try {
    const name = await categoryNameById(categoryId)
    await logActivity({
      action_type: 'add_rule',
      entity_type: 'category_rule',
      entity_id: ruleId,
      summary: `Added rule "${keyword}" → ${name}`,
      before: null,
      after: { id: ruleId, keyword, category_id: categoryId },
    })
  } catch {
    /* best-effort */
  }
}

export async function logDeleteRule(keyword: string, categoryId: UUID): Promise<void> {
  try {
    const name = await categoryNameById(categoryId)
    await logActivity({
      action_type: 'delete_rule',
      entity_type: 'category_rule',
      entity_id: null,
      summary: `Removed rule "${keyword}" → ${name}`,
      before: { keyword, category_id: categoryId },
      after: null,
    })
  } catch {
    /* best-effort */
  }
}
