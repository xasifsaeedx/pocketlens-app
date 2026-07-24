// Grid category picker with a "None" option — mirrors iOS CategoryPickerSheet.
// When the transaction is already a transfer, shows a focused transfer view instead
// (no categories, tags, or splits — those don't apply to transfers).

import { useMemo, useState } from 'react'
import { ArrowLeftRight, ArrowRight, Eye, EyeOff, MapPin, Plus, Split, Undo2, XCircle } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Switch } from '@/components/ui/switch'
import { CategoryIcon } from './CategoryIcon'
import { TxnTagEditor } from './TxnTagEditor'
import { SplitDialog } from './SplitDialog'
import { TransferDialog } from './TransferDialog'
import { useAccountsWithBalance, useCategories, useSetHidden, useSetReimbursement, useTransferGroupLegs, useUpsertCategory } from '@/data/hooks'
import { TAG_PALETTE } from '@/lib/tagColors'
import { displayName, hasSplits, isForeignCurrency, isReimbursement, isTransfer, merchantLocation, type Transaction, type UUID } from '@/types/domain'
import { formatAmount, formatCurrency } from '@/lib/money'
import { formatShortDate } from '@/lib/dates'
import { summarizeTransferGroup } from '@/data/transfers'

export function CategoryPickerDialog({
  txn,
  open,
  onOpenChange,
  onPick,
  onToggleHidden,
}: {
  txn: Transaction | null
  open: boolean
  onOpenChange: (o: boolean) => void
  onPick: (categoryId: UUID | null) => void
  /** Called after the Hidden tile fires (hosts advance queues etc.). */
  onToggleHidden?: () => void
}) {
  const { data: categories = [] } = useCategories()
  const setHidden = useSetHidden()
  const setReimbursement = useSetReimbursement()
  const upsertCategory = useUpsertCategory()
  const [splitOpen, setSplitOpen] = useState(false)
  const [transferOpen, setTransferOpen] = useState(false)
  const [adding, setAdding] = useState(false)
  const [newName, setNewName] = useState('')

  // When the txn is already a transfer, fetch its group legs so we can render the route.
  const { data: groupLegs } = useTransferGroupLegs(txn && isTransfer(txn) ? txn.transfer_group_id : null)
  const { data: accountsData } = useAccountsWithBalance()
  const accountsById = useMemo(
    () => new Map((accountsData ?? []).map((a) => [a.id, a])),
    [accountsData],
  )
  const transferSummary = useMemo(
    () => (groupLegs && groupLegs.length > 0 ? summarizeTransferGroup(groupLegs, accountsById) : null),
    [groupLegs, accountsById],
  )

  // A reimbursement is an incoming credit (amount < 0) that offsets a category's spend.
  // The toggle is only meaningful for credits; picking a category while it's on marks
  // the txn as a reimbursement for that category instead of a normal categorization.
  const isCredit = txn != null && txn.amount < 0
  const [reimbursing, setReimbursing] = useState(() => (txn ? isReimbursement(txn) : false))
  // Re-seed the toggle from the txn whenever a different one is shown (the dialog is a
  // single reused instance). React's recommended render-phase "reset on prop change".
  const [lastTxnId, setLastTxnId] = useState(txn?.id ?? null)
  if ((txn?.id ?? null) !== lastTxnId) {
    setLastTxnId(txn?.id ?? null)
    setReimbursing(txn ? isReimbursement(txn) : false)
  }

  /** Route a category choice: in reimbursement mode mark the contra-expense (needs a
   *  real category); otherwise the normal categorize path. */
  function commitCategory(categoryId: UUID | null) {
    if (reimbursing && txn) {
      if (!categoryId) return // a reimbursement must offset a category — ignore "None"
      setReimbursement.mutate({ transactionId: txn.id, isReimbursement: true, categoryId })
      onOpenChange(false)
      return
    }
    onPick(categoryId)
  }

  /** Toggle reimbursement mode. Turning it off on an already-flagged txn unmarks it now
   *  (keeping its category as a normal credit); turning it on waits for a category pick. */
  function toggleReimbursing(on: boolean) {
    if (!txn) return
    setReimbursing(on)
    if (!on && isReimbursement(txn)) {
      // Un-flagging clears the category — the row reverts to a plain uncategorized
      // credit (parity with iOS; the data layer enforces this too)
      setReimbursement.mutate({
        transactionId: txn.id,
        isReimbursement: false,
        categoryId: null,
      })
      onOpenChange(false)
    }
  }

  /** Create the category and immediately assign it to the txn. */
  async function createAndPick() {
    const name = newName.trim()
    if (!name) return
    const created = await upsertCategory.mutateAsync({
      name,
      color: TAG_PALETTE[categories.length % TAG_PALETTE.length],
      icon: 'tag.fill',
      sort_order: categories.length,
    })
    setNewName('')
    setAdding(false)
    commitCategory(created.id)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md overflow-hidden">

        {txn && isTransfer(txn) ? (
          // ── Transfer view — transfers don't have categories, tags, or splits ──
          <>
            <DialogHeader>
              <DialogTitle>Transfer</DialogTitle>
            </DialogHeader>

            {/* Transaction identity */}
            <div className="rounded-lg bg-surface-container-low px-3 py-2 text-sm">
              <p className="break-words font-medium text-foreground">{displayName(txn)}</p>
              <p className="mt-0.5 text-muted-foreground">
                {formatShortDate(txn.effective_date)} · {formatAmount(txn.amount)}
              </p>
            </div>

            {/* From → To route */}
            {transferSummary ? (
              <div className="rounded-lg border border-border bg-surface-container-low px-4 py-3">
                <p className="text-base font-semibold tabular-nums text-foreground">
                  {formatCurrency(transferSummary.amount)}
                </p>
                <p className="mt-1 text-sm font-medium text-foreground">
                  <span className="break-words">
                    {transferSummary.from ?? transferSummary.external ?? 'External'}
                  </span>
                  <ArrowRight className="mx-1 inline h-3.5 w-3.5 shrink-0 align-middle text-muted-foreground" aria-hidden="true" />
                  <span className="break-words">
                    {transferSummary.to ?? transferSummary.external ?? 'External'}
                  </span>
                </p>
                <p className="mt-1 text-xs text-muted-foreground">Excluded from spending totals</p>
              </div>
            ) : (
              <p className="px-1 text-sm text-muted-foreground">Loading transfer details…</p>
            )}

            {/* Only action: unlink */}
            <button
              onClick={() => setTransferOpen(true)}
              className="flex items-center gap-1.5 self-start rounded-md px-1 text-sm font-medium text-destructive transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive"
            >
              <ArrowLeftRight className="h-4 w-4" />
              Unlink transfer
            </button>
          </>
        ) : (
          // ── Normal categorize view ───────────────────────────────────────────
          <>
            <DialogHeader>
              <DialogTitle>Categorize</DialogTitle>
            </DialogHeader>
            {txn && (
              <div className="mb-2 rounded-lg bg-surface-container-low px-3 py-2 text-sm">
                <p className="break-words font-medium text-foreground">{displayName(txn)}</p>
                <p className="mt-0.5 text-muted-foreground">
                  {formatShortDate(txn.effective_date)} · {formatAmount(txn.amount)}
                </p>
                {/* Plaid merchant location + foreign-currency badge — shown only
                    when Plaid resolved them; historical rows stay blank until a re-sync. */}
                {(merchantLocation(txn) || isForeignCurrency(txn)) && (
                  <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                    {merchantLocation(txn) && (
                      <span className="inline-flex items-center gap-1">
                        <MapPin className="h-3 w-3 shrink-0" aria-hidden="true" />
                        {merchantLocation(txn)}
                      </span>
                    )}
                    {isForeignCurrency(txn) && (
                      <span
                        title="Foreign transaction"
                        className="inline-flex items-center rounded-full bg-secondary-container px-2 py-0.5 text-xs font-semibold text-on-secondary-container"
                      >
                        {txn.iso_currency_code}
                      </span>
                    )}
                  </div>
                )}
              </div>
            )}
            {/* Reimbursement (contra-expense) — only for credits. When on, the category grid
                below picks the category this credit offsets instead of categorizing it. */}
            {isCredit && (
              <label className="mb-1 flex items-start gap-3 rounded-lg bg-surface-container-low px-3 py-2.5">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-surface-container-high text-muted-foreground">
                  <Undo2 className="h-4 w-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-foreground">Reimbursement</span>
                  <span className="block text-xs text-muted-foreground">
                    {reimbursing
                      ? 'Pick the category this offsets below'
                      : 'Offsets a category\u2019s spend instead of counting as income'}
                  </span>
                </span>
                <Switch
                  checked={reimbursing}
                  onCheckedChange={toggleReimbursing}
                  aria-label="Reimbursement"
                  className="mt-0.5"
                />
              </label>
            )}
            <div className="grid grid-cols-3 gap-3">
              {categories.map((c) => (
                <button
                  key={c.id}
                  onClick={() => commitCategory(c.id)}
                  className="flex flex-col items-center gap-1.5 rounded-xl p-2 transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                >
                  <CategoryIcon category={c} />
                  <span className="text-center text-xs leading-tight">{c.name}</span>
                </button>
              ))}
              {/* "None" clears the category — meaningless for a reimbursement (it must offset
                  one), so hide it while reimbursing. */}
              {!reimbursing && (
                <button
                  onClick={() => commitCategory(null)}
                  className="flex flex-col items-center gap-1.5 rounded-xl p-2 transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                >
                  <div className="flex h-9 w-9 items-center justify-center rounded-full bg-surface-container-high text-muted-foreground">
                    <XCircle className="h-4 w-4" />
                  </div>
                  <span className="text-center text-xs leading-tight">None</span>
                </button>
              )}
              {/* Hidden behaves like a bucket: keeps the txn (and its category) but drops
                  it from totals. Picking a regular category on a hidden txn unhides it. */}
              {txn && (
                <button
                  onClick={() => {
                    setHidden.mutate({ txn, hidden: !txn.hidden })
                    onOpenChange(false)
                    onToggleHidden?.()
                  }}
                  className="flex flex-col items-center gap-1.5 rounded-xl p-2 transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                >
                  <div className="flex h-9 w-9 items-center justify-center rounded-full bg-surface-container-high text-muted-foreground">
                    {txn.hidden ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
                  </div>
                  <span className="text-center text-xs leading-tight">
                    {txn.hidden ? 'Unhide' : 'Hidden'}
                  </span>
                </button>
              )}
              <button
                onClick={() => setAdding((a) => !a)}
                className="flex flex-col items-center gap-1.5 rounded-xl border border-dashed border-outline-variant p-2 transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              >
                <div className="flex h-9 w-9 items-center justify-center rounded-full bg-surface-container text-primary">
                  <Plus className="h-4 w-4" />
                </div>
                <span className="text-center text-xs leading-tight">New</span>
              </button>
            </div>
            {adding && (
              <div className="flex gap-2">
                <input
                  autoFocus
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && createAndPick()}
                  placeholder="Category name…"
                  className="flex-1 rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary"
                />
                <button
                  onClick={createAndPick}
                  disabled={!newName.trim() || upsertCategory.isPending}
                  className="rounded-full bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary-container focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-card disabled:opacity-50 motion-reduce:transition-none"
                >
                  Add
                </button>
              </div>
            )}
            {txn && <TxnTagEditor key={txn.id} txn={txn} />}
            {/* Split + "Mark as transfer" — mutually exclusive with reimbursement mode. */}
            {txn && !reimbursing && (
              <div className="flex flex-wrap gap-4">
                <button
                  onClick={() => setSplitOpen(true)}
                  className="mt-1 flex items-center gap-1.5 self-start rounded-md px-1 text-sm font-medium text-primary transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                >
                  <Split className="h-4 w-4" />
                  {hasSplits(txn) ? 'Edit split' : 'Split transaction'}
                </button>
                <button
                  onClick={() => setTransferOpen(true)}
                  className="mt-1 flex items-center gap-1.5 self-start rounded-md px-1 text-sm font-medium text-primary transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                >
                  <ArrowLeftRight className="h-4 w-4" />
                  Mark as transfer
                </button>
              </div>
            )}
          </>
        )}

      </DialogContent>

      {txn && splitOpen && (
        <SplitDialog
          txn={txn}
          open={splitOpen}
          onOpenChange={(o) => {
            setSplitOpen(o)
            if (!o) onOpenChange(false)
          }}
        />
      )}

      {txn && transferOpen && (
        <TransferDialog
          txn={txn}
          open={transferOpen}
          onOpenChange={(o) => {
            setTransferOpen(o)
            if (!o) onOpenChange(false)
          }}
        />
      )}
    </Dialog>
  )
}
