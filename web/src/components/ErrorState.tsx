import { AlertTriangle, RefreshCw } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { cn } from '@/lib/utils'

interface ErrorStateProps {
  /** Called when the user taps Retry — pass the query's `refetch`. */
  onRetry?: () => void
  /** Optional heading. Defaults to a generic couldn't-load message. */
  title?: string
  /** Optional supporting copy. Falls back to `error.message`, then a default. */
  message?: string
  /** The React Query error, used to derive `message` when none is given. */
  error?: unknown
  className?: string
}

/**
 * Consistent failed-fetch surface for list pages. A failed query must
 * read differently from an empty result, and must offer a Retry — pages should
 * render this on `isError` instead of their empty/zero state.
 */
export function ErrorState({ onRetry, title = "Couldn't load", message, error, className }: ErrorStateProps) {
  const body =
    message ?? (error instanceof Error && error.message ? error.message : 'Something went wrong. Please try again.')

  return (
    <Card
      role="alert"
      className={cn(
        'flex flex-col items-center gap-3 rounded-2xl border border-destructive/30 px-4 py-10 text-center shadow-card',
        className,
      )}
    >
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10 text-destructive">
        <AlertTriangle className="h-6 w-6" aria-hidden />
      </div>
      <div className="space-y-1">
        <p className="text-base font-semibold text-foreground">{title}</p>
        <p className="mx-auto max-w-sm text-sm text-muted-foreground">{body}</p>
      </div>
      {onRetry && (
        <Button variant="outline" className="mt-1 rounded-full" onClick={() => onRetry()}>
          <RefreshCw className="h-4 w-4" aria-hidden />
          Retry
        </Button>
      )}
    </Card>
  )
}
