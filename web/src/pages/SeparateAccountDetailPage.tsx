// Detail + editors for a manual "separate" account — balance header, a signed value
// ledger (add/subtract entries), and recurring contributions (add/delete). Web
// counterpart of iOS SeparateAccountDetailView (SeparateAccountViews.swift). The
// balance is SUM(value entries), same math as fetchSeparateAccounts / current_net_worth.

import { useMemo, useState } from 'react'
import { motion } from 'framer-motion'
import { ArrowLeft, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { CountUp } from '@/lib/motion'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  useAddContribution,
  useAddSeparateAccountValue,
  useDeleteContribution,
  useDeleteSeparateAccount,
  useSeparateAccountContributions,
  useSeparateAccountValues,
  useSeparateAccounts,
} from '@/data/hooks'
import { formatCurrency } from '@/lib/money'
import { formatShortDate, toISODate } from '@/lib/dates'
import { separateAccountTypeLabel } from '@/lib/separateAccountTypes'
import { cn } from '@/lib/utils'
import type { UUID } from '@/types/domain'
import { toast } from 'sonner'
import NotFoundPage from './NotFoundPage'

export default function SeparateAccountDetailPage() {
  const navigate = useNavigate()
  const { id } = useParams<{ id: string }>()
  const accountId = (id ?? '') as UUID

  const { data: accounts, isLoading: accountsLoading } = useSeparateAccounts()
  const { data: values = [] } = useSeparateAccountValues(accountId)
  const { data: contributions = [] } = useSeparateAccountContributions(accountId)
  const deleteAccount = useDeleteSeparateAccount()

  const [showAddValue, setShowAddValue] = useState(false)
  const [showAddContribution, setShowAddContribution] = useState(false)

  const account = useMemo(
    () => accounts?.find((a) => a.id === accountId) ?? null,
    [accounts, accountId],
  )

  // Balance = sum of the signed value ledger (matches fetchSeparateAccounts).
  const balance = useMemo(() => values.reduce((sum, v) => sum + v.amount, 0), [values])

  if (accountsLoading && !accounts) {
    return (
      <div className="pt-4 md:pt-8">
        <Skeleton className="mb-6 h-8 w-24 rounded-full" />
        <Skeleton className="mb-6 h-40 w-full rounded-xl" />
        <Skeleton className="h-32 w-full rounded-xl" />
      </div>
    )
  }

  if (!account) return <NotFoundPage />

  async function removeAccount() {
    if (
      !window.confirm(
        `Delete "${account!.name}"? This removes the account and all of its value entries.`,
      )
    )
      return
    try {
      await deleteAccount.mutateAsync(accountId)
      navigate('/accounts')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not delete account.')
    }
  }

  return (
    <div className="pt-4 md:pt-8">
      <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}>
        <Button
          variant="ghost"
          size="sm"
          className="mb-6 -ml-2 rounded-full text-muted-foreground hover:bg-surface-container-high hover:text-foreground"
          asChild
        >
          <Link to="/accounts">
            <ArrowLeft className="h-4 w-4 mr-2" />
            Balances
          </Link>
        </Button>

        {/* Balance header */}
        <section className="card-surface p-6 md:p-8">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="eyebrow">{separateAccountTypeLabel(account.type)}</p>
              <h1 className="mt-1 truncate text-2xl font-semibold tracking-tight text-foreground md:text-3xl">
                {account.name}
              </h1>
              <CountUp
                value={balance}
                format={(n) => formatCurrency(n)}
                className={cn(
                  'text-hero-number mt-3 block',
                  balance < 0 ? 'text-destructive' : 'text-foreground',
                )}
              />
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="shrink-0 rounded-full border-border text-destructive hover:bg-error-container hover:text-on-error-container"
              disabled={deleteAccount.isPending}
              onClick={removeAccount}
            >
              <Trash2 className="h-4 w-4 mr-2" />
              Delete
            </Button>
          </div>
        </section>

        {/* Recurring contributions */}
        <section className="mt-6 overflow-hidden card-surface" aria-label="Recurring contributions">
          <div className="flex items-center justify-between gap-3 border-b border-outline-variant/30 px-5 py-4">
            <h2 className="text-xl font-medium text-foreground">Recurring Contributions</h2>
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5 rounded-full"
              onClick={() => setShowAddContribution(true)}
            >
              <RefreshCw className="h-4 w-4" aria-hidden />
              Add
            </Button>
          </div>
          <div className="flex flex-col">
            {contributions.length === 0 && (
              <p className="px-5 py-4 text-sm text-muted-foreground">None</p>
            )}
            {contributions.map((c) => (
              <div
                key={c.id}
                className="flex items-center justify-between gap-4 border-b border-outline-variant/30 px-5 py-4 last:border-0"
              >
                <div className="min-w-0">
                  <p className="text-base font-medium text-foreground tabular-nums">
                    {formatCurrency(c.delta_balance)}
                  </p>
                  <p className="text-xs font-medium tracking-wide text-muted-foreground">
                    every {c.frequency_in_days} day{c.frequency_in_days === 1 ? '' : 's'}
                  </p>
                </div>
                <DeleteContributionButton id={c.id} />
              </div>
            ))}
          </div>
        </section>

        {/* Value ledger */}
        <section className="mt-6 overflow-hidden card-surface" aria-label="Entries">
          <div className="flex items-center justify-between gap-3 border-b border-outline-variant/30 px-5 py-4">
            <h2 className="text-xl font-medium text-foreground">Entries</h2>
            <Button
              variant="pill"
              size="sm"
              className="gap-1.5"
              onClick={() => setShowAddValue(true)}
            >
              <Plus className="h-4 w-4" aria-hidden />
              Add entry
            </Button>
          </div>
          <div className="flex flex-col">
            {values.length === 0 && (
              <p className="px-5 py-4 text-sm text-muted-foreground">No entries yet</p>
            )}
            {values.map((v) => (
              <div
                key={v.id}
                className="flex items-center justify-between gap-4 border-b border-outline-variant/30 px-5 py-4 last:border-0"
              >
                <div className="min-w-0">
                  <p className="text-base text-foreground">{formatShortDate(v.date)}</p>
                  {v.note && (
                    <p className="truncate text-xs font-medium tracking-wide text-muted-foreground">
                      {v.note}
                    </p>
                  )}
                </div>
                <span
                  className={cn(
                    'shrink-0 text-lg font-semibold tabular-nums',
                    v.amount < 0 ? 'text-money-expense' : 'text-money-income',
                  )}
                >
                  {formatCurrency(v.amount)}
                </span>
              </div>
            ))}
          </div>
        </section>
      </motion.div>

      <AddValueDialog
        accountId={accountId}
        open={showAddValue}
        onOpenChange={setShowAddValue}
      />
      <AddContributionDialog
        accountId={accountId}
        open={showAddContribution}
        onOpenChange={setShowAddContribution}
      />
    </div>
  )
}

function DeleteContributionButton({ id }: { id: UUID }) {
  const del = useDeleteContribution()
  return (
    <button
      type="button"
      onClick={() => del.mutate(id)}
      disabled={del.isPending}
      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-error-container hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-card disabled:opacity-50 motion-reduce:transition-none"
      aria-label="Delete contribution"
    >
      <Trash2 aria-hidden className="h-4 w-4" />
    </button>
  )
}

// ── Add value entry ──────────────────────────────────────────────────────────

function AddValueDialog({
  accountId,
  open,
  onOpenChange,
}: {
  accountId: UUID
  open: boolean
  onOpenChange: (o: boolean) => void
}) {
  const add = useAddSeparateAccountValue()
  const [direction, setDirection] = useState<'add' | 'subtract'>('add')
  const [amount, setAmount] = useState('')
  const [date, setDate] = useState(toISODate(new Date()))
  const [note, setNote] = useState('')

  function reset() {
    setDirection('add')
    setAmount('')
    setDate(toISODate(new Date()))
    setNote('')
  }

  async function save() {
    const mag = Number(amount)
    if (!Number.isFinite(mag) || mag === 0) {
      toast.error('Enter a non-zero amount.')
      return
    }
    const signed = direction === 'subtract' ? -Math.abs(mag) : Math.abs(mag)
    try {
      await add.mutateAsync({
        separate_account_id: accountId,
        date,
        amount: signed,
        note: note.trim() === '' ? null : note.trim(),
      })
      reset()
      onOpenChange(false)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not add entry.')
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) reset()
        onOpenChange(o)
      }}
    >
      <DialogContent className="max-w-md rounded-xl border-0 bg-card shadow-card-hover">
        <DialogHeader>
          <DialogTitle className="text-xl font-medium leading-7 text-foreground">
            Add entry
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="ve-dir">Direction</Label>
            <Select value={direction} onValueChange={(v) => setDirection(v as 'add' | 'subtract')}>
              <SelectTrigger id="ve-dir">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="add">Add</SelectItem>
                <SelectItem value="subtract">Subtract</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ve-amt">Amount</Label>
            <Input
              id="ve-amt"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="e.g. 250"
              autoFocus
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ve-date">Date</Label>
            <Input id="ve-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ve-note">Note</Label>
            <Input
              id="ve-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Optional"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={add.isPending}>
            Cancel
          </Button>
          <Button variant="pill" onClick={save} disabled={add.isPending}>
            {add.isPending ? 'Saving…' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ── Add recurring contribution ───────────────────────────────────────────────

function AddContributionDialog({
  accountId,
  open,
  onOpenChange,
}: {
  accountId: UUID
  open: boolean
  onOpenChange: (o: boolean) => void
}) {
  const add = useAddContribution()
  const [direction, setDirection] = useState<'add' | 'subtract'>('add')
  const [amount, setAmount] = useState('')
  const [frequency, setFrequency] = useState('14')
  const [anchor, setAnchor] = useState(toISODate(new Date()))

  function reset() {
    setDirection('add')
    setAmount('')
    setFrequency('14')
    setAnchor(toISODate(new Date()))
  }

  async function save() {
    const mag = Number(amount)
    const freq = Number.parseInt(frequency, 10)
    if (!Number.isFinite(mag) || mag === 0) {
      toast.error('Enter a non-zero amount.')
      return
    }
    if (!Number.isFinite(freq) || freq <= 0) {
      toast.error('Frequency must be a positive number of days.')
      return
    }
    try {
      await add.mutateAsync({
        separate_account_id: accountId,
        delta_balance: direction === 'subtract' ? -Math.abs(mag) : Math.abs(mag),
        frequency_in_days: freq,
        anchor_date: anchor,
      })
      reset()
      onOpenChange(false)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not add contribution.')
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) reset()
        onOpenChange(o)
      }}
    >
      <DialogContent className="max-w-md rounded-xl border-0 bg-card shadow-card-hover">
        <DialogHeader>
          <DialogTitle className="text-xl font-medium leading-7 text-foreground">
            Recurring contribution
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="rc-dir">Direction</Label>
            <Select value={direction} onValueChange={(v) => setDirection(v as 'add' | 'subtract')}>
              <SelectTrigger id="rc-dir">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="add">Add</SelectItem>
                <SelectItem value="subtract">Subtract</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="rc-amt">Amount each period</Label>
            <Input
              id="rc-amt"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="e.g. 500"
              autoFocus
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="rc-freq">Frequency (days)</Label>
            <Input
              id="rc-freq"
              inputMode="numeric"
              value={frequency}
              onChange={(e) => setFrequency(e.target.value)}
              placeholder="e.g. 14"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="rc-anchor">First applied</Label>
            <Input
              id="rc-anchor"
              type="date"
              value={anchor}
              onChange={(e) => setAnchor(e.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={add.isPending}>
            Cancel
          </Button>
          <Button variant="pill" onClick={save} disabled={add.isPending}>
            {add.isPending ? 'Saving…' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
