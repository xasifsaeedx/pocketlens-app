// Mirrors PocketLens/App/LoginView.swift — email/password Sign In / Sign Up toggle.

import { useState } from 'react'
import { Wallet, Eye, EyeOff } from 'lucide-react'
import { useAuth } from '@/lib/auth'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card } from '@/components/ui/card'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { PASSWORD_RULE, isValidPassword } from '@/lib/password'

export default function LoginPage({
  initialMode = 'signin',
}: {
  /** The demo's "Sign up" entry points land here with the sign-up tab already open. */
  initialMode?: 'signin' | 'signup'
}) {
  const { signIn, signUp, resetPassword } = useAuth()
  const [mode, setMode] = useState<'signin' | 'signup' | 'forgot'>(initialMode)
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const namesFilled =
    mode !== 'signup' || (firstName.trim().length > 0 && lastName.trim().length > 0)
  const passwordsMatch = mode !== 'signup' || confirmPassword === password
  // Sign-in accepts any existing password; sign-up must satisfy the current policy (the
  // server enforces it too). Forgot only needs an email.
  const passwordOk =
    mode === 'signin' ? password.length > 0 : mode === 'signup' ? isValidPassword(password) : true
  const canSubmit =
    email.length > 0 &&
    (mode === 'forgot' || passwordOk) &&
    namesFilled &&
    passwordsMatch &&
    !busy

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setNotice(null)
    setBusy(true)
    try {
      if (mode === 'signin') {
        await signIn(email, password)
      } else if (mode === 'forgot') {
        await resetPassword(email)
        setNotice('If an account exists for that email, a reset link is on its way.')
      } else {
        // Land brand-new accounts on Settings with the bank-setup wizard
        // highlighted (AppLayout picks this flag up once the session exists).
        sessionStorage.setItem('fresh-signup', '1')
        const { needsConfirmation } = await signUp(email, password, {
          firstName: firstName.trim(),
          lastName: lastName.trim(),
        })
        if (needsConfirmation) {
          setNotice('Check your email to confirm, then sign in.')
          setMode('signin')
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="relative flex min-h-svh items-center justify-center overflow-hidden bg-background px-4 py-10">
      {/* Warm Terracotta & Sage wash: a soft brand glow over a faint dot grid. */}
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
        <div className="absolute -top-32 left-1/2 h-96 w-96 -translate-x-1/2 rounded-full bg-brand/10 blur-3xl" />
        <div className="absolute -bottom-40 -right-24 h-80 w-80 rounded-full bg-secondary/10 blur-3xl" />
        <div className="absolute inset-0 opacity-[0.04] [background-image:radial-gradient(hsl(var(--outline))_1px,transparent_1px)] [background-size:24px_24px]" />
      </div>

      <div className="w-full max-w-sm animate-slide-up">
        <div className="mb-8 flex flex-col items-center gap-3 text-center">
          <div className="brand-icon-well h-16 w-16 shadow-card">
            <Wallet className="h-8 w-8 text-primary" />
          </div>
          <h1 className="font-sans text-4xl font-bold tracking-tight text-foreground">PocketLens</h1>
          <p className="text-sm text-muted-foreground">Track spending, budgets, and net worth.</p>
        </div>

        <Card className="p-6 sm:p-8">
          <div className="mb-6 space-y-1 text-center">
            <h2 className="text-2xl font-semibold tracking-tight text-foreground">
              {mode === 'signin'
                ? 'Welcome back'
                : mode === 'forgot'
                  ? 'Reset your password'
                  : 'Create your account'}
            </h2>
            <p className="text-sm text-muted-foreground">
              {mode === 'signin'
                ? 'Sign in to continue to your dashboard.'
                : mode === 'forgot'
                  ? 'Enter your email and we’ll send a reset link.'
                  : 'Start tracking in under a minute.'}
            </p>
          </div>

          {mode !== 'forgot' && (
            <Tabs value={mode} onValueChange={(v) => setMode(v as 'signin' | 'signup')}>
              <TabsList className="grid w-full grid-cols-2">
                <TabsTrigger value="signin">Sign In</TabsTrigger>
                <TabsTrigger value="signup">Sign Up</TabsTrigger>
              </TabsList>
            </Tabs>
          )}

          <form onSubmit={submit} className="mt-6 space-y-4">
            {mode === 'signup' && (
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="first-name">First name</Label>
                  <Input
                    id="first-name"
                    type="text"
                    autoComplete="given-name"
                    placeholder="Jane"
                    value={firstName}
                    onChange={(e) => setFirstName(e.target.value)}
                    required
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="last-name">Last name</Label>
                  <Input
                    id="last-name"
                    type="text"
                    autoComplete="family-name"
                    placeholder="Doe"
                    value={lastName}
                    onChange={(e) => setLastName(e.target.value)}
                    required
                  />
                </div>
              </div>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                autoComplete="email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </div>
            {mode !== 'forgot' && (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label htmlFor="password">Password</Label>
                {mode === 'signin' && (
                  <button
                    type="button"
                    onClick={() => {
                      setMode('forgot')
                      setError(null)
                      setNotice(null)
                    }}
                    className="text-xs font-medium text-primary hover:underline"
                  >
                    Forgot password?
                  </button>
                )}
              </div>
              <div className="relative">
                <Input
                  id="password"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
                  className="pr-10"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((s) => !s)}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  className="absolute right-3 top-1/2 -translate-y-1/2 rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:text-foreground focus-visible:outline-none"
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
              {mode === 'signup' && password.length > 0 && !isValidPassword(password) && (
                <p className="text-xs text-muted-foreground">{PASSWORD_RULE}</p>
              )}
            </div>
            )}

            {mode === 'signup' && (
              <div className="space-y-1.5">
                <Label htmlFor="confirm-password">Confirm password</Label>
                <Input
                  id="confirm-password"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="new-password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  required
                />
                {confirmPassword.length > 0 && confirmPassword !== password && (
                  <p className="text-xs text-destructive">Passwords don&apos;t match.</p>
                )}
              </div>
            )}

            {error && <p className="text-sm text-destructive">{error}</p>}
            {notice && <p className="text-sm text-money-income">{notice}</p>}

            <Button
              type="submit"
              variant="pill"
              size="pill"
              className="w-full text-base font-semibold transition-transform active:scale-[0.98]"
              disabled={!canSubmit}
            >
              {busy
                ? 'Please wait…'
                : mode === 'signin'
                  ? 'Sign In'
                  : mode === 'forgot'
                    ? 'Send reset link'
                    : 'Create account'}
            </Button>
          </form>
        </Card>

        <p className="mt-6 text-center text-xs text-muted-foreground">
          {mode === 'forgot' ? (
            <button
              type="button"
              onClick={() => {
                setMode('signin')
                setError(null)
                setNotice(null)
              }}
              className="font-medium text-primary hover:underline"
            >
              Back to sign in
            </button>
          ) : (
            <>
              {mode === 'signin' ? 'New to PocketLens? ' : 'Already have an account? '}
              <button
                type="button"
                onClick={() => {
                  setMode(mode === 'signin' ? 'signup' : 'signin')
                  setError(null)
                  setNotice(null)
                }}
                className="font-medium text-primary hover:underline"
              >
                {mode === 'signin' ? 'Create an account' : 'Sign in'}
              </button>
            </>
          )}
        </p>
      </div>
    </div>
  )
}
