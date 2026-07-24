// Account detail — Supabase-backed. Mirrors iOS AccountDetailView.swift.
// Shows: header card (balance + type editor + delete), then a day-grouped
// transaction list for this account.

import { useState } from 'react'
import { motion } from 'framer-motion'
import { ArrowLeft, Trash2 } from 'lucide-react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import ConfirmDialog from '@/components/ConfirmDialog'
import { Skeleton } from '@/components/ui/skeleton'
import { CountUp } from '@/lib/motion'
import {
  useAccountsWithBalance,
  useDeleteAccount,
  useLatestBalance,
  usePatchAccountType,
  useTransactionsByAccount,
} from '@/data/hooks'
import { TransactionList } from '@/features/transactions/TransactionList'
import { formatCurrency } from '@/lib/money'
import { isLiabilityType, type UUID } from '@/types/domain'
import { toast } from 'sonner'
import NotFoundPage from './NotFoundPage'

// Plaid canonical type strings — matches iOS AccountDetailView.typeOptions.
const TYPE_OPTIONS: { value: string; label: string }[] = [
  { value: 'depository', label: 'Checking & Savings' },
  { value: 'investment', label: 'Investments' },
  { value: 'credit', label: 'Credit Cards' },
  { value: 'loan', label: 'Loans' },
  { value: 'other', label: 'Other' },
]

function typeLabel(type: string): string {
  return TYPE_OPTIONS.find((o) => o.value === type)?.label ?? type
}

export default function AccountDetailPage() {
  const navigate = useNavigate()
  const { accountId } = useParams<{ accountId: string }>()
  const id = (accountId ?? '') as UUID

  const { data: accounts, isLoading: accountsLoading } = useAccountsWithBalance()
  const { data: latestBalance } = useLatestBalance(id)
  const { data: transactions = [], isLoading: txnsLoading } = useTransactionsByAccount(id)

  const patchType = usePatchAccountType()
  const deleteAccount = useDeleteAccount()

  const [selectedType, setSelectedType] = useState<string | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)

  const account = accounts?.find((a) => a.id === id) ?? null

  // Sync selectedType from account data on first load.
  const currentType = selectedType ?? account?.type ?? 'depository'

  if (accountsLoading && !accounts) {
    return (
      <div className="pt-4 md:pt-8">
        <Skeleton className="mb-6 h-8 w-24 rounded-full" />
        <Skeleton className="mb-8 h-44 w-full rounded-xl" />
        <Skeleton className="h-6 w-40" />
      </div>
    )
  }

  if (!account) return <NotFoundPage />

  const balance = account.currentBalance ?? latestBalance?.current_balance ?? null
  const available = latestBalance?.available_balance ?? null
  const availableDiffers =
    available != null && balance != null && Math.abs(available - balance) > 0.005
  const isLiability = isLiabilityType(account.type)

  async function handleDelete() {
    setConfirmOpen(false)
    try {
      await deleteAccount.mutateAsync(id)
      navigate('/accounts')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not delete account')
    }
  }

  async function handleSaveType() {
    if (currentType === account!.type) return
    try {
      await patchType.mutateAsync({ accountId: id, type: currentType })
      setSelectedType(null) // reset local state; data re-fetches
    } catch {
      // error toast handled by hook
    }
  }

  return (
    <div className="pt-4 md:pt-8">
      <ConfirmDialog
        open={confirmOpen}
        title={`Delete ${account.name}?`}
        message={`Removes this account and ALL of its transactions.\n\nAny transfer-linked transactions on other accounts are kept but converted to normal (unlinked) transactions.`}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={handleDelete}
      />

      <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}>
        {/* Back button */}
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

        {/* Header card */}
        <div className="card-surface rounded-xl p-5 mb-8 space-y-4">
          {/* Eyebrow */}
          <p className="eyebrow">
            {typeLabel(account.type)} · {account.currency}
          </p>

          {/* Balance */}
          {balance != null ? (
            <CountUp
              value={isLiability ? -balance : balance}
              format={(n) => formatCurrency(n)}
              className={
                'text-hero-number block ' +
                (isLiability || balance < 0 ? 'text-destructive' : 'text-foreground')
              }
            />
          ) : (
            <p className="text-hero-number text-muted-foreground">—</p>
          )}

          {availableDiffers && available != null && (
            <p className="text-xs text-muted-foreground">
              Available · {formatCurrency(available)}
            </p>
          )}

          {latestBalance?.date && (
            <p className="text-xs text-muted-foreground">
              Bank balance from last import ·{' '}
              {new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(
                new Date(latestBalance.date),
              )}
            </p>
          )}

          <div className="border-t border-border/40 pt-4 space-y-4">
            {/* Type editor */}
            <div className="flex items-end gap-3">
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Account type</Label>
                <Select
                  value={currentType}
                  onValueChange={(v) => setSelectedType(v)}
                >
                  <SelectTrigger className="h-8 w-[200px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {TYPE_OPTIONS.map((o) => (
                      <SelectItem key={o.value} value={o.value}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Button
                variant="outline"
                size="sm"
                disabled={patchType.isPending || currentType === account.type}
                onClick={() => void handleSaveType()}
              >
                {patchType.isPending ? 'Saving…' : 'Save'}
              </Button>
            </div>

            {/* Delete */}
            <Button
              variant="ghost"
              size="sm"
              className="text-destructive hover:text-destructive hover:bg-destructive/10 -ml-1"
              disabled={deleteAccount.isPending}
              onClick={() => setConfirmOpen(true)}
            >
              <Trash2 className="h-4 w-4 mr-2" />
              {deleteAccount.isPending ? 'Deleting…' : 'Delete account'}
            </Button>
          </div>
        </div>

        {/* Transactions */}
        <h2 className="text-xl font-medium text-foreground mb-4">Transactions</h2>
        {txnsLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-14 w-full rounded-xl" />
            ))}
          </div>
        ) : transactions.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">
            No transactions on this account yet.
          </div>
        ) : (
          <TransactionList transactions={transactions} />
        )}
      </motion.div>
    </div>
  )
}
