// Dialog shown after a new Plaid bank account is linked.
// Asks whether the user wants a full 2-year backfill or just a standard recent sync.

import { useState } from 'react'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { sbKeys } from '@/data/hooks'
import { requestBackfill, triggerSync } from '@/data/sync'

interface BackfillPromptDialogProps {
  open: boolean
  institutionName: string
  itemId: string
  onClose: () => void
}

export function BackfillPromptDialog({
  open,
  institutionName,
  itemId,
  onClose,
}: BackfillPromptDialogProps) {
  const qc = useQueryClient()
  const [isBackfilling, setIsBackfilling] = useState(false)

  function invalidateAfterSync() {
    qc.invalidateQueries({ queryKey: sbKeys.plaidItems })
    qc.invalidateQueries({ queryKey: sbKeys.accounts })
    qc.invalidateQueries({ queryKey: sbKeys.currentNetWorth })
    qc.invalidateQueries({ queryKey: ['sb', 'transactions'] })
    qc.invalidateQueries({ queryKey: ['sb', 'netWorth'] })
  }

  async function handleFullHistory() {
    setIsBackfilling(true)
    try {
      await requestBackfill(itemId)
      // The backend already kicks off a background sync after requesting backfill.
      // Schedule staggered cache invalidations so the UI picks up new data
      // once the background sync completes (avoid triggering a competing sync).
      setTimeout(() => invalidateAfterSync(), 3_000)
      setTimeout(() => invalidateAfterSync(), 8_000)
      toast.success('Full history sync started — transactions may take a minute to appear.')
      onClose()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not start backfill.')
    } finally {
      setIsBackfilling(false)
    }
  }

  async function handleStandardSync() {
    try {
      await triggerSync()
      invalidateAfterSync()
      toast.success('Syncing… balances will update shortly.')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Sync failed.')
    } finally {
      onClose()
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && !isBackfilling && onClose()}>
      <DialogContent className="max-w-md rounded-xl border-0 bg-card shadow-card-hover">
        <DialogHeader>
          <DialogTitle className="text-xl font-medium leading-7 text-foreground">
            {institutionName} linked!
          </DialogTitle>
          <DialogDescription className="text-sm text-muted-foreground">
            How far back would you like to import transactions?
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-1">
          {/* Full history option */}
          <button
            type="button"
            onClick={() => void handleFullHistory()}
            disabled={isBackfilling}
            className="group flex w-full items-start gap-4 rounded-lg border-2 border-primary/30 bg-primary/5 p-4 text-left transition-colors hover:border-primary/60 hover:bg-primary/10 disabled:pointer-events-none disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
          >
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
              {isBackfilling ? (
                <Loader2 aria-hidden className="h-5 w-5 animate-spin" />
              ) : (
                <span aria-hidden className="text-lg">📅</span>
              )}
            </span>
            <div className="min-w-0 flex-1">
              <p className="font-semibold text-foreground">Full history</p>
              <p className="mt-0.5 text-sm text-muted-foreground">
                Import up to 2 years of transactions — great for budgets and reports.
              </p>
            </div>
          </button>

          {/* Standard sync option */}
          <button
            type="button"
            onClick={() => void handleStandardSync()}
            disabled={isBackfilling}
            className="group flex w-full items-start gap-4 rounded-lg border-2 border-outline-variant/60 bg-surface-container-high p-4 text-left transition-colors hover:border-outline-variant hover:bg-surface-variant disabled:pointer-events-none disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
          >
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-surface-container text-muted-foreground">
              <span aria-hidden className="text-lg">⚡</span>
            </span>
            <div className="min-w-0 flex-1">
              <p className="font-semibold text-foreground">Standard sync</p>
              <p className="mt-0.5 text-sm text-muted-foreground">
                Fetch recent transactions only (last 30 days).
              </p>
            </div>
          </button>
        </div>

        <DialogFooter className="pt-1">
          <Button
            variant="link"
            size="sm"
            disabled={isBackfilling}
            onClick={onClose}
            className="text-muted-foreground"
          >
            Not now
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
