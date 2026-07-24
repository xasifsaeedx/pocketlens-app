// Recurring charges — subscriptions/bills detected client-side from recent transactions
// (grouped by merchant + regular cadence). Users confirm, ignore, remove, or bulk-categorize a
// series; decisions persist in recurring_overrides. Supabase-backed (replaces Keep's FastAPI
// version). See lib/recurring.ts for detection.

import { useState } from 'react'
import { CheckCircle2, EyeOff, MoreHorizontal, RotateCcw, Tag, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { CategoryBadge } from '@/components/finance/CategoryBadge'
import { CategoryPickerDialog } from '@/components/finance/CategoryPickerDialog'
import { ErrorState } from '@/components/ErrorState'
import {
  useCategorizeRecurringSeries,
  useRecurringSeries,
  useSetRecurringStatus,
} from '@/data/hooks'
import type { RecurringSeriesCard } from '@/data/recurring'
import { formatAmount, formatCurrency } from '@/lib/money'
import { formatShortDate } from '@/lib/dates'
import { CountUp } from '@/lib/motion'
import { Skeleton } from '@/components/ui/skeleton'
import type { Transaction } from '@/types/domain'

// Normalize a per-cadence amount to a monthly figure for the "~$X/mo" estimate.
const PER_MONTH: Record<RecurringSeriesCard['cadence'], number> = {
  weekly: 52 / 12,
  biweekly: 26 / 12,
  monthly: 1,
  yearly: 1 / 12,
}

function cadenceLabel(c: RecurringSeriesCard['cadence']): string {
  return { weekly: 'Weekly', biweekly: 'Every 2 weeks', monthly: 'Monthly', yearly: 'Yearly' }[c]
}

/** Deterministic per-merchant icon tint — mirrors iOS RecurringChargesView.merchantTint().
 *  Sums the char codes of the stable merchantKey, picks brand (primary) if even,
 *  income (secondary/green) if odd — same colour across page loads. */
function merchantTintClass(key: string): { bg: string; text: string } {
  const sum = [...key].reduce((acc, ch) => acc + ch.charCodeAt(0), 0)
  return sum % 2 === 0
    ? { bg: 'bg-primary/10', text: 'text-primary' }
    : { bg: 'bg-secondary/10', text: 'text-secondary' }
}

export default function RecurringChargesPage() {
  const recurringQuery = useRecurringSeries()
  const { data: series = [], isLoading } = recurringQuery
  const setStatus = useSetRecurringStatus()
  const categorize = useCategorizeRecurringSeries()
  const [showIgnored, setShowIgnored] = useState(false)
  const [pickFor, setPickFor] = useState<RecurringSeriesCard | null>(null)

  const active = series.filter((s) => s.status !== 'ignored')
  const ignored = series.filter((s) => s.status === 'ignored')

  // Estimated monthly spend across everything not ignored.
  const monthlyEstimate = active.reduce(
    (sum, s) => sum + Math.abs(s.avgAmount) * PER_MONTH[s.cadence],
    0,
  )

  function card(s: RecurringSeriesCard) {
    const cat = s.occurrences[s.occurrences.length - 1]?.categories
    const tint = merchantTintClass(s.merchantKey)
    return (
      <div key={s.merchantKey} className="card-surface p-4">
        <div className="flex items-start gap-3">
          {/* Merchant-colored icon chip — mirrors iOS CategoryIconChip with merchantTint */}
          <div
            className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${tint.bg} ${tint.text} mt-0.5`}
          >
            <RotateCcw className="h-4 w-4" aria-hidden />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <p className="truncate font-medium">{s.displayName}</p>
              {s.status === 'confirmed' && (
                <Badge variant="default" className="shrink-0">
                  Confirmed
                </Badge>
              )}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <Badge variant="secondary">{cadenceLabel(s.cadence)}</Badge>
              <span>
                {s.count}× · last {formatShortDate(s.lastDate)}
              </span>
              <span>· next ~{formatShortDate(s.nextExpected)}</span>
              {cat && <CategoryBadge category={cat} />}
            </div>
          </div>
          <p className="shrink-0 font-semibold tabular-nums text-money-expense">
            {formatAmount(Math.abs(s.avgAmount))}
          </p>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          {s.status !== 'confirmed' && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setStatus.mutate({ merchantKey: s.merchantKey, status: 'confirmed' })}
              disabled={setStatus.isPending}
            >
              <CheckCircle2 className="mr-1.5 h-4 w-4" /> Confirm
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => setPickFor(s)}>
            <Tag className="mr-1.5 h-4 w-4" /> Categorize
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setStatus.mutate({ merchantKey: s.merchantKey, status: 'ignored' })}
            disabled={setStatus.isPending}
          >
            <EyeOff className="mr-1.5 h-4 w-4" /> Ignore
          </Button>
          {/* Remove is a destructive action — tucked into an overflow menu to reduce clutter */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="ghost" className="px-2" aria-label="More options">
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                className="text-destructive focus:text-destructive"
                onClick={() => setStatus.mutate({ merchantKey: s.merchantKey, status: 'removed' })}
                disabled={setStatus.isPending}
              >
                <Trash2 className="mr-2 h-4 w-4" />
                Remove permanently
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    )
  }

  // The picker wants a Transaction for its header + onPick; use the latest occurrence.
  const pickTxn: Transaction | null = pickFor?.occurrences[pickFor.occurrences.length - 1] ?? null

  return (
    <div className="mx-auto max-w-2xl space-y-5 p-4 sm:p-6">
      <div>
        <h1 className="text-2xl font-semibold text-foreground">Recurring charges</h1>
        <p className="text-sm text-muted-foreground">
          Detected from your recent transactions — subscriptions and bills that repeat on a
          regular schedule.
        </p>
      </div>

      {!isLoading && active.length > 0 && (
        <div className="card-surface p-5">
          <p className="eyebrow">Estimated recurring spend</p>
          <p className="mt-1.5 flex items-baseline gap-1">
            <CountUp
              value={monthlyEstimate}
              format={(n) => formatCurrency(n)}
              className="text-hero-number text-foreground"
            />
            <span className="text-sm font-medium text-muted-foreground">/mo</span>
          </p>
        </div>
      )}

      {isLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-16 w-full rounded-xl" />
          <Skeleton className="h-28 w-full rounded-xl" />
          <Skeleton className="h-28 w-full rounded-xl" />
        </div>
      ) : recurringQuery.isError ? (
        <ErrorState onRetry={() => void recurringQuery.refetch()} error={recurringQuery.error} />
      ) : active.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border bg-surface-container-low/40 px-4 py-10 text-center text-sm text-muted-foreground">
          No recurring charges detected yet. They appear once a merchant has at least three
          regularly-spaced charges.
        </div>
      ) : (
        <div className="space-y-3">{active.map(card)}</div>
      )}

      {ignored.length > 0 && (
        <div className="space-y-3">
          <button
            onClick={() => setShowIgnored((v) => !v)}
            className="text-sm font-medium text-muted-foreground hover:text-foreground"
          >
            {showIgnored ? 'Hide' : 'Show'} ignored ({ignored.length})
          </button>
          {showIgnored &&
            ignored.map((s) => (
              <div
                key={s.merchantKey}
                className="flex items-center justify-between rounded-xl bg-surface-container px-4 py-3"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{s.displayName}</p>
                  <p className="text-xs text-muted-foreground">
                    {cadenceLabel(s.cadence)} · {formatAmount(Math.abs(s.avgAmount))}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setStatus.mutate({ merchantKey: s.merchantKey, status: null })}
                  disabled={setStatus.isPending}
                >
                  <RotateCcw className="mr-1.5 h-4 w-4" /> Restore
                </Button>
              </div>
            ))}
        </div>
      )}

      <CategoryPickerDialog
        txn={pickTxn}
        open={pickFor != null}
        onOpenChange={(o) => !o && setPickFor(null)}
        onPick={(categoryId) => {
          if (pickFor && categoryId)
            categorize.mutate({
              occurrenceIds: pickFor.occurrences.map((t) => t.id),
              categoryId,
            })
          setPickFor(null)
        }}
      />
    </div>
  )
}
