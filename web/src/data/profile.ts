// Profile (first/last name) CRUD, direct PostgREST. The profiles row is 1:1 with the
// auth user (id IS the auth user id), so RLS `id = auth.uid()` scopes every read/write to
// the caller — no user_id is ever passed. The signup trigger seeds the row; clients here
// only read and update the name. Schema is shared so iOS can adopt it unchanged.

import { supabase } from '@/lib/supabase'
import type { Profile } from '@/types/domain'

/** The caller's own profile, or null if the row doesn't exist yet (maybeSingle). */
export async function fetchMyProfile(): Promise<Profile | null> {
  const { data, error } = await supabase.from('profiles').select('*').maybeSingle()
  if (error) throw error
  return (data ?? null) as Profile | null
}

/** Update the caller's first/last name. Upserts on `id` so it also self-heals if the
 *  trigger-seeded row is somehow missing (id comes from the authenticated user). */
export async function updateMyProfile(
  patch: { first_name: string | null; last_name: string | null },
): Promise<Profile> {
  const { data: auth } = await supabase.auth.getUser()
  const id = auth.user?.id
  if (!id) throw new Error('Not signed in')
  const { data, error } = await supabase
    .from('profiles')
    .upsert({ id, ...patch }, { onConflict: 'id' })
    .select()
    .single()
  if (error) throw error
  return data as Profile
}
