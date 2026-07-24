import { Component, StrictMode, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import PocketLensApp from './PocketLensApp'
import { prewarm } from './data/backend'

// Wake the free-tier Render backend now, behind the user's browsing time, so their
// first sync / bank-link doesn't eat the cold start.
prewarm()

// Minimal top-level error boundary: catches render errors and shows a recover UI.
class ErrorBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { hasError: boolean }> {
  state = { hasError: false }

  static getDerivedStateFromError() {
    return { hasError: true }
  }

  componentDidCatch(error: unknown) {
    console.error(error)
  }

  render() {
    return this.state.hasError ? this.props.fallback : this.props.children
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary
      fallback={
        <div className="flex min-h-svh items-center justify-center bg-background px-4">
          <div className="w-full max-w-sm rounded-xl border border-border bg-card p-8 text-center text-card-foreground shadow-card">
            <h2 className="text-lg font-semibold text-foreground">Something went wrong</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              Reload the page to continue.
            </p>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="mt-5 inline-flex items-center justify-center rounded-full bg-primary px-5 py-2 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90"
            >
              Reload
            </button>
          </div>
        </div>
      }
    >
      <PocketLensApp />
    </ErrorBoundary>
  </StrictMode>,
)
