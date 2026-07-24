// Alerts & push-notifications data layer (Phase A), direct PostgREST. No user_id is
// ever passed — RLS + the columns' `default auth.uid()` scope every row to the caller.
// Backend evaluation writes `notifications` as service_role; clients here only read/mark-read/
// delete their own, manage prefs, and register device tokens. iOS mirror lands in a later phase.

import { supabase } from '@/lib/supabase'
import type { AppNotification, DeviceToken, NotificationPref, UUID } from '@/types/domain'

export async function fetchNotifications(): Promise<AppNotification[]> {
  const { data, error } = await supabase
    .from('notifications')
    .select('*')
    .order('created_at', { ascending: false })
  if (error) throw error
  return (data ?? []) as AppNotification[]
}

export async function markNotificationRead(id: UUID): Promise<void> {
  const { error } = await supabase
    .from('notifications')
    .update({ read_at: new Date().toISOString() })
    .eq('id', id)
  if (error) throw error
}

export async function markAllNotificationsRead(): Promise<void> {
  const { error } = await supabase
    .from('notifications')
    .update({ read_at: new Date().toISOString() })
    .is('read_at', null)
  if (error) throw error
}

export async function deleteNotification(id: UUID): Promise<void> {
  const { error } = await supabase.from('notifications').delete().eq('id', id)
  if (error) throw error
}

export async function deleteAllNotifications(): Promise<void> {
  const { error } = await supabase
    .from('notifications')
    .delete()
    .not('id', 'is', null) // matches all rows; RLS scopes to the signed-in user
  if (error) throw error
}

export async function fetchNotificationPrefs(): Promise<NotificationPref[]> {
  const { data, error } = await supabase.from('notification_prefs').select('*')
  if (error) throw error
  return (data ?? []) as NotificationPref[]
}

/** Create or update the preference for one alert type (unique per user,type). */
export async function upsertNotificationPref(
  pref: Partial<NotificationPref> & { type: string },
): Promise<NotificationPref> {
  const { data, error } = await supabase
    .from('notification_prefs')
    .upsert(pref, { onConflict: 'user_id,type' })
    .select()
    .single()
  if (error) throw error
  return data as NotificationPref
}

/** Register (or refresh) an APNs device token for push. Included for completeness — web
 *  doesn't push, but the shared schema + data layer let iOS adopt it unchanged later. */
export async function registerDeviceToken(token: string): Promise<DeviceToken> {
  const { data, error } = await supabase
    .from('device_tokens')
    .upsert({ token, updated_at: new Date().toISOString() }, { onConflict: 'user_id,token' })
    .select()
    .single()
  if (error) throw error
  return data as DeviceToken
}
