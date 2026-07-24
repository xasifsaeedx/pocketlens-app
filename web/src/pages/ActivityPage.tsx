// Activity log + one-tap Undo (route /activity, reached from Settings → Activity). Reads the
// shared activity_log feed (written by both iOS and web) newest-first and offers Undo
// on any reversible, not-yet-undone entry. Data layer: data/activity.ts + useActivity.

import {
  Eye,
  EyeOff,
  FilePlus2,
  FileMinus2,
  Tag,
  Wallet,
  Trash2,
  type LucideIcon,
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { ErrorState } from '@/components/ErrorState'
import { useActivity, useUndoActivity } from '@/data/hooks'
import { formatRelativeTime } from '@/lib/dates'
import type { ActivityActionType, ActivityEntry } from '@/types/domain'

/** lucide icon per action_type (falls back to a neutral tag). */
const ACTION_ICON: Record<ActivityActionType, LucideIcon> = {
  categorize: Tag,
  hide: EyeOff,
  unhide: Eye,
  set_budget: Wallet,
  delete_budget: Trash2,
  add_rule: FilePlus2,
  delete_rule: FileMinus2,
}

function ActivityRow({ entry }: { entry: ActivityEntry }) {
  const undo = useUndoActivity()
  const Icon = ACTION_ICON[entry.action_type] ?? Tag
  const canUndo = entry.reversible && !entry.undone

  const onUndo = () => {
    undo.mutate(entry, {
      onError: () => toast.error('Could not undo that action.'),
    })
  }

  return (
    <li className="flex items-center gap-3 px-4 py-3">
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-secondary-container text-on-secondary-container">
        <Icon className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm text-foreground">{entry.summary}</p>
        <p className="text-xs text-muted-foreground">{formatRelativeTime(entry.created_at)}</p>
      </div>
      {canUndo ? (
        <Button
          variant="outline"
          size="sm"
          onClick={onUndo}
          disabled={undo.isPending}
          aria-label={`Undo: ${entry.summary}`}
        >
          Undo
        </Button>
      ) : entry.undone ? (
        <span className="text-xs font-medium text-muted-foreground">Undone</span>
      ) : null}
    </li>
  )
}

export default function ActivityPage() {
  const activityQuery = useActivity()
  const { data, isLoading } = activityQuery
  const entries = data ?? []

  return (
    <div className="mx-auto w-full max-w-2xl space-y-6 py-6 md:py-8">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold text-foreground">Activity</h1>
        <p className="text-sm text-muted-foreground">
          Recent changes you made — categorizations, hides, budgets, and rules. Undo reverses one.
        </p>
      </header>

      {isLoading ? (
        <Card className="overflow-hidden rounded-2xl shadow-card">
          <ul className="divide-y divide-border">
            {Array.from({ length: 5 }).map((_, i) => (
              <li key={i} className="flex items-center gap-3 px-4 py-3">
                <Skeleton className="h-9 w-9 shrink-0 rounded-full" />
                <div className="min-w-0 flex-1 space-y-2">
                  <Skeleton className="h-4 w-2/3" />
                  <Skeleton className="h-3 w-24" />
                </div>
              </li>
            ))}
          </ul>
        </Card>
      ) : activityQuery.isError ? (
        <ErrorState onRetry={() => void activityQuery.refetch()} error={activityQuery.error} />
      ) : entries.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">
          No activity yet. Categorize a transaction or set a budget to see it here.
        </div>
      ) : (
        <Card className="overflow-hidden rounded-2xl shadow-card">
          <ul className="divide-y divide-border">
            {entries.map((entry) => (
              <ActivityRow key={entry.id} entry={entry} />
            ))}
          </ul>
        </Card>
      )}
    </div>
  )
}
