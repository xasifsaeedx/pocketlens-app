// Mirrors PocketLens/Services/AccountService.swift.

import { supabase } from '@/lib/supabase'
import { warmFetch } from '@/data/backend'

const BACKEND = import.meta.env.VITE_BACKEND_URL as string
import type { Account, CurrentNetWorth } from '@/types/domain'

export async function fetchAccounts(): Promise<Account[]> {
  const { data, error } = await supabase
    .from('accounts')
    .select('*')
    .eq('is_active', true)
    .order('display_order', { ascending: true })
  if (error) throw error
  return (data ?? []) as Account[]
}

/** Accounts with most-recent balance per account. */
export async function fetchAccountsWithLatestBalance(): Promise<Account[]> {
  const accounts = await fetchAccounts()
  // latest_balances = newest non-null-balance row per account, so no full-history scan.
  const { data, error } = await supabase
    .from('latest_balances')
    .select('account_id, current_balance')
  if (error) throw error

  const rows = (data ?? []) as { account_id: string; current_balance: number }[]
  const balanceByAccount = new Map(rows.map((r) => [r.account_id, r.current_balance]))
  for (const a of accounts) {
    a.currentBalance = balanceByAccount.get(a.id) ?? null
  }
  return accounts
}

/** Live net worth (+ its "as of" date) from the current_net_worth view — same math
 *  as the snapshot writer. Null for a user with no accounts yet. */
export async function fetchCurrentNetWorth(): Promise<CurrentNetWorth | null> {
  const { data, error } = await supabase
    .from('current_net_worth')
    .select('net_worth, total_assets, total_liabilities, as_of')
    .maybeSingle()
  if (error) throw error
  return data as CurrentNetWorth | null
}

/** Soft-delete a single Plaid account. Sets is_active = false so it stops
 *  appearing in balances and syncs, but leaves transactions intact.
 *  The institution link (plaid_items row) is NOT removed — other accounts
 *  under the same institution continue syncing normally. */
export async function hideAccount(accountId: string): Promise<void> {
  const { error } = await supabase
    .from('accounts')
    .update({ is_active: false })
    .eq('id', accountId)
  if (error) throw error
}

/** Change an account's `type` (depository | credit | investment | loan | other).
 *  Mirrors iOS AccountService.patchAccount(id:type:). */
export async function patchAccountType(accountId: string, type: string): Promise<void> {
  const { error } = await supabase
    .from('accounts')
    .update({ type })
    .eq('id', accountId)
  if (error) throw error
}

/** Most-recent reported balance row for one account from `latest_balances`.
 *  Mirrors iOS AccountService.fetchLatestBalance(accountId:). */
export interface LatestBalance {
  current_balance: number | null
  available_balance: number | null
  date: string | null
}

export async function fetchLatestBalance(accountId: string): Promise<LatestBalance | null> {
  const { data, error } = await supabase
    .from('latest_balances')
    .select('current_balance, available_balance, date')
    .eq('account_id', accountId)
    .maybeSingle()
  if (error) throw error
  return data as LatestBalance | null
}

/** Hard-delete an account and (FK cascade) its transactions. Transfer legs on OTHER
 *  accounts that shared a deleted txn's group are unlinked first so they survive as
 *  normal (non-transfer) transactions. Mirrors iOS AccountService.deleteAccount(id:). */
export async function deleteAccount(accountId: string): Promise<void> {
  // Find all transfer groups that have a leg on this account.
  const { data: groupRows, error: groupErr } = await supabase
    .from('transactions')
    .select('transfer_group_id')
    .eq('account_id', accountId)
    .not('transfer_group_id', 'is', null)
  if (groupErr) throw groupErr

  const groupIds = [
    ...new Set(
      (groupRows ?? [])
        .map((r: { transfer_group_id: string | null }) => r.transfer_group_id)
        .filter((id): id is string => id != null),
    ),
  ]

  if (groupIds.length > 0) {
    // Re-include the surviving legs in totals (hidden legs stay excluded).
    const { error: e1 } = await supabase
      .from('transactions')
      .update({ exclude_from_totals: false })
      .in('transfer_group_id', groupIds)
      .neq('account_id', accountId)
      .eq('hidden', false)
    if (e1) throw e1

    // Clear the transfer link so they read as normal transactions.
    const { error: e2 } = await supabase
      .from('transactions')
      .update({ transfer_group_id: null, transfer_kind: null })
      .in('transfer_group_id', groupIds)
      .neq('account_id', accountId)
    if (e2) throw e2
  }

  // Delete the account; FK cascade removes its transactions.
  const { error: delErr } = await supabase
    .from('accounts')
    .delete()
    .eq('id', accountId)
  if (delErr) throw delErr
}

/** Permanently delete the signed-in user's entire account and all their data.
 *  Calls DELETE /account on the backend, which uses the service-role admin API
 *  to delete the auth.users row — cascading to every user-owned table
 *  (transactions, categories, budgets, etc.) via the on-delete-cascade FKs
 *  added in 20260704000000_multi_user.sql. This is irreversible. */
export async function deleteMyAccount(): Promise<void> {
  const { data } = await supabase.auth.getSession()
  const token = data.session?.access_token
  if (!token) throw new Error('Not signed in')
  const res = await warmFetch(`${BACKEND}/account`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Account deletion failed: HTTP ${res.status}${text ? ` — ${text}` : ''}`)
  }
}
