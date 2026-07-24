// Supabase auth context — mirrors PocketLens/App/PocketLensApp.swift AuthState.

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { Session, User } from '@supabase/supabase-js'
import { supabase } from '@/lib/supabase'

interface AuthContextValue {
  session: Session | null
  user: User | null
  loading: boolean
  // True while the app is in a password-recovery flow (arrived via a Supabase recovery
  // link). The router shows the reset-password screen instead of the app until cleared.
  recovery: boolean
  signIn: (email: string, password: string) => Promise<void>
  signUp: (
    email: string,
    password: string,
    profile: { firstName: string; lastName: string },
  ) => Promise<{ needsConfirmation: boolean }>
  signOut: () => Promise<void>
  // Send a password-recovery email. The link returns to /reset-password.
  resetPassword: (email: string) => Promise<void>
  // Set a new password for the recovery session, then leave the recovery flow.
  updatePassword: (password: string) => Promise<void>
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined)

// A recovery link establishes a *persisted* session, so the "must reset" requirement has to
// persist too — otherwise closing/reloading the reset screen drops the user into the app with
// a valid session and no new password (PASSWORD_RECOVERY only fires once, on the link click).
const RECOVERY_KEY = 'pl-password-recovery'

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [loading, setLoading] = useState(true)
  const [recovery, setRecovery] = useState(false)
  const qc = useQueryClient()
  // Track the current user so we can wipe the query cache when it changes — otherwise a
  // sign-out + sign-in as a different user shows the previous user's cached rows.
  const userIdRef = useRef<string | null>(null)

  useEffect(() => {
    function apply(s: Session | null) {
      const nextUserId = s?.user?.id ?? null
      if (nextUserId !== userIdRef.current) {
        userIdRef.current = nextUserId
        qc.clear()
      }
      setSession(s)
    }
    supabase.auth.getSession().then(({ data }) => {
      // Reload with a still-pending recovery session → stay on the reset screen.
      if (data.session && localStorage.getItem(RECOVERY_KEY)) setRecovery(true)
      apply(data.session)
      setLoading(false)
    })
    const { data: sub } = supabase.auth.onAuthStateChange((event, s) => {
      // A recovery link establishes a session AND fires PASSWORD_RECOVERY. Flag it so the
      // router shows the reset screen rather than dropping the user into the app. Signing
      // out (incl. "Back to sign in" on the reset screen) leaves the recovery flow.
      if (event === 'PASSWORD_RECOVERY') {
        localStorage.setItem(RECOVERY_KEY, '1')
        setRecovery(true)
      }
      if (event === 'SIGNED_OUT') {
        localStorage.removeItem(RECOVERY_KEY)
        setRecovery(false)
      }
      apply(s)
    })
    return () => sub.subscription.unsubscribe()
  }, [qc])

  async function signIn(email: string, password: string) {
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) throw error
  }

  async function signUp(
    email: string,
    password: string,
    profile: { firstName: string; lastName: string },
  ) {
    // first_name/last_name land in raw_user_meta_data, which the DB signup trigger
    // (handle_new_user) reads to seed the user's profiles row.
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: { data: { first_name: profile.firstName, last_name: profile.lastName } },
    })
    if (error) throw error
    // No session back when email confirmation is required.
    return { needsConfirmation: !data.session }
  }

  async function signOut() {
    await supabase.auth.signOut()
  }

  async function resetPassword(email: string) {
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/reset-password`,
    })
    if (error) throw error
  }

  async function updatePassword(password: string) {
    const { error } = await supabase.auth.updateUser({ password })
    if (error) throw error
    localStorage.removeItem(RECOVERY_KEY)
    setRecovery(false)
  }

  return (
    <AuthContext.Provider
      value={{
        session,
        user: session?.user ?? null,
        loading,
        recovery,
        signIn,
        signUp,
        signOut,
        resetPassword,
        updatePassword,
      }}
    >
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
