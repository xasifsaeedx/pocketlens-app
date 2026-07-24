// Zero-sum (zero-based) budgeting view — assign every dollar until Ready-to-Assign hits 0,
// cover overspend by moving money between categories, watch balances roll over month to month.
// Math is pure (@/lib/zbb); this is wiring + presentation. Mirrors iOS ZbbBudgetView.swift.

import { useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { CategoryIconWell } from '@/features/budgets/CategoryIconWell'
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  useCategories, useSetZbbAssignment, useZbbMonth, useZbbMoveMoney,
} from '@/data/hooks'
import { formatCurrency } from '@/lib/money'
import { cn } from '@/lib/utils'
import type { Category } from '@/types/domain'

const EPS = 0.005

export default function ZbbBudgetView() {
  const today = useMemo(() => new Date(), [])
  const [cursor, setCursor] = useState({ year: today.getFullYear(), month: today.getMonth() + 1 })

  const { data: categories = [] } = useCategories()
  const { data: monthData } = useZbbMonth(cursor.year, cursor.month)
  const assign = useSetZbbAssignment()

  const spendCats = useMemo(
    () => categories.filter((c) => c.kind === 'spend'),
    [categories],
  )
  const rowByCat = useMemo(
    () => new Map((monthData?.overview.rows ?? []).map((r) => [r.category_id, r])),
    [monthData],
  )

  const rta = monthData?.overview.ready_to_assign ?? 0
  const monthLabel = new Date(cursor.year, cursor.month - 1, 1)
    .toLocaleString('en-US', { month: 'long', year: 'numeric' })

  // BACKLOG WEB-15: overspending must prompt the user to account for it by moving funds.
  const overspent = spendCats
    .map((c) => ({ category: c, deficit: -(rowByCat.get(c.id)?.available ?? 0) }))
    .filter((o) => o.deficit > EPS)

  // null = closed; {} = blank move; {to, amount} = prefilled "cover overspend" move.
  const [movePrefill, setMovePrefill] = useState<{ to?: string; amount?: number } | null>(null)

  function step(delta: number) {
    setCursor(({ year, month }) => {
      const i = year * 12 + (month - 1) + delta
      return { year: Math.floor(i / 12), month: (i % 12) + 1 }
    })
  }

  function commitAssign(cat: Category, raw: string) {
    const next = parseFloat(raw)
    if (isNaN(next)) return
    const prev = rowByCat.get(cat.id)?.assigned ?? 0
    if (next === prev) return
    // RTA changes by -(next - prev); block if it would go negative (mirrors the assign guard).
    if (rta - (next - prev) < -EPS) {
      toast.error('Not enough to assign — free up money in another category first.')
      return
    }
    assign.mutate({ categoryId: cat.id, year: cursor.year, month: cursor.month, assigned: next })
  }

  return (
    <div className="mx-auto w-full max-w-2xl space-y-4">
      <div className="flex items-center justify-between px-1">
        <Button
          variant="ghost"
          size="icon"
          className="h-11 w-11 rounded-full text-primary hover:bg-surface-container-high focus-visible:ring-primary"
          onClick={() => step(-1)}
          aria-label="Previous month"
        >
          <ChevronLeft className="h-5 w-5" />
        </Button>
        <span className="text-base font-semibold text-foreground">{monthLabel}</span>
        <Button
          variant="ghost"
          size="icon"
          className="h-11 w-11 rounded-full text-primary hover:bg-surface-container-high focus-visible:ring-primary"
          onClick={() => step(1)}
          aria-label="Next month"
        >
          <ChevronRight className="h-5 w-5" />
        </Button>
      </div>

      <div
        className={cn(
          'flex items-center justify-between rounded-xl px-5 py-4',
          Math.abs(rta) < EPS
            ? 'bg-secondary/10 text-secondary'
            : rta > 0
              ? 'bg-primary/10 text-primary'
              : 'bg-destructive/10 text-destructive',
        )}
      >
        <span className="text-sm font-medium">Ready to Assign</span>
        <span className="text-lg font-semibold tabular-nums">{formatCurrency(rta)}</span>
      </div>

      {overspent.length > 0 && (
        <div className="space-y-2 rounded-xl border border-destructive/30 bg-destructive/5 px-5 py-4">
          <p className="text-sm font-medium text-destructive">
            {overspent.length === 1 ? '1 category is' : `${overspent.length} categories are`}{' '}
            overspent — cover it by moving money from another category.
          </p>
          {overspent.map(({ category, deficit }) => (
            <div key={category.id} className="flex items-center justify-between gap-2">
              <span className="min-w-0 truncate text-sm text-foreground">{category.name}</span>
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium tabular-nums text-destructive">
                  {formatCurrency(deficit)}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  className="rounded-full"
                  aria-label={`Cover ${category.name}`}
                  onClick={() => setMovePrefill({ to: category.id, amount: deficit })}
                >
                  Cover
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="flex items-center justify-between px-1">
        <h2 className="text-xl font-medium text-foreground">Categories</h2>
        <Button
          variant="outline"
          size="sm"
          className="min-h-[44px] rounded-full px-5"
          onClick={() => setMovePrefill({})}
        >
          Move money
        </Button>
      </div>

      <MoveMoneyDialog
        key={movePrefill ? `${movePrefill.to ?? ''}-${movePrefill.amount ?? ''}` : 'closed'}
        year={cursor.year}
        month={cursor.month}
        categories={spendCats}
        prefill={movePrefill}
        onClose={() => setMovePrefill(null)}
      />

      {spendCats.map((c) => {
        const row = rowByCat.get(c.id)
        const available = row?.available ?? 0
        const activity = row?.activity ?? 0
        return (
          <div key={c.id} className="flex items-center gap-3 card-surface p-4">
            <CategoryIconWell category={c} />
            <div className="min-w-0 flex-1">
              <div className="text-base font-medium text-foreground">{c.name}</div>
              <div className="text-xs text-muted-foreground">
                {formatCurrency(activity)} spent ·{' '}
                <span className={cn(available < -EPS && 'font-medium text-destructive')}>
                  {formatCurrency(available)} available
                </span>
              </div>
            </div>
            <Input
              type="number"
              inputMode="decimal"
              defaultValue={row ? String(row.assigned) : '0'}
              key={`${c.id}-${cursor.year}-${cursor.month}-${row?.assigned ?? 0}`}
              onBlur={(e) => commitAssign(c, e.target.value)}
              className="w-24 text-right tabular-nums"
              aria-label={`Assign to ${c.name}`}
            />
          </div>
        )
      })}
    </div>
  )
}

function MoveMoneyDialog({
  year, month, categories, prefill, onClose,
}: {
  year: number
  month: number
  categories: Category[]
  /** null = closed; {} = blank; {to, amount} = prefilled cover-overspend move. */
  prefill: { to?: string; amount?: number } | null
  onClose: () => void
}) {
  const move = useZbbMoveMoney()
  const [from, setFrom] = useState('')
  const [to, setTo] = useState(prefill?.to ?? '')
  const [amount, setAmount] = useState(prefill?.amount != null ? String(prefill.amount) : '')

  function submit() {
    const amt = parseFloat(amount)
    if (!from || !to || from === to || isNaN(amt) || amt <= 0) {
      toast.error('Pick two different categories and a positive amount.')
      return
    }
    move.mutate(
      { year, month, from, to, amount: amt },
      {
        onSuccess: onClose,
        onError: (e) => toast.error(e instanceof Error ? e.message : 'Move failed'),
      },
    )
  }

  return (
    <Dialog open={prefill != null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Move money</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <CategorySelect value={from} onChange={setFrom} placeholder="From category" options={categories} />
          <CategorySelect value={to} onChange={setTo} placeholder="To category" options={categories} />
          <Input
            type="number"
            inputMode="decimal"
            placeholder="Amount"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </div>
        <DialogFooter>
          <Button onClick={submit} disabled={move.isPending}>Move</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function CategorySelect({
  value, onChange, placeholder, options,
}: {
  value: string
  onChange: (v: string) => void
  placeholder: string
  options: Category[]
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {options.map((c) => (
          <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
