// Mirrors PocketLens/Services/SeparateAccountService.swift — manual (non-Plaid) accounts,
// their signed value ledger, and recurring contributions.

import { supabase } from '@/lib/supabase'
import type {
  RecurringContribution,
  SeparateAccount,
  SeparateAccountValue,
  UUID,
} from '@/types/domain'

/** Active separate accounts with balance = SUM(values), ordered by display_order. */
export async function fetchSeparateAccounts(): Promise<SeparateAccount[]> {
  const { data: accts, error } = await supabase
    .from('separate_accounts')
    .select('*')
    .eq('is_active', true)
    .order('display_order', { ascending: true })
  if (error) throw error

  const { data: values, error: vErr } = await supabase
    .from('separate_account_values')
    .select('separate_account_id, amount')
  if (vErr) throw vErr

  const sums = new Map<string, number>()
  for (const v of (values ?? []) as { separate_account_id: string; amount: number }[]) {
    sums.set(v.separate_account_id, (sums.get(v.separate_account_id) ?? 0) + v.amount)
  }
  return ((accts ?? []) as SeparateAccount[]).map((a) => ({
    ...a,
    currentBalance: sums.get(a.id) ?? 0,
  }))
}

export async function createSeparateAccount(payload: {
  name: string
  type: string
  currency: string
}): Promise<SeparateAccount> {
  const { data, error } = await supabase
    .from('separate_accounts')
    .insert({ ...payload, is_active: true })
    .select()
    .single()
  if (error) throw error
  return data as SeparateAccount
}

export async function deleteSeparateAccount(id: UUID): Promise<void> {
  const { error } = await supabase.from('separate_accounts').delete().eq('id', id)
  if (error) throw error
}

export async function fetchValues(accountId: UUID): Promise<SeparateAccountValue[]> {
  const { data, error } = await supabase
    .from('separate_account_values')
    .select('*')
    .eq('separate_account_id', accountId)
    .order('date', { ascending: false })
  if (error) throw error
  return (data ?? []) as SeparateAccountValue[]
}

export async function addValue(payload: {
  separate_account_id: UUID
  date: string
  amount: number
  note: string | null
}): Promise<void> {
  const { error } = await supabase.from('separate_account_values').insert(payload)
  if (error) throw error
}

export async function fetchContributions(
  accountId: UUID,
): Promise<RecurringContribution[]> {
  const { data, error } = await supabase
    .from('recurring_contributions')
    .select('*')
    .eq('separate_account_id', accountId)
  if (error) throw error
  return (data ?? []) as RecurringContribution[]
}

export async function addContribution(payload: {
  separate_account_id: UUID
  delta_balance: number
  frequency_in_days: number
  anchor_date: string
}): Promise<void> {
  const { error } = await supabase
    .from('recurring_contributions')
    .insert({ ...payload, is_active: true })
  if (error) throw error
}

export async function deleteContribution(id: UUID): Promise<void> {
  const { error } = await supabase.from('recurring_contributions').delete().eq('id', id)
  if (error) throw error
}
