import { createClient } from '@supabase/supabase-js'
import { isDemoMode } from '@/demo/demoMode'

// Same Supabase project as the iOS app. The anon key is safe in the browser bundle —
// Row Level Security scopes every row to the signed-in user (user_id = auth.uid()),
// exactly as the iOS app relies on (PocketLens/Config/Supabase.swift).
const url = import.meta.env.VITE_SUPABASE_URL as string
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string

if (!url || !anonKey) {
  // Surface a clear error instead of a cryptic network failure later.
  throw new Error(
    'Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY. Copy web/.env.example to web/.env.',
  )
}

const client = createClient(url, anonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    // Parse the token from password-recovery / email-confirmation links so the client
    // establishes a session and fires PASSWORD_RECOVERY (see lib/auth.tsx).
    detectSessionInUrl: true,
    // Implicit flow puts the token in the URL hash, so a recovery link works even when
    // opened in a different browser than the one that requested it (email on phone,
    // app on desktop). PKCE would tie recovery to the requesting browser's stored
    // code_verifier. App is email/password only — no OAuth — so implicit is fine.
    flowType: 'implicit',
  },
})

// ── Demo-mode guard ──────────────────────────────────────────────────────────
// The demo landing page seeds every query from fixtures, so no read should reach
// PostgREST — but a page that builds its own query key (Explore) or a stray call
// from a dialog would otherwise hit the network with the anon key. In demo mode
// `.from()` / `.rpc()` return a chainable stub that resolves empty and never opens
// a socket. `.auth` is untouched: the Log in / Sign up flow is real.
type StubResult = { data: unknown; error: null; count: null; status: 200; statusText: 'OK' }

// PostgREST resolves to a row array, except `.single()` / `.maybeSingle()` which
// resolve to a single row (null here — "no such row").
function emptyBuilder(data: unknown): unknown {
  const result: StubResult = { data, error: null, count: null, status: 200, statusText: 'OK' }
  return new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === 'then') {
          return (resolve: (v: StubResult) => unknown, reject?: (e: unknown) => unknown) =>
            Promise.resolve(result).then(resolve, reject)
        }
        // Every other property is a query-builder method: keep the chain going.
        return () =>
          prop === 'single' || prop === 'maybeSingle' ? emptyBuilder(null) : emptyBuilder(data)
      },
    },
  )
}

export const supabase = new Proxy(client, {
  get(target, prop, receiver) {
    if (isDemoMode() && (prop === 'from' || prop === 'rpc')) {
      return () => emptyBuilder(prop === 'from' ? [] : null)
    }
    const value = Reflect.get(target, prop, receiver)
    return typeof value === 'function' ? value.bind(target) : value
  },
})
