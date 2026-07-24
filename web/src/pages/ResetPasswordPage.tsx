// Shown when the app is in a password-recovery flow (AppRoutes gates on auth.recovery,
// set by the PASSWORD_RECOVERY event after a recovery link establishes a session).
// Collects a new password and calls updateUser, then drops into the app.

import { useState } from 'react'
import { Wallet, Eye, EyeOff } from 'lucide-react'
import { useAuth } from '@/lib/auth'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card } from '@/components/ui/card'
import { PASSWORD_RULE, validatePassword } from '@/lib/password'

export default function ResetPasswordPage() {
  const { updatePassword, signOut } = useAuth()
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const passwordsMatch = confirmPassword === password
  const policyError = password.length > 0 ? validatePassword(password) : null
  const canSubmit = validatePassword(password) === null && passwordsMatch && !busy

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      await updatePassword(password)
      // updatePassword clears recovery; the router falls through to the app.
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="relative flex min-h-svh items-center justify-center overflow-hidden bg-background px-4 py-10">
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
        </div>

        <Card className="p-6 sm:p-8">
          <div className="mb-6 space-y-1 text-center">
            <h2 className="text-2xl font-semibold tracking-tight text-foreground">Set a new password</h2>
            <p className="text-sm text-muted-foreground">Choose a new password for your account.</p>
          </div>

          <form onSubmit={submit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="new-password">New password</Label>
              <div className="relative">
                <Input
                  id="new-password"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="new-password"
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
              <p className={`text-xs ${policyError ? 'text-destructive' : 'text-muted-foreground'}`}>
                {policyError ?? PASSWORD_RULE}
              </p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="confirm-new-password">Confirm password</Label>
              <Input
                id="confirm-new-password"
                type={showPassword ? 'text' : 'password'}
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                required
              />
              {confirmPassword.length > 0 && !passwordsMatch && (
                <p className="text-xs text-destructive">Passwords don&apos;t match.</p>
              )}
            </div>

            {error && <p className="text-sm text-destructive">{error}</p>}

            <Button
              type="submit"
              variant="pill"
              size="pill"
              className="w-full text-base font-semibold transition-transform active:scale-[0.98]"
              disabled={!canSubmit}
            >
              {busy ? 'Please wait…' : 'Update password'}
            </Button>
          </form>
        </Card>

        <p className="mt-6 text-center text-xs text-muted-foreground">
          <button
            type="button"
            onClick={() => void signOut()}
            className="font-medium text-primary hover:underline"
          >
            Back to sign in
          </button>
        </p>
      </div>
    </div>
  )
}
