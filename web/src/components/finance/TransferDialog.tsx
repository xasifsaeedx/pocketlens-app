// Link a transaction to its opposite leg as a transfer (money moving between the user's own
// accounts), or unlink an existing one. Linked legs are excluded from spend/income totals.
// Candidates = opposite sign, equal magnitude, nearby date, different account, not yet linked.

import { useMemo } from 'react'
import { ArrowRight } from 'lucide-react'
import { useAccountsWithBalance, useLinkTransfer, useTransferCandidates, useTransferGroupLegs, useUnlinkTransfer } from '@/data/hooks'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Amount } from './Amount'
import { displayName, isTransfer, type Transaction } from '@/types/domain'
import { formatShortDate } from '@/lib/dates'
import { formatCurrency } from '@/lib/money'
import { summarizeTransferGroup } from '@/data/transfers'

export function TransferDialog({
  txn,
  open,
  onOpenChange,
}: {
  txn: Transaction
  open: boolean
  onOpenChange: (o: boolean) => void
}) {
  const linked = isTransfer(txn)
  const { data: candidates = [], isLoading } = useTransferCandidates(linked ? null : txn)
  const link = useLinkTransfer()
  const unlink = useUnlinkTransfer()

  // When already linked, fetch all legs so we can show the from→to route.
  const { data: groupLegs } = useTransferGroupLegs(linked ? txn.transfer_group_id : null)
  const { data: accountsData } = useAccountsWithBalance()
  const accountsById = useMemo(
    () => new Map((accountsData ?? []).map((a) => [a.id, a])),
    [accountsData],
  )
  const transferSummary = useMemo(
    () => (groupLegs && groupLegs.length > 0 ? summarizeTransferGroup(groupLegs, accountsById) : null),
    [groupLegs, accountsById],
  )

  function doLink(other: Transaction) {
    link.mutate({ a: txn, b: other }, { onSuccess: () => onOpenChange(false) })
  }
  function doUnlink() {
    if (txn.transfer_group_id)
      unlink.mutate(txn.transfer_group_id, { onSuccess: () => onOpenChange(false) })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{linked ? 'Linked transfer' : 'Mark as transfer'}</DialogTitle>
        </DialogHeader>

        <div className="mb-1 flex items-center justify-between rounded-lg bg-surface-container-low px-3 py-2 text-sm">
          <span className="font-medium">{displayName(txn)}</span>
          <span className="text-muted-foreground">{formatShortDate(txn.effective_date)}</span>
        </div>

        {linked ? (
          transferSummary ? (
            // Show the from→to route and amount clearly
            <div className="space-y-3 px-1">
              <div className="flex items-center gap-3 rounded-lg border border-border bg-surface-container-low px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="text-base font-semibold tabular-nums text-foreground">
                    {formatCurrency(transferSummary.amount)}
                  </p>
                  <p className="mt-0.5 flex items-center gap-1 text-sm font-medium text-foreground">
                    <span className="truncate">{transferSummary.from ?? transferSummary.external ?? 'External'}</span>
                    <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                    <span className="truncate">{transferSummary.to ?? transferSummary.external ?? 'External'}</span>
                  </p>
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                Both legs are excluded from spending totals.
              </p>
            </div>
          ) : (
            <p className="px-1 text-sm text-muted-foreground">
              This transaction is linked as a transfer and excluded from spending totals. Unlink
              to count it again.
            </p>
          )
        ) : isLoading ? (
          <p className="px-1 text-sm text-muted-foreground">Finding matches…</p>
        ) : candidates.length === 0 ? (
          <p className="px-1 text-sm text-muted-foreground">
            No matching transaction found (opposite amount in another account within a few days).
          </p>
        ) : (
          <div className="space-y-2">
            <p className="px-1 text-xs text-muted-foreground">
              Link with its opposite leg — both will be excluded from totals:
            </p>
            <div className="overflow-hidden card-surface">
              {candidates.map((c, i) => (
                <button
                  key={c.id}
                  onClick={() => doLink(c)}
                  disabled={link.isPending}
                  className="flex w-full items-center gap-3 border-border px-4 py-3 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary disabled:opacity-50 [&:not(:first-child)]:border-t"
                  data-testid={i === 0 ? 'transfer-candidate' : undefined}
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{displayName(c)}</p>
                    <p className="text-xs text-muted-foreground">
                      {formatShortDate(c.effective_date)}
                    </p>
                  </div>
                  <Amount value={c.amount} className="text-sm" />
                </button>
              ))}
            </div>
          </div>
        )}

        <DialogFooter className="gap-2 sm:justify-between">
          {linked ? (
            <Button variant="ghost" onClick={doUnlink} disabled={unlink.isPending}>
              Unlink transfer
            </Button>
          ) : (
            <span />
          )}
          <Button variant="outline" className="rounded-full" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
