// Linked banks (plaid_items). access_token column is NOT client-readable (column grant).

import { supabase } from '@/lib/supabase'
import { warmFetch } from '@/data/backend'
import type { PlaidItem } from '@/types/domain'

const BACKEND = import.meta.env.VITE_BACKEND_URL as string

export async function fetchPlaidItems(): Promise<PlaidItem[]> {
  const { data, error } = await supabase
    .from('plaid_items')
    .select('id, plaid_item_id, institution_id, institution_name, institution_logo, last_synced_at, is_active, is_syncing, sync_started_at, last_backfill_at')
    .eq('is_active', true)
  if (error) throw error
  return (data ?? []) as PlaidItem[]
}

/** Unlink a Plaid item: calls DELETE /items/{item_id} on the backend, which
 *  invalidates the Plaid access token and deletes all linked transactions. */
export async function deleteItem(itemId: string): Promise<void> {
  const { data: sessionData } = await supabase.auth.getSession()
  const token = sessionData.session?.access_token
  if (!token) throw new Error('Not signed in')

  const res = await warmFetch(`${BACKEND}/items/${itemId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body?.detail ?? `Could not unlink bank (HTTP ${res.status})`)
  }
}
