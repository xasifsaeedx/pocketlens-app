// Mirrors PocketLens/Services/SyncService.swift + AccountLinking.swift (Plaid).
// The only two calls that go to the Render backend instead of Supabase.

import { supabase } from '@/lib/supabase'
import { warmFetch } from '@/data/backend'

const BACKEND = import.meta.env.VITE_BACKEND_URL as string

async function accessToken(): Promise<string> {
  const { data } = await supabase.auth.getSession()
  const token = data.session?.access_token
  if (!token) throw new Error('Not signed in')
  return token
}

/** Kick off a Plaid sync for the signed-in user. Returns immediately (backend runs async). */
export async function triggerSync(): Promise<void> {
  const token = await accessToken()
  // warmFetch rides out the backend's cold start — /sync/trigger only kicks off an
  // async job, so retrying a dropped/502 first hit is safe (see backend.ts).
  const res = await warmFetch(`${BACKEND}/sync/trigger`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) throw new Error(`Sync failed: HTTP ${res.status}`)
}

/** Reset the cursor for a newly-linked item and kick off a full historical sync. */
export async function requestBackfill(itemId: string): Promise<void> {
  const token = await accessToken()
  const res = await warmFetch(`${BACKEND}/backfill/${encodeURIComponent(itemId)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) throw new Error(`Backfill failed: HTTP ${res.status}`)
}

/** Result of a full sync request. `cooldown` means the user full-synced too
 *  recently; `next_at` is when the next one is allowed (ISO-8601). */
export type BackfillAllResult =
  | { status: 'ok'; items: number }
  | { status: 'cooldown'; next_at: string }

/** Full sync: reset every linked bank's cursor and re-pull the full 730-day
 *  window. Rate-limited server-side — a 429 resolves to a `cooldown` result
 *  (not thrown) so the caller can surface when the next full sync is available. */
export async function backfillAll(): Promise<BackfillAllResult> {
  const token = await accessToken()
  const res = await warmFetch(`${BACKEND}/backfill-all`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  })
  if (res.status === 429) {
    const body = (await res.json().catch(() => ({}))) as { next_at?: string }
    return { status: 'cooldown', next_at: body.next_at ?? '' }
  }
  if (!res.ok) throw new Error(`Full sync failed: HTTP ${res.status}`)
  const body = (await res.json()) as { items?: number }
  return { status: 'ok', items: body.items ?? 0 }
}

/** URL of the backend-hosted Plaid Link page, tied to this user via their access token.
 *  Open in a new tab/popup (iOS opens it in a Safari sheet). */
export async function plaidLinkUrl(): Promise<string> {
  return backendPageUrl('link')
}

/** URL of the backend-hosted guided Plaid onboarding wizard (BYO developer account). */
export async function plaidOnboardUrl(): Promise<string> {
  return backendPageUrl('onboard')
}

/** URL of the hosted Plaid Link page in *update mode* for an existing item, to
 *  repair a broken connection (re-auth / new MFA). The hosted shell parses
 *  `item_id` from the fragment, and on success postMessages a PLAID_LINK_SUCCESS
 *  with no `new_account` field. Open via openWarmTab like plaidLinkUrl. */
export async function plaidReconnectUrl(itemId: string): Promise<string> {
  return backendPageUrl('link', `&item_id=${encodeURIComponent(itemId)}`)
}

async function backendPageUrl(path: string, extraHash = ''): Promise<string> {
  const token = await accessToken()
  const u = new URL(`${BACKEND}/${path}`)
  // Token goes in the URL fragment, not a query param: the browser never sends
  // the fragment to the server or leaks it via proxy logs / Referer.
  // The hosted page's JS reads it from location.hash.
  u.hash = `access_token=${encodeURIComponent(token)}${extraHash}`
  return u.toString()
}
