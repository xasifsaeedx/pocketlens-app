// Transfers tab — the readable view of money moving between the user's own accounts:
// "Paid credit card (Checking → Freedom Card)", "Moved Checking → Savings", one-sided
// moves to external accounts. Auto-detected by the sync service; this tab shows the
// groups, offers undo (unlink / "Not a transfer"), and surfaces the fuzzy suggestions
// the auto-detector declined for one-click confirm/dismiss.

import { useMemo } from 'react'
import { ArrowRight, ArrowLeftRight, CreditCard, ExternalLink } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  useAccountsWithBalance,
  useDismissSuggestion,
  useLinkTransfer,
  useTransferGroups,
  useTransferSuggestions,
  useUnlinkTransfer,
} from '@/data/hooks'
import { summarizeTransferGroup, type TransferGroupSummary } from '@/data/transfers'
import { displayName, type Account, type Transaction, type UUID } from '@/types/domain'
import { formatCurrency } from '@/lib/money'
import { formatShortDate } from '@/lib/dates'

function headline(s: TransferGroupSummary): string {
  if (s.kind === 'card_payment') return 'Paid credit card'
  if (s.kind === 'move') return 'Moved money'
  return s.from != null ? 'Moved to external' : 'Moved from external'
}

function GroupIcon({ kind }: { kind: TransferGroupSummary['kind'] }) {
  const Icon =
    kind === 'card_payment' ? CreditCard : kind === 'one_sided' ? ExternalLink : ArrowLeftRight
  return (
    <span
      aria-hidden="true"
      className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-surface-container-low text-primary"
    >
      <Icon className="h-4 w-4" />
    </span>
  )
}

export function TransfersTab({ month }: { month: Date }) {
  const { data: groups, isLoading } = useTransferGroups(month)
  const { data: suggestions = [] } = useTransferSuggestions()
  const { data: accountsData } = useAccountsWithBalance()
  const link = useLinkTransfer()
  const dismiss = useDismissSuggestion()
  const unlink = useUnlinkTransfer()

  const accountsById = useMemo(
    () => new Map<UUID, Account>((accountsData ?? []).map((a) => [a.id, a])),
    [accountsData],
  )
  const acctName = (t: Transaction) => accountsById.get(t.account_id)?.name ?? 'Unknown account'

  return (
    <div className="space-y-6">
      {suggestions.length > 0 && (
        <section>
          <h2 className="mb-3 text-xl font-medium text-foreground">Looks like transfers</h2>
          <div className="overflow-hidden card-surface">
            {suggestions.map((s) => (
              <div
                key={s.out.id}
                className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border p-4 last:border-b-0"
              >
                <div className="min-w-0 flex-1">
                  {/* Amount front and center */}
                  <p className="text-base font-semibold tabular-nums text-foreground">
                    {formatCurrency(s.out.amount)}
                  </p>
                  {/* From → To route as the primary descriptor */}
                  <p className="flex items-center gap-1 text-sm font-medium text-foreground">
                    {acctName(s.out)}
                    <ArrowRight aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    {acctName(s.in)}
                  </p>
                  {/* Transaction names + dates as supporting detail */}
                  <p className="truncate text-xs text-muted-foreground">
                    {displayName(s.out)} ({formatShortDate(s.out.effective_date)}) ·{' '}
                    {displayName(s.in)} ({formatShortDate(s.in.effective_date)})
                  </p>
                </div>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    className="rounded-full"
                    onClick={() => link.mutate({ a: s.out, b: s.in })}
                    disabled={link.isPending}
                  >
                    Link
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="rounded-full"
                    onClick={() => dismiss.mutate({ a: s.out, b: s.in })}
                    disabled={dismiss.isPending}
                  >
                    Dismiss
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {isLoading ? (
        <p className="px-1 text-sm text-muted-foreground">Loading…</p>
      ) : !groups || groups.size === 0 ? (
        <div className="rounded-xl border border-dashed border-outline-variant p-8 text-center text-sm text-muted-foreground">
          No transfers this month. Money moved between your accounts (or credit-card
          payments) will show up here and stay out of your spending totals.
        </div>
      ) : (
        <div className="overflow-hidden card-surface">
          {[...groups.entries()].map(([groupId, legs]) => {
            const s = summarizeTransferGroup(legs, accountsById)
            const oneSided = s.kind === 'one_sided'
            const route = oneSided
              ? `${s.from ?? s.external} → ${s.to ?? s.external}`
              : `${s.from} → ${s.to}`
            return (
              <div
                key={groupId}
                className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border p-4 last:border-b-0"
              >
                <GroupIcon kind={s.kind} />
                <div className="min-w-0 flex-1">
                  {/* Amount on its own line — big and immediately readable */}
                  <p className="text-base font-semibold tabular-nums text-foreground">
                    {formatCurrency(s.amount)}
                  </p>
                  {/* From → To route as the primary descriptor */}
                  <p className="truncate text-sm font-medium text-foreground">
                    {route}
                  </p>
                  {/* Supporting context in secondary style */}
                  <p className="truncate text-xs text-muted-foreground">
                    {headline(s)}
                    {' · '}
                    {formatShortDate(s.date)}
                    {legs[0].transfer_kind === 'manual' ? ' · linked by you' : ''}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  className="rounded-full"
                  onClick={() => unlink.mutate(groupId)}
                  disabled={unlink.isPending}
                >
                  {oneSided ? 'Not a transfer' : 'Unlink'}
                </Button>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
