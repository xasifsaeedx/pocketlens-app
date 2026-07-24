// Helpers for the local-stack e2e specs (signup/isolation/wizard). These run
// against `supabase start` + sync-service :8000 + vite :5173 — never prod.
// Env comes from e2e/run-local.sh; specs skip themselves when it's absent.

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { expect, type Page } from '@playwright/test'

export const HAS_LOCAL_STACK = !!process.env.E2E_SERVICE_ROLE_KEY && !!process.env.E2E_ANON_KEY

export const SUPABASE_URL = process.env.E2E_SUPABASE_URL ?? 'http://127.0.0.1:54321'
export const BACKEND_URL = process.env.E2E_BACKEND_URL ?? 'http://localhost:8000'

// Refuse to run the destructive/seeding helpers against anything non-local.
function assertLocal() {
  if (!/127\.0\.0\.1|localhost/.test(SUPABASE_URL)) {
    throw new Error(`E2E_SUPABASE_URL must be a local stack, got ${SUPABASE_URL}`)
  }
}

let _admin: SupabaseClient | undefined
export function admin(): SupabaseClient {
  assertLocal()
  _admin ??= createClient(SUPABASE_URL, process.env.E2E_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false },
  })
  return _admin
}

// Unique per run so re-runs never collide with leftover rows.
export const RUN = Date.now().toString(36)
export const OWNER = { email: `owner-${RUN}@e2e.local`, password: 'e2e-owner-pass-1!' }
export const FRIEND = { email: `friend-${RUN}@e2e.local`, password: 'e2e-friend-pass-2!' }

// Distinctive strings we assert on (and assert the ABSENCE of, cross-account).
export const OWNER_TXN = `OWNER-SECRET-COFFEE-${RUN}`
export const OWNER_ACCOUNT = `Owner Checking E2E ${RUN}`

// Smoke uses its own user + fixtures so it never collides with the isolation
// suite's OWNER (both run in one Playwright process, sharing this module's RUN).
export const SMOKE = { email: `smoke-${RUN}@e2e.local`, password: 'e2e-smoke-pass-3!' }
export const SMOKE_TXN = `SMOKE-SEEDED-COFFEE-${RUN}`
export const SMOKE_ACCOUNT = `Smoke Checking E2E ${RUN}`

export async function createUser(user: { email: string; password: string }): Promise<string> {
  const { data, error } = await admin().auth.admin.createUser({
    email: user.email,
    password: user.password,
    email_confirm: true,
  })
  if (error) throw error
  return data.user.id
}

// Seed one checking account + three txns for a user. `opts` lets a second caller
// (e.g. the smoke suite) seed a distinct, non-colliding fixture in the same run —
// plaid ids are keyed by `keySuffix` so the unique constraints don't clash.
export async function seedOwnerData(
  userId: string,
  opts: { keySuffix?: string; accountName?: string; txnMarker?: string } = {},
): Promise<void> {
  const db = admin()
  const suffix = opts.keySuffix ? `-${opts.keySuffix}` : ''
  const accountName = opts.accountName ?? OWNER_ACCOUNT
  const txnMarker = opts.txnMarker ?? OWNER_TXN
  const { data: acct, error: acctErr } = await db
    .from('accounts')
    .insert({
      plaid_account_id: `e2e-acct${suffix}-${RUN}`,
      name: accountName,
      type: 'depository',
      subtype: 'checking',
      user_id: userId,
    })
    .select()
    .single()
  if (acctErr) throw acctErr

  const { error: txnErr } = await db.from('transactions').insert(
    [1, 2, 3].map((i) => ({
      plaid_transaction_id: `e2e-txn${suffix}-${RUN}-${i}`,
      account_id: acct.id,
      date: '2026-07-01',
      amount: 4.5 + i,
      merchant_name: txnMarker,
      description: `${txnMarker} #${i}`,
      user_id: userId,
    })),
  )
  if (txnErr) throw txnErr
}

// 24-hex client_id, unique per run (backend caches Plaid clients by client_id).
export const FAKE_CLIENT_ID = Date.now().toString(16).padStart(24, 'a').slice(0, 24)

export async function seedPlaidCredentials(userId: string): Promise<void> {
  // Non-Fernet secret: vault.decrypt() passes legacy plaintext through, so the
  // backend can read this row without sharing the CREDENTIALS_ENC_KEY here.
  const { error } = await admin().from('plaid_credentials').insert({
    user_id: userId,
    plaid_client_id: FAKE_CLIENT_ID,
    plaid_secret_enc: 'e2e-plaintext-secret',
    plaid_env: 'production',
  })
  if (error) throw error
}

export async function accessTokenFor(user: { email: string; password: string }): Promise<string> {
  const client = createClient(SUPABASE_URL, process.env.E2E_ANON_KEY!, {
    auth: { persistSession: false },
  })
  const { data, error } = await client.auth.signInWithPassword(user)
  if (error) throw error
  return data.session!.access_token
}

export async function signInViaUI(page: Page, user: { email: string; password: string }) {
  // Logged out, `/` is the demo landing page — the sign-in form lives at /login.
  await page.goto('/login')
  await page.getByLabel('Email').fill(user.email)
  await page.getByLabel('Password', { exact: true }).fill(user.password)
  await page.getByRole('button', { name: 'Sign In' }).click()
  await expect(page.getByText('Net Worth').first()).toBeVisible({ timeout: 20_000 })
}
