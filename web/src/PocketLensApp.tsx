import { QueryClientProvider } from '@tanstack/react-query'
import { ThemeProvider } from 'next-themes'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import AppLayout from '@/components/AppLayout'
import { Toaster as Sonner } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useAutoSyncOnLogin } from '@/data/hooks'
import { AuthProvider, useAuth } from '@/lib/auth'
import DemoApp from '@/demo/DemoApp'
import { setDemoMode } from '@/demo/demoMode'
import ResetPasswordPage from './pages/ResetPasswordPage'
import queryClient from './queryClient'
import NotFoundPage from './pages/NotFoundPage'
import { AppRouteTable } from './routes'

/** Sign-in fallback for the scheduled sync: see useAutoSyncOnLogin. Rendered only
 *  inside the signed-in tree, so it never fires against the demo. */
function AutoSyncOnLogin() {
  const { user } = useAuth()
  useAutoSyncOnLogin(user?.id ?? null)
  return null
}

function AppRoutes() {
  const { session, loading, recovery } = useAuth()

  if (loading) {
    return (
      <div className="flex min-h-svh items-center justify-center bg-background">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-brand border-t-transparent" />
      </div>
    )
  }

  // A recovery link signs the user in AND flags recovery — force the reset screen before
  // the app so a leaked/forgotten password can't be used as a silent back-door login.
  if (recovery) return <ResetPasswordPage />

  // Logged out → the demo: the whole app on fixtures, with Log in / Sign up in the top
  // bar (demo/DemoApp.tsx). Set before the demo tree renders so the Supabase guard and
  // the mutation gate see it on their first read. A signed-in user never gets here, so
  // real data is never shadowed by the demo.
  if (!session) {
    setDemoMode(true)
    return <DemoApp />
  }
  setDemoMode(false)

  return (
    <BrowserRouter>
      <AutoSyncOnLogin />
      <Routes>
        <Route element={<AppLayout />}>{AppRouteTable}</Route>
        {/* The demo's auth screens live at these paths. Signing in swaps this router in
            while the URL is still /login or /signup, which would otherwise fall through
            to the 404 page — send them home instead (a fresh signup is then routed on to
            the setup wizard by AppLayout). */}
        <Route path="/login" element={<Navigate to="/" replace />} />
        <Route path="/signup" element={<Navigate to="/" replace />} />
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </BrowserRouter>
  )
}

export default function PocketLensApp() {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
        <TooltipProvider>
          <Sonner />
          <AuthProvider>
            <AppRoutes />
          </AuthProvider>
        </TooltipProvider>
      </ThemeProvider>
    </QueryClientProvider>
  )
}
