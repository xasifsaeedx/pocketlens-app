// Per-user Plaid developer credentials (BYO account pilot). All three calls go
// to the Render backend, which validates against Plaid and encrypts the secret
// before storage — the secret never touches Supabase in plaintext and is never
// readable back from here.

import { supabase } from '@/lib/supabase'

const BACKEND = import.meta.env.VITE_BACKEND_URL as string

export interface PlaidCredentialsStatus {
  configured: boolean
  client_id_masked?: string
  env?: 'sandbox' | 'production'
  items_used?: number
  item_limit?: number
}

async function authHeader(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession()
  const token = data.session?.access_token
  if (!token) throw new Error('Not signed in')
  return { Authorization: `Bearer ${token}` }
}

async function parseError(res: Response, fallback: string): Promise<never> {
  const detail = await res
    .json()
    .then((b) => b?.detail as string | undefined)
    .catch(() => undefined)
  throw new Error(detail ?? `${fallback}: HTTP ${res.status}`)
}

export async function getPlaidCredentialsStatus(): Promise<PlaidCredentialsStatus> {
  const res = await fetch(`${BACKEND}/credentials`, { headers: await authHeader() })
  if (!res.ok) return parseError(res, 'Could not load Plaid credentials')
  return res.json()
}

export async function savePlaidCredentials(input: {
  client_id: string
  secret: string
  env: 'sandbox' | 'production'
}): Promise<PlaidCredentialsStatus> {
  const res = await fetch(`${BACKEND}/credentials`, {
    method: 'POST',
    headers: { ...(await authHeader()), 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  if (!res.ok) return parseError(res, 'Could not save Plaid credentials')
  return res.json()
}

export async function deletePlaidCredentials(): Promise<void> {
  const res = await fetch(`${BACKEND}/credentials`, {
    method: 'DELETE',
    headers: await authHeader(),
  })
  if (!res.ok) return parseError(res, 'Could not remove Plaid credentials')
}
