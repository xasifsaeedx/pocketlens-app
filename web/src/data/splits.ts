// Transaction splits CRUD, direct PostgREST. A split replaces the txn's single category
// for reporting; the split editor guarantees amounts sum to the txn amount. No iOS mirror
// yet (web-first); the schema is shared so iOS can adopt it later unchanged.

import { supabase } from '@/lib/supabase'
import type { UUID } from '@/types/domain'

export interface SplitInput {
  category_id: UUID
  amount: number
}

/** Balanced-to-the-cent tolerance for split sums (rounds away float noise). */
export const SPLIT_EPS = 0.005

export interface SplitLeg {
  category_id: UUID | ''
  amount: number
}

/** Validate a proposed split before it can be saved. Beyond "sums to the txn amount" this
 *  enforces two invariants the DB does not: every leg must share the transaction's sign, and
 *  categories must be distinct. A leg of the opposite sign passes the sum trigger but is
 *  silently dropped by the `category_spend` view (`amount > 0`), overcounting spend. */
export function evaluateSplit(
  txnAmount: number,
  legs: SplitLeg[],
): { canSave: boolean; remainder: number; error: string | null } {
  const sum = legs.reduce((s, l) => s + (Number.isFinite(l.amount) ? l.amount : 0), 0)
  const remainder = txnAmount - sum

  if (legs.length < 2) return { canSave: false, remainder, error: null }

  const complete = legs.every(
    (l) => l.category_id !== '' && Number.isFinite(l.amount) && l.amount !== 0,
  )
  if (!complete) return { canSave: false, remainder, error: null }

  const sign = Math.sign(txnAmount)
  if (!legs.every((l) => Math.sign(l.amount) === sign))
    return { canSave: false, remainder, error: 'Each split must have the same sign as the transaction.' }

  const cats = legs.map((l) => l.category_id)
  if (new Set(cats).size !== cats.length)
    return { canSave: false, remainder, error: 'Each split must use a different category.' }

  if (Math.abs(remainder) >= SPLIT_EPS) return { canSave: false, remainder, error: null }

  return { canSave: true, remainder, error: null }
}

/** Replace all splits for a transaction. Empty `splits` just clears them (un-split).
 *  Clearing category_id too: a split txn has no single category. */
export async function setSplits(transactionId: UUID, splits: SplitInput[]): Promise<void> {
  const del = await supabase
    .from('transaction_splits')
    .delete()
    .eq('transaction_id', transactionId)
  if (del.error) throw del.error

  if (splits.length > 0) {
    const ins = await supabase.from('transaction_splits').insert(
      splits.map((s) => ({
        transaction_id: transactionId,
        category_id: s.category_id,
        amount: s.amount,
      })),
    )
    if (ins.error) throw ins.error
  }

  // A split txn's own category_id would double-report; null it (or leave null when cleared).
  const upd = await supabase
    .from('transactions')
    .update({ category_id: null })
    .eq('id', transactionId)
  if (upd.error) throw upd.error
}
