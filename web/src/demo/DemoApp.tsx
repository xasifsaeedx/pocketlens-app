// The logged-out landing experience: the real app, running on fixtures.
//
// A visitor lands inside a furnished PocketLens instead of a login form — they can
// browse months, filter, sort, and read every chart. Nothing writes: each mutation
// opens the sign-up dialog (see demoMutation.ts), and no request reaches Supabase
// (seeded cache + the stubbed client in lib/supabase.ts).

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter, Route, Routes, useNavigate } from 'react-router-dom'
import { Sparkles } from 'lucide-react'
import AppLayout from '@/components/AppLayout'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import LoginPage from '@/pages/LoginPage'
import NotFoundPage from '@/pages/NotFoundPage'
import { AppRouteTable } from '@/routes'
import { DemoContext, type DemoContextValue } from './demoContext'
import { createDemoQueryClient } from './demoQueryClient'
import { setDemoPromptListener } from './demoPrompt'

function SignupDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const navigate = useNavigate()
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Create an account to do that</DialogTitle>
          <DialogDescription>
            You’re looking at a demo with made-up numbers, so nothing here can be saved.
            Sign up to connect your own accounts — categories, budgets, tags, and rules
            are all yours from there.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Keep looking around
          </Button>
          <Button onClick={() => navigate('/signup')}>Sign up free</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Explains the fake data once per visit, above the app chrome. The persistent marker
 *  is the "Demo" pill in the top bar — this strip is the fuller version, dismissible. */
function DemoBanner() {
  const [dismissed, setDismissed] = useState(false)
  const navigate = useNavigate()
  if (dismissed) return null
  return (
    <div className="border-b border-border/60 bg-secondary-container/60 text-on-secondary-container">
      {/* Stacks on phones: side-by-side, the sentence collapses to a one-word-per-line
          column between the icon and the button. */}
      <div className="page-container flex flex-col gap-2 py-2 text-sm sm:flex-row sm:items-center sm:gap-3">
        <p className="flex flex-1 items-center gap-2">
          <Sparkles className="h-4 w-4 shrink-0" aria-hidden />
          This is a live demo with made-up data. Click around — nothing is saved.
        </p>
        <div className="flex shrink-0 items-center gap-2">
          <Button size="sm" variant="pill" onClick={() => navigate('/signup')}>
            Connect your accounts
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setDismissed(true)}
            aria-label="Dismiss demo notice"
          >
            Dismiss
          </Button>
        </div>
      </div>
    </div>
  )
}

function DemoShell() {
  const [promptOpen, setPromptOpen] = useState(false)

  // The mutation gate is plain (non-React) code, so it reaches the dialog through a
  // module-level listener rather than context.
  useEffect(() => {
    setDemoPromptListener(() => setPromptOpen(true))
    return () => setDemoPromptListener(null)
  }, [])

  const value = useMemo<DemoContextValue>(
    () => ({ demo: true, showSignup: () => setPromptOpen(true) }),
    [],
  )

  return (
    <DemoContext.Provider value={value}>
      <Routes>
        {/* Real auth, outside the demo chrome. */}
        <Route path="/login" element={<LoginPage />} />
        <Route path="/signup" element={<LoginPage initialMode="signup" />} />
        <Route
          element={
            <>
              <DemoBanner />
              <AppLayout />
            </>
          }
        >
          {AppRouteTable}
        </Route>
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
      <SignupDialog open={promptOpen} onOpenChange={setPromptOpen} />
    </DemoContext.Provider>
  )
}

export default function DemoApp({ children }: { children?: ReactNode }) {
  // One client per mount: building the fixtures is cheap, and a fresh client keeps the
  // demo's seeded cache away from the signed-in app's.
  const [client] = useState(createDemoQueryClient)
  return (
    <QueryClientProvider client={client}>
      <BrowserRouter>{children ?? <DemoShell />}</BrowserRouter>
    </QueryClientProvider>
  )
}
