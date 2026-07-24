// Balances — a single card that groups all the net-worth figures (total +
// Liquid / Semi-liquid / Liabilities) with the Sync button, the net-worth
// trend, and a T-account of accounts (Assets on the left, Liabilities on the
// right) plus manual "separate" accounts. Terracotta/sage design system.

import { useMemo, useState } from 'react'
import { Plus, RefreshCw, Trash2, Wallet } from 'lucide-react'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { AddSeparateAccountDialog } from '@/components/finance/AddSeparateAccountDialog'
import { InstitutionLogo } from '@/components/finance/InstitutionLogo'
import { InlineNetWorthTrend } from '@/components/finance/InlineNetWorthTrend'
import { ErrorState } from '@/components/ErrorState'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  useAccountsWithBalance,
  useCurrentNetWorth,
  useHideAccount,
  useNetWorth,
  usePlaidItems,
  useSeparateAccounts,
  useSyncInProgress,
  useTriggerSync,
} from '@/data/hooks'
import {
  DEFAULT_RANGE_IDX,
  NET_WORTH_RANGES,
} from '@/lib/netWorthTrend'
import { CountUp } from '@/lib/motion'
import { formatCurrency } from '@/lib/money'
import { formatShortDate } from '@/lib/dates'
import { isLiabilityType, liquidityBucket, type Account } from '@/types/domain'
import { cn } from '@/lib/utils'

// Plaid free trial tier caps a user at 10 linked Items (see plaid_client.py,
// SettingsView "10 banks, no card"). Hide the add-account CTA past that ceiling.
const MAX_PLAID_CONNECTIONS = 10

// Assets-first ordering within a column (depository, then investment, then debt).
const TYPE_ORDER: Record<string, number> = {
  depository: 0,
  investment: 1,
  other: 2,
  credit: 3,
  loan: 4,
}

const TYPE_LABEL: Record<string, string> = {
  depository: 'Checking & Savings',
  investment: 'Investment',
  other: 'Other asset',
  credit: 'Credit Card',
  loan: 'Loan',
}

/** Liabilities render sign-flipped to net-worth convention in neutral dark text
 *  (never red): debt "-$3,240.12", an overpaid card "$50.00". */
function balanceDisplay(type: string, bal: number): string {
  return formatCurrency(isLiabilityType(type) ? -bal : bal)
}

/** A single row in either column of the T-account. `account` is present only for
 *  Plaid accounts (they can be hidden); manual accounts have `separateId` instead. */
type LedgerRow = {
  id: string
  to: string
  name: string
  subtitle: string
  type: string
  balance: number
  logo: string | null
  institution: string
  account: Account | null
}

function LedgerRowView({
  row,
  onDeleteClick,
}: {
  row: LedgerRow
  onDeleteClick: (account: Account, institution: string) => void
}) {
  return (
    <div className="group flex items-center border-b border-outline-variant/30 last:border-0">
      <Link
        to={row.to}
        className="flex min-w-0 flex-1 items-center gap-3 px-4 py-3 transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        {row.account ? (
          <InstitutionLogo logo={row.logo} className="h-7 w-7" />
        ) : (
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-border bg-card text-primary shadow-card">
            <Wallet className="h-3.5 w-3.5" aria-hidden />
          </div>
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm text-foreground">{row.name}</p>
          <p className="truncate text-xs font-medium tracking-wide text-muted-foreground">
            {row.subtitle}
          </p>
        </div>
        <span className="shrink-0 text-base font-semibold tabular-nums tracking-tight text-foreground">
          {balanceDisplay(row.type, row.balance)}
        </span>
      </Link>
      {/* Fixed trailing gutter on EVERY row (delete button for Plaid accounts, an
          empty placeholder otherwise) so balances line up down the column. */}
      {row.account ? (
        <button
          type="button"
          aria-label={`Delete ${row.name}`}
          onClick={() => row.account && onDeleteClick(row.account, row.institution)}
          className="mr-3 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:bg-destructive/10 hover:text-destructive focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
        >
          <Trash2 aria-hidden className="h-4 w-4" />
        </button>
      ) : (
        <div className="mr-3 h-8 w-8 shrink-0" aria-hidden />
      )}
    </div>
  )
}

/** Two-step dialog shown when the user clicks the delete button on an account row.
 *  Explains what "delete" means for a Plaid account (soft-hide, not full removal). */
function DeleteAccountDialog({
  account,
  institutionName,
  onConfirm,
  onCancel,
  isPending,
}: {
  account: Account
  institutionName: string
  onConfirm: () => void
  onCancel: () => void
  isPending: boolean
}) {
  return (
    <AlertDialog open onOpenChange={(v) => !v && onCancel()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {account.name}?</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-3 text-sm text-muted-foreground">
              <p>
                Plaid connects banks at the institution level, not per-account. Deleting this
                account hides it from your balances and stops it from affecting your net worth
                — but your <strong className="text-foreground">{institutionName}</strong> connection
                stays active and your other accounts there will keep syncing.
              </p>
              <p>
                This account's transactions stay in your history. To permanently remove everything
                — including all transactions — go to{' '}
                <strong className="text-foreground">Settings → Linked Banks</strong> and unlink{' '}
                {institutionName} entirely.
              </p>
              <p className="font-medium text-foreground">
                Hide {account.name} from your balances?
              </p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <button
            type="button"
            onClick={onCancel}
            className="inline-flex h-10 items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium ring-offset-background transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={isPending}
            className="inline-flex h-10 items-center justify-center rounded-md bg-destructive px-4 py-2 text-sm font-medium text-destructive-foreground ring-offset-background transition-colors hover:bg-destructive/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50"
          >
            {isPending ? 'Deleting…' : 'Delete account'}
          </button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

/** One net-worth figure in the grouped header (total or a bucket). */
function HeroStat({
  label,
  value,
  hint,
  emphasis,
  negativeSign,
}: {
  label: string
  value: number
  hint?: string
  emphasis?: boolean
  negativeSign?: boolean
}) {
  const shown = negativeSign ? -value : value
  return (
    <div className="min-w-0">
      <p className="eyebrow mb-1">{label}</p>
      {emphasis ? (
        <CountUp
          value={value}
          format={(n) => formatCurrency(n)}
          className={cn(
            'text-hero-number block',
            value < 0 ? 'text-destructive' : 'text-foreground',
          )}
        />
      ) : (
        <p className="text-2xl font-semibold tabular-nums tracking-tight text-foreground">
          {formatCurrency(shown)}
        </p>
      )}
      {hint && (
        <p className="mt-0.5 text-xs font-medium tracking-wide text-muted-foreground">{hint}</p>
      )}
    </div>
  )
}

/** One side of the T-account: a titled column with its running total and rows. */
function LedgerColumn({
  title,
  total,
  rows,
  emptyLabel,
  tone,
  onDeleteClick,
}: {
  title: string
  total: number
  rows: LedgerRow[]
  emptyLabel: string
  tone: 'asset' | 'liability'
  onDeleteClick: (account: Account, institution: string) => void
}) {
  const toneClass = tone === 'asset' ? 'text-income' : 'text-destructive'
  return (
    <div className="min-w-0">
      <div className="flex items-baseline justify-between gap-2 border-b border-outline-variant/40 px-4 py-3">
        <p className={cn('text-2xl font-bold tracking-tight', toneClass)}>{title}</p>
        <p className={cn('text-lg font-semibold tabular-nums tracking-tight', toneClass)}>
          {formatCurrency(total)}
        </p>
      </div>
      <div className="max-h-[380px] overflow-y-auto">
        {rows.length === 0 ? (
          <p className="px-4 py-4 text-sm text-muted-foreground">{emptyLabel}</p>
        ) : (
          rows.map((row) => (
            <LedgerRowView key={row.id} row={row} onDeleteClick={onDeleteClick} />
          ))
        )}
      </div>
    </div>
  )
}

export default function AccountsPage() {
  const accountsQuery = useAccountsWithBalance()
  const { data: accounts = [], isLoading } = accountsQuery
  const { data: separate = [] } = useSeparateAccounts()
  const { data: plaidItems = [] } = usePlaidItems()
  const { data: snapshots = [], isLoading: snapshotsLoading } = useNetWorth()

  // Range state drives the net-worth trend chart.
  const [rangeIdx, setRangeIdx] = useState(DEFAULT_RANGE_IDX)

  const [showAddSeparate, setShowAddSeparate] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<{
    account: Account
    institutionName: string
  } | null>(null)

  const sync = useTriggerSync()
  const syncing = useSyncInProgress()
  const busy = sync.isPending || syncing
  const hideAccount = useHideAccount()

  // Net worth + as-of date come from the current_net_worth view (same math as the
  // snapshot writer), keeping the headline consistent with the trend chart.
  const { data: currentNetWorth } = useCurrentNetWorth()
  const netWorth = currentNetWorth?.net_worth ?? 0
  const asOf = currentNetWorth?.as_of ?? null

  // Build the two T-account columns + the Liquid/Semi-liquid/Liabilities totals in
  // one pass: bucket every account (Plaid + manual) by liquidity, attach the Plaid
  // institution logo/name for the row, and sort assets-first within each column.
  const { assets, liabilities, totals } = useMemo(() => {
    const itemById = new Map(plaidItems.map((i) => [i.id, i]))
    const assetRows: LedgerRow[] = []
    const liabilityRows: LedgerRow[] = []
    let liquid = 0
    let semiLiquid = 0
    let liab = 0

    const meta = (type: string, subtype: string | null, mask: string | null, inst: string) => {
      const label = subtype
        ? subtype.charAt(0).toUpperCase() + subtype.slice(1)
        : (TYPE_LABEL[type] ?? type)
      return [inst, label, mask ? `•••• ${mask}` : null].filter(Boolean).join(' · ')
    }

    for (const a of accounts) {
      const item = a.plaid_item_id ? itemById.get(a.plaid_item_id) : undefined
      const institution = item?.institution_name ?? (a.plaid_item_id ? 'Linked bank' : 'Account')
      const bal = a.currentBalance ?? 0
      const bucket = liquidityBucket(a.type)
      const row: LedgerRow = {
        id: a.id,
        to: `/accounts/${a.id}`,
        name: a.name,
        subtitle: meta(a.type, a.subtype, a.mask, institution),
        type: a.type,
        balance: bal,
        logo: item?.institution_logo ?? null,
        institution,
        account: a,
      }
      if (bucket === 'liability') {
        liab += bal
        liabilityRows.push(row)
      } else {
        if (bucket === 'liquid') liquid += bal
        else semiLiquid += bal
        assetRows.push(row)
      }
    }

    for (const a of separate) {
      const bal = a.currentBalance ?? 0
      const bucket = liquidityBucket(a.type)
      const row: LedgerRow = {
        id: `sep-${a.id}`,
        to: `/accounts/separate/${a.id}`,
        name: a.name,
        subtitle: TYPE_LABEL[a.type] ?? a.type,
        type: a.type,
        balance: bal,
        logo: null,
        institution: 'Separate account',
        account: null,
      }
      if (bucket === 'liability') {
        liab += bal
        liabilityRows.push(row)
      } else {
        if (bucket === 'liquid') liquid += bal
        else semiLiquid += bal
        assetRows.push(row)
      }
    }

    // Group by type order (depository → investment → …), then largest balance by
    // magnitude at the top within each type; name breaks remaining ties.
    const byTypeThenMagnitude = (a: LedgerRow, b: LedgerRow) =>
      (TYPE_ORDER[a.type] ?? 99) - (TYPE_ORDER[b.type] ?? 99) ||
      Math.abs(b.balance) - Math.abs(a.balance) ||
      a.name.localeCompare(b.name)
    assetRows.sort(byTypeThenMagnitude)
    liabilityRows.sort(byTypeThenMagnitude)

    return {
      assets: assetRows,
      liabilities: liabilityRows,
      totals: { liquid, semiLiquid, liabilities: liab },
    }
  }, [accounts, separate, plaidItems])

  const onDeleteClick = (account: Account, institution: string) =>
    setDeleteTarget({ account, institutionName: institution })

  return (
    <div className="flex flex-col gap-6 pt-4 md:gap-8 md:pt-8">
      <h1 className="sr-only">Balances</h1>

      <section className="relative overflow-hidden card-surface p-6 md:p-8">
        {/* Grouped net-worth header: total + Liquid/Semi-liquid/Liabilities + Sync */}
        <div className="flex items-start justify-between gap-4">
          <HeroStat
            label="Total Net Worth"
            value={netWorth}
            hint={asOf ? `As of ${formatShortDate(asOf)}` : undefined}
            emphasis
          />
          <Button
            variant="outline"
            className="h-10 shrink-0 gap-2 rounded-full border-border bg-card px-4 text-muted-foreground shadow-none hover:bg-surface-container-high hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => sync.mutate()}
            disabled={busy}
          >
            <RefreshCw className={cn('h-4 w-4', busy && 'animate-spin')} aria-hidden />
            {syncing ? 'Syncing…' : 'Sync'}
          </Button>
        </div>

        <div className="mt-5 grid grid-cols-2 gap-4 sm:grid-cols-3">
          <HeroStat label="Liquid" value={totals.liquid} hint="Cash & checking" />
          <HeroStat
            label="Semi-liquid"
            value={totals.semiLiquid}
            hint="Investments & retirement"
          />
          <HeroStat
            label="Liabilities"
            value={totals.liabilities}
            hint="Credit & loans"
            negativeSign
          />
        </div>

        {/* Net-worth trend */}
        <div className="mt-8 space-y-4 border-t border-outline-variant/30 pt-6">
          <InlineNetWorthTrend
            snapshots={snapshots}
            isLoading={snapshotsLoading}
            rangeIdx={rangeIdx}
          />
          <div
            className="inline-flex rounded-lg border border-border bg-card p-0.5"
            role="group"
            aria-label="Chart range"
          >
            {NET_WORTH_RANGES.map((r, i) => (
              <button
                key={r.label}
                type="button"
                onClick={() => setRangeIdx(i)}
                aria-pressed={i === rangeIdx}
                className={cn(
                  'rounded-md px-3 py-1 text-xs font-medium transition-colors',
                  i === rangeIdx
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:bg-surface-container-high',
                )}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>

        {/* T-account: Assets on the left, Liabilities on the right */}
        <div className="mt-8 border-t border-outline-variant/30 pt-6">
          {isLoading && <p className="px-1 py-2 text-sm text-muted-foreground">Loading…</p>}

          {accountsQuery.isError ? (
            <ErrorState
              onRetry={() => void accountsQuery.refetch()}
              error={accountsQuery.error}
              message="We couldn't load your accounts. Check your connection and try again."
            />
          ) : (
            <div className="overflow-hidden rounded-xl border border-outline-variant/40">
              <div className="grid grid-cols-1 divide-y divide-outline-variant/40 md:grid-cols-2 md:divide-x md:divide-y-0">
                <LedgerColumn
                  title="Assets"
                  total={totals.liquid + totals.semiLiquid}
                  rows={assets}
                  emptyLabel="No asset accounts yet."
                  tone="asset"
                  onDeleteClick={onDeleteClick}
                />
                <LedgerColumn
                  title="Liabilities"
                  total={-totals.liabilities}
                  rows={liabilities}
                  emptyLabel="No debts — nice."
                  tone="liability"
                  onDeleteClick={onDeleteClick}
                />
              </div>
            </div>
          )}

          {/* Big, boxy add-account CTA. Hidden once the user hits the Plaid
              free-tier ceiling of 10 linked banks (MAX_PLAID_CONNECTIONS). */}
          {plaidItems.length < MAX_PLAID_CONNECTIONS && (
            <div className="mt-6 flex justify-center">
              <Button
                className="h-16 gap-2 rounded-lg px-10 text-base font-semibold"
                onClick={() => setShowAddSeparate(true)}
              >
                <Plus className="h-5 w-5" aria-hidden />
                Add account
              </Button>
            </div>
          )}
        </div>
      </section>

      <AddSeparateAccountDialog open={showAddSeparate} onOpenChange={setShowAddSeparate} />

      {deleteTarget && (
        <DeleteAccountDialog
          account={deleteTarget.account}
          institutionName={deleteTarget.institutionName}
          isPending={hideAccount.isPending}
          onConfirm={() => {
            toast.promise(hideAccount.mutateAsync(deleteTarget.account.id), {
              loading: `Deleting ${deleteTarget.account.name}…`,
              success: `${deleteTarget.account.name} deleted`,
              error: (e) => (e instanceof Error ? e.message : 'Could not delete account'),
            })
            setDeleteTarget(null)
          }}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
    </div>
  )
}
