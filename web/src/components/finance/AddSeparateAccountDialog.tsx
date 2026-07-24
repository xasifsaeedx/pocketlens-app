// Create a manual "separate" account — name, type, optional starting balance, and an
// optional recurring contribution — the web counterpart of iOS AddSeparateAccountSheet.
// Uses the useCreateSeparateAccount orchestration hook (create + seed value + contribution).

import { useState } from 'react'
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useCreateSeparateAccount } from '@/data/hooks'
import { toISODate } from '@/lib/dates'
import { SEPARATE_ACCOUNT_TYPES } from '@/lib/separateAccountTypes'
import { toast } from 'sonner'

export function AddSeparateAccountDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
}) {
  const create = useCreateSeparateAccount()
  const [name, setName] = useState('')
  const [type, setType] = useState('investment')
  const [startingBalance, setStartingBalance] = useState('')
  const [addRecurring, setAddRecurring] = useState(false)
  const [recurringDirection, setRecurringDirection] = useState<'add' | 'subtract'>('add')
  const [recurringAmount, setRecurringAmount] = useState('')
  const [recurringFrequency, setRecurringFrequency] = useState('14')
  const [recurringAnchor, setRecurringAnchor] = useState(toISODate(new Date()))

  function reset() {
    setName('')
    setType('investment')
    setStartingBalance('')
    setAddRecurring(false)
    setRecurringDirection('add')
    setRecurringAmount('')
    setRecurringFrequency('14')
    setRecurringAnchor(toISODate(new Date()))
  }

  const trimmedName = name.trim()

  async function save() {
    if (!trimmedName) return
    const start = startingBalance.trim() === '' ? null : Number(startingBalance)
    if (start != null && !Number.isFinite(start)) {
      toast.error('Starting balance must be a number.')
      return
    }

    let recurring: { delta: number; frequencyInDays: number; anchorISO: string } | null = null
    if (addRecurring) {
      const mag = Number(recurringAmount)
      const freq = Number.parseInt(recurringFrequency, 10)
      if (!Number.isFinite(mag) || mag === 0 || !Number.isFinite(freq) || freq <= 0) {
        toast.error('Enter a non-zero amount and a positive frequency for the recurring contribution.')
        return
      }
      recurring = {
        delta: recurringDirection === 'subtract' ? -Math.abs(mag) : Math.abs(mag),
        frequencyInDays: freq,
        anchorISO: recurringAnchor,
      }
    }

    try {
      await create.mutateAsync({ name: trimmedName, type, startingBalance: start, recurring })
      toast.success('Account created.')
      reset()
      onOpenChange(false)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not create account.')
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
      <DialogContent className="max-h-[85vh] max-w-md overflow-y-auto rounded-xl border-0 bg-card shadow-card-hover">
        <DialogHeader>
          <DialogTitle className="text-xl font-medium leading-7 text-foreground">
            New account
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="sa-name">Name</Label>
            <Input
              id="sa-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. 401(k), Car loan"
              autoFocus
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="sa-type">Type</Label>
            <Select value={type} onValueChange={setType}>
              <SelectTrigger id="sa-type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SEPARATE_ACCOUNT_TYPES.map((t) => (
                  <SelectItem key={t.value} value={t.value}>
                    {t.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="sa-start">Starting balance</Label>
            <Input
              id="sa-start"
              inputMode="decimal"
              value={startingBalance}
              onChange={(e) => setStartingBalance(e.target.value)}
              placeholder="e.g. 12000 (optional)"
            />
          </div>

          <div className="rounded-lg border border-border p-3">
            <label className="flex items-center gap-2 text-sm font-medium text-foreground">
              <input
                type="checkbox"
                checked={addRecurring}
                onChange={(e) => setAddRecurring(e.target.checked)}
                className="h-4 w-4 rounded border-border accent-primary"
              />
              Recurring contribution
            </label>

            {addRecurring && (
              <div className="mt-3 space-y-3">
                <div className="space-y-1.5">
                  <Label htmlFor="sa-rec-dir">Direction</Label>
                  <Select
                    value={recurringDirection}
                    onValueChange={(v) => setRecurringDirection(v as 'add' | 'subtract')}
                  >
                    <SelectTrigger id="sa-rec-dir">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="add">Add</SelectItem>
                      <SelectItem value="subtract">Subtract</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="sa-rec-amt">Amount each period</Label>
                  <Input
                    id="sa-rec-amt"
                    inputMode="decimal"
                    value={recurringAmount}
                    onChange={(e) => setRecurringAmount(e.target.value)}
                    placeholder="e.g. 500"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="sa-rec-freq">Frequency (days)</Label>
                  <Input
                    id="sa-rec-freq"
                    inputMode="numeric"
                    value={recurringFrequency}
                    onChange={(e) => setRecurringFrequency(e.target.value)}
                    placeholder="e.g. 14"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="sa-rec-anchor">First applied</Label>
                  <Input
                    id="sa-rec-anchor"
                    type="date"
                    value={recurringAnchor}
                    onChange={(e) => setRecurringAnchor(e.target.value)}
                  />
                </div>
              </div>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={create.isPending}>
            Cancel
          </Button>
          <Button variant="pill" onClick={save} disabled={!trimmedName || create.isPending}>
            {create.isPending ? 'Saving…' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
