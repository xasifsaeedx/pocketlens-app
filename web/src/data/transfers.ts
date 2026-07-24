// Transfers: link two transactions (opposite legs of the same money moving between the
// user's accounts) into a shared transfer_group_id and exclude both from totals.
//
// Three tiers write this shape:
//   - the sync service auto-links pairs with a Plaid transfer signal (kind 'auto') and
//     excludes lone signal legs whose counterpart account isn't connected ('one_sided');
//   - findTransferSuggestions surfaces the fuzzy tier the sync refuses (amount match but
//     no Plaid signal, or ambiguous ties) for one-click confirmation. The matching lives
//     in the suggest_transfers RPC (migration 20260718140418_suggest_transfers.sql) —
//     the single matcher for every client, replacing the old local pairSuggestions;
//   - linkTransfer/unlinkTransfer stay as the manual escape hatch. Unlink/dismiss set
//     transfer_opt_out so auto-detection never re-links a row the user pulled out.
// No iOS mirror yet (web-first); schema AND the suggestions RPC are shared, so an iOS
// port adopts both unchanged.

import { supabase } from '@/lib/supabase'
import { monthBounds, parseLocalDate, toISODate } from '@/lib/dates'
import type { Account, Transaction, UUID } from '@/types/domain'

const SELECT = '*, categories(*), transaction_tags(tag_id, tags(*))'

// Amounts are numeric(·,2); half a cent tolerates any rounding drift while still requiring
// the two legs to be the same value. Mirrors sync-service/transfers.py EPS/WINDOW_DAYS.
const EPS = 0.005

/** Default +/- day window for match-candidate detection (posting/settlement lag). */
export const DEFAULT_WINDOW_DAYS = 5

/** How far back the suggestions pass scans. */
export const SUGGESTION_LOOKBACK_DAYS = 60

function shiftISO(dateStr: string, deltaDays: number): string {
  const d = parseLocalDate(dateStr)
  d.setDate(d.getDate() + deltaDays)
  return toISODate(d)
}

/** Is `candidate` a valid opposite leg for `txn`? Opposite/equal amount (nets to zero) and a
 *  different account. The date-window and not-already-linked constraints are applied in the
 *  query; this is the per-row predicate the query can't express. Exported for testing. */
export function isTransferMatch(txn: Transaction, candidate: Transaction): boolean {
  return candidate.account_id !== txn.account_id && Math.abs(candidate.amount + txn.amount) < EPS
}

/** Candidate opposite legs for `txn`: unlinked (or a one-sided leg waiting for its
 *  counterpart), within `windowDays` of it, a different account, and the exact opposite
 *  amount. Newest first. Opted-out rows stay eligible — opt-out blocks auto only. */
export async function findTransferCandidates(
  txn: Transaction,
  windowDays = DEFAULT_WINDOW_DAYS,
): Promise<Transaction[]> {
  const lo = shiftISO(txn.effective_date, -windowDays)
  const hi = shiftISO(txn.effective_date, windowDays)
  const { data, error } = await supabase
    .from('transactions')
    .select(SELECT)
    .gte('effective_date', lo)
    .lte('effective_date', hi)
    .or('transfer_group_id.is.null,transfer_kind.eq.one_sided')
    .neq('id', txn.id)
    .order('effective_date', { ascending: false })
  if (error) throw error
  const rows = (data ?? []) as unknown as Transaction[]
  return rows.filter((r) => isTransferMatch(txn, r))
}

/** Link two legs into a transfer group and exclude both from totals. Reuses a leg's
 *  existing one-sided group (upgrading it in place) and clears any prior opt-out —
 *  an explicit link always wins. Returns the group id. */
export async function linkTransfer(a: Transaction, b: Transaction): Promise<UUID> {
  const groupId = a.transfer_group_id ?? b.transfer_group_id ?? crypto.randomUUID()
  const { error } = await supabase
    .from('transactions')
    .update({
      transfer_group_id: groupId,
      transfer_kind: 'manual',
      transfer_opt_out: false,
      exclude_from_totals: true,
    })
    .in('id', [a.id, b.id])
  if (error) throw error
  return groupId
}

/** Unlink an entire transfer group: clear the group, re-include the legs in totals
 *  (hidden legs stay excluded — hiding is orthogonal), and record the user's "not a
 *  transfer" so auto-detection never re-links them. Also the undo for a one-sided
 *  false positive (single-row group). */
export async function unlinkTransfer(groupId: UUID): Promise<void> {
  const { error: e1 } = await supabase
    .from('transactions')
    .update({ exclude_from_totals: false })
    .eq('transfer_group_id', groupId)
    .eq('hidden', false)
  if (e1) throw e1
  const { error: e2 } = await supabase
    .from('transactions')
    .update({ transfer_group_id: null, transfer_kind: null, transfer_opt_out: true })
    .eq('transfer_group_id', groupId)
  if (e2) throw e2
}

/** A proposed pair the sync's auto-detector declined (no Plaid signal, or ambiguous). */
export interface TransferSuggestion {
  out: Transaction // money leaving (amount > 0)
  in: Transaction // money arriving (amount < 0)
}

/** Recent unlinked, posted, visible, non-opted-out rows paired into suggestions by the
 *  suggest_transfers RPC — the shared matcher (greedy: opposite amount, different
 *  account, ≤ 5 days apart, closest date wins, ambiguous ties skipped). Plain columns
 *  only — the embedded category/tag relations are never rendered here. */
export async function findTransferSuggestions(
  lookbackDays = SUGGESTION_LOOKBACK_DAYS,
): Promise<TransferSuggestion[]> {
  const { data, error } = await supabase.rpc('suggest_transfers', {
    p_lookback_days: lookbackDays,
  })
  if (error) throw error
  const rows = (data ?? []) as { out_txn: Transaction; in_txn: Transaction }[]
  return rows.map((r) => ({ out: r.out_txn, in: r.in_txn }))
}

/** Transfer groups with a leg touching the month, as {groupId → legs} (legs newest
 *  first). Fetched in two steps — month legs, then ALL legs of those groups — because
 *  a pair can straddle a month boundary (legs up to WINDOW_DAYS apart) and a group
 *  missing its other leg would mis-render as one-sided. */
export async function fetchTransferGroups(month: Date): Promise<Map<UUID, Transaction[]>> {
  const { start, end } = monthBounds(month)
  const { data, error } = await supabase
    .from('transactions')
    .select('transfer_group_id')
    .gte('effective_date', start)
    .lte('effective_date', end)
    .not('transfer_group_id', 'is', null)
  if (error) throw error
  const ids = [...new Set((data ?? []).map((r) => r.transfer_group_id as UUID))]
  if (ids.length === 0) return new Map()

  const { data: legs, error: e2 } = await supabase
    .from('transactions')
    .select(SELECT)
    .in('transfer_group_id', ids)
    .order('effective_date', { ascending: false })
  if (e2) throw e2
  const groups = new Map<UUID, Transaction[]>()
  for (const t of (legs ?? []) as unknown as Transaction[]) {
    const g = t.transfer_group_id as UUID
    groups.set(g, [...(groups.get(g) ?? []), t])
  }
  return groups
}

/** Fetch all legs of a transfer group by its group id. Used to render the from→to
 *  route in a single-transaction detail view where only one leg is in scope. */
export async function fetchTransferGroupLegs(groupId: UUID): Promise<Transaction[]> {
  const { data, error } = await supabase
    .from('transactions')
    .select(SELECT)
    .eq('transfer_group_id', groupId)
    .order('effective_date', { ascending: false })
  if (error) throw error
  return (data ?? []) as unknown as Transaction[]
}

/** "Not a transfer": opt both rows out of auto-detection and suggestions. (Manual
 *  linking stays possible and clears the flag.) */
export async function dismissSuggestion(a: Transaction, b: Transaction): Promise<void> {
  const { error } = await supabase
    .from('transactions')
    .update({ transfer_opt_out: true })
    .in('id', [a.id, b.id])
  if (error) throw error
}

/** Readable description of one transfer group, e.g. "Paid credit card · Chase Checking
 *  → Freedom Card" or "Moved to external (Robinhood)". Pure; exported for testing. */
export interface TransferGroupSummary {
  kind: 'card_payment' | 'move' | 'one_sided'
  amount: number // always positive
  date: string // latest leg's effective_date
  from: string | null // account name money left (null = external)
  to: string | null // account name money arrived (null = external)
  external: string | null // merchant/description label for the one-sided side
}

export function summarizeTransferGroup(
  legs: Transaction[],
  accountsById: Map<UUID, Account>,
): TransferGroupSummary {
  const name = (id: UUID) => accountsById.get(id)?.name ?? 'Unknown account'
  const out = legs.find((l) => l.amount > 0)
  const inn = legs.find((l) => l.amount < 0)
  const date = legs[0]?.effective_date ?? ''

  if (out && inn) {
    const isCardPayment =
      accountsById.get(inn.account_id)?.type === 'credit' ||
      legs.some((l) => l.plaid_category === 'LOAN_PAYMENTS')
    return {
      kind: isCardPayment ? 'card_payment' : 'move',
      amount: out.amount,
      date,
      from: name(out.account_id),
      to: name(inn.account_id),
      external: null,
    }
  }
  const leg = (out ?? inn)!
  return {
    kind: 'one_sided',
    amount: Math.abs(leg.amount),
    date,
    from: out ? name(out.account_id) : null,
    to: inn ? name(inn.account_id) : null,
    external: leg.merchant_name || leg.description || 'external account',
  }
}
