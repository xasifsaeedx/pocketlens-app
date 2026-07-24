// Split one transaction across categories. Amounts must sum to the txn amount (remainder
// shown live; Save disabled until it's zero). Mirrors iOS split UX. Uses the same sign
// convention as the txn (+ = spend). Removing all rows un-splits (clears splits).

import { useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useCategories, useSetSplits } from '@/data/hooks'
import { displayName, txnSplits, type Transaction, type UUID } from '@/types/domain'
import { formatAmount } from '@/lib/money'
import { evaluateSplit, SPLIT_EPS } from '@/data/splits'

interface Row {
  category_id: UUID | ''
  amount: string // raw input; parsed on save
}

function seedRows(txn: Transaction): Row[] {
  const existing = txnSplits(txn)
  if (existing.length > 0)
    return existing.map((s) => ({ category_id: s.category_id, amount: String(s.amount) }))
  // Start with the full amount on one row + an empty second row to split into.
  return [
    { category_id: txn.category_id ?? '', amount: String(txn.amount) },
    { category_id: '', amount: '' },
  ]
}

export function SplitDialog({
  txn,
  open,
  onOpenChange,
}: {
  txn: Transaction
  open: boolean
  onOpenChange: (o: boolean) => void
}) {
  const { data: categories = [] } = useCategories()
  const setSplits = useSetSplits()
  const [rows, setRows] = useState<Row[]>(() => seedRows(txn))

  const parsed = rows.map((r) => ({ category_id: r.category_id, amount: Number(r.amount) }))
  const { canSave, remainder, error } = evaluateSplit(txn.amount, parsed)

  function update(i: number, patch: Partial<Row>) {
    setRows((prev) => prev.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  }
  function addRow() {
    // Prefill the new row with the outstanding remainder for convenience.
    const rem = Math.round(remainder * 100) / 100
    setRows((prev) => [...prev, { category_id: '', amount: rem !== 0 ? String(rem) : '' }])
  }
  function removeRow(i: number) {
    setRows((prev) => prev.filter((_, j) => j !== i))
  }

  function save() {
    setSplits.mutate(
      {
        transactionId: txn.id,
        splits: parsed.map((r) => ({ category_id: r.category_id as UUID, amount: r.amount })),
      },
      { onSuccess: () => onOpenChange(false) },
    )
  }
  function unsplit() {
    setSplits.mutate(
      { transactionId: txn.id, splits: [] },
      { onSuccess: () => onOpenChange(false) },
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Split “{displayName(txn)}”</DialogTitle>
        </DialogHeader>

        <div className="space-y-2">
          {rows.map((r, i) => (
            <div key={i} className="flex items-center gap-2">
              <select
                value={r.category_id}
                onChange={(e) => update(i, { category_id: e.target.value })}
                className="min-w-0 flex-1 rounded-lg border border-border bg-background px-2 py-1.5 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
              >
                <option value="">Category…</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
              <input
                type="number"
                inputMode="decimal"
                value={r.amount}
                onChange={(e) => update(i, { amount: e.target.value })}
                placeholder="0.00"
                className="w-24 rounded-lg border border-border bg-background px-2 py-1.5 text-right text-sm tabular-nums focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
              />
              <button
                type="button"
                onClick={() => removeRow(i)}
                disabled={rows.length <= 2}
                className="rounded-lg p-1.5 text-muted-foreground hover:text-destructive disabled:opacity-30"
                aria-label="Remove row"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          ))}

          <button
            type="button"
            onClick={addRow}
            className="flex items-center gap-1 rounded-md px-1 text-sm font-medium text-primary transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            <Plus className="h-4 w-4" /> Add split
          </button>

          <div className="flex items-center justify-between rounded-lg bg-surface-container-low px-3 py-2 text-sm">
            <span className="text-muted-foreground">
              Total {formatAmount(txn.amount)} · Remainder
            </span>
            {/* Sage = balanced (savable), error red = remainder outstanding */}
            <span
              className={
                Math.abs(remainder) < SPLIT_EPS
                  ? 'font-medium tabular-nums text-secondary'
                  : 'font-medium tabular-nums text-destructive'
              }
            >
              {formatAmount(remainder)}
            </span>
          </div>

          {error && (
            <p className="px-1 text-xs font-medium text-destructive" role="alert">
              {error}
            </p>
          )}
        </div>

        <DialogFooter className="gap-2 sm:justify-between">
          {txnSplits(txn).length > 0 ? (
            <Button variant="ghost" onClick={unsplit} disabled={setSplits.isPending}>
              Remove split
            </Button>
          ) : (
            <span />
          )}
          <Button className="rounded-full" onClick={save} disabled={!canSave || setSplits.isPending}>
            Save split
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
