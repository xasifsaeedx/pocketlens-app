// Saved views: named filter sets for the transactions list, persisted to Supabase
// (saved_views table) so they follow the user across devices. Direct PostgREST. No iOS
// mirror yet (web-first); `params` jsonb is client-owned (SavedViewParams in types/domain).

import { supabase } from '@/lib/supabase'
import type { SavedView, SavedViewParams, UUID } from '@/types/domain'

export async function fetchSavedViews(): Promise<SavedView[]> {
  const { data, error } = await supabase
    .from('saved_views')
    .select('id, name, params, created_at')
    .order('name', { ascending: true })
  if (error) throw error
  return (data ?? []) as SavedView[]
}

/** Create a named view from the current filter set. `user_id` auto-stamps via the column
 *  default; the (user_id, name) unique constraint blocks duplicate names. */
export async function createSavedView(
  name: string,
  params: SavedViewParams,
): Promise<SavedView> {
  const { data, error } = await supabase
    .from('saved_views')
    .insert({ name, params })
    .select('id, name, params, created_at')
    .single()
  if (error) throw error
  return data as SavedView
}

export async function deleteSavedView(id: UUID): Promise<void> {
  const { error } = await supabase.from('saved_views').delete().eq('id', id)
  if (error) throw error
}
