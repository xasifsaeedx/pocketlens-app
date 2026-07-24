// Transactions — terracotta/sage layout: search + month filter chips up top, day-grouped
// list in the main column, and (desktop) a right sidebar with the monthly spending summary
// and Top Category cards derived from the already-fetched month of transactions.
// Search is server-side across all months (search_transactions RPC); while a query is active
// the month chips and the month-scoped sidebar hide (results are capped at the newest 50).
// Keeps the Transfers tab (?tab=transfers) and the "To Categorize" swipe review.
// Mirrors PocketLens/Views/Transactions/TransactionsView.swift.

import { createElement, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { ArrowUpRight, ChevronLeft, Download, Filter, RotateCcw, Search, WandSparkles, X } from 'lucide-react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { TransactionList } from '@/features/transactions/TransactionList'
import { ErrorState } from '@/components/ErrorState'
import { TransfersTab } from '@/features/transactions/TransfersTab'
import { CategorizeReview } from '@/features/transactions/CategorizeReview'
import { CategoryPickerDialog } from '@/components/finance/CategoryPickerDialog'
import { BulkCategorizePrompt, type BulkPrompt } from '@/components/finance/BulkCategorizePrompt'
import { ProgressBar } from '@/components/finance/ProgressBar'
import { SavedViewsMenu } from '@/components/finance/SavedViewsMenu'
import { iconForSymbol } from '@/lib/iconMap'
import { categoryTint, categorySeriesColor } from '@/lib/categoryColors'
import { CountUp } from '@/lib/motion'
import {
  useBulkCategorizeMerchant,
  useAccounts,
  useCategories,
  useRecurringSeries,
  useSetCategory,
  useSpendByCategory,
  useTags,
  useTransactionSearch,
  useTransactionsMonthAll,
  useUncategorized,
} from '@/data/hooks'
import { useDebouncedValue } from '@/hooks/use-debounce'
import { SEARCH_LIMIT, uncategorizedSameMerchant } from '@/data/transactions'
import { formatCurrency } from '@/lib/money'
import { downloadCsv, transactionsToCsv } from '@/lib/exportCsv'
import { formatMonthLabel } from '@/lib/dates'
import { cn } from '@/lib/utils'
import {
  displayName,
  merchantKey,
  sumIncome,
  sumNetSpend,
  txnTags,
  type Transaction,
  type UUID,
} from '@/types/domain'

function sameMonth(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth()
}

/** "Jun 2026" — compact chip label. */
function chipMonthLabel(d: Date): string {
  return d.toLocaleDateString(undefined, { month: 'short', year: 'numeric' })
}

const filterChip = (active: boolean) =>
  cn(
    'whitespace-nowrap rounded-full px-4 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary active:scale-95',
    active
      ? 'bg-primary text-primary-foreground shadow-sm'
      : 'border border-border bg-card text-muted-foreground hover:bg-surface-container-high',
  )

/** Sidebar: monthly spending summary + Top Category + Recurring Charges, derived from the fetched month. */
function TransactionsSidebar({
  month,
  spent,
  income,
  counted,
}: {
  month: Date
  spent: number
  income: number
  counted: Transaction[]
}) {
  const { data: spendRows = [] } = useSpendByCategory(month)
  const { data: recurringSeries = [], isLoading: recurringLoading } = useRecurringSeries()

  const daysInMonth = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate()
  const { daily, maxDay } = useMemo(() => {
    const daily = new Array<number>(daysInMonth).fill(0)
    for (const t of counted) {
      if (t.amount <= 0) continue
      const day = Number(t.effective_date.slice(8, 10))
      if (day >= 1 && day <= daysInMonth) daily[day - 1] += t.amount
    }
    let maxDay = 0
    daily.forEach((v, i) => {
      if (v > daily[maxDay]) maxDay = i
    })
    return { daily, maxDay }
  }, [counted, daysInMonth])
  const maxSpend = Math.max(...daily, 1)

  // Biggest spend category this month, from the category_spend view (rows arrive
  // sorted by spend desc). Over-reimbursed categories can go negative, so guard > 0.
  const top = useMemo(() => {
    const best = spendRows[0]
    return best && best.total > 0 ? { category: best.category, amount: best.total } : null
  }, [spendRows])

  // Recurring summary — active (non-ignored) series + monthly estimate.
  const activeRecurring = useMemo(
    () => recurringSeries.filter((s) => s.status !== 'ignored'),
    [recurringSeries],
  )
  const PER_MONTH_FACTORS: Record<string, number> = {
    weekly: 52 / 12,
    biweekly: 26 / 12,
    monthly: 1,
    yearly: 1 / 12,
  }
  const recurringMonthly = useMemo(
    () =>
      activeRecurring.reduce(
        (sum, s) => sum + Math.abs(s.avgAmount) * (PER_MONTH_FACTORS[s.cadence] ?? 1),
        0,
      ),
    [activeRecurring],
  )

  const monthShort = month.toLocaleDateString(undefined, { month: 'short' })
  const topPct = top && spent > 0 ? Math.round((top.amount / spent) * 100) : 0

  return (
    <aside className="flex w-full shrink-0 flex-col gap-6 lg:w-[360px]">
      <div className="flex flex-col gap-4 card-surface p-6">
        <div>
          {/* Wording keeps "Spent" on the page — e2e smoke asserts getByText('Spent') */}
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Spent in {formatMonthLabel(month)}
          </h3>
          <CountUp
            value={spent}
            format={(n) => formatCurrency(n)}
            className="mt-1 block text-4xl font-bold tracking-tight tabular-nums text-foreground"
          />
          {/* Always rendered (even $0) — the month's Income total shouldn't
              vanish, and e2e smoke asserts getByText('Income'). */}
          <p className="mt-3 flex items-center gap-1 text-sm">
            <ArrowUpRight aria-hidden="true" className="h-3.5 w-3.5 text-secondary" />
            <span className="font-medium text-muted-foreground">Income</span>
            <span className="ml-auto font-semibold tabular-nums text-secondary">
              +{formatCurrency(income)}
            </span>
          </p>
        </div>
        <div>
          <div
            aria-hidden="true"
            className="relative flex h-16 w-full items-end gap-px border-b border-border"
          >
            {daily.map((v, i) => (
              <div
                key={i}
                className={cn(
                  'flex-1 rounded-t-sm',
                  i === maxDay && v > 0 ? 'bg-primary' : 'bg-surface-variant',
                )}
                style={{ height: `${Math.max((v / maxSpend) * 100, 3)}%` }}
              />
            ))}
          </div>
          <div className="mt-1 flex justify-between text-xs font-semibold text-muted-foreground opacity-70">
            <span>{monthShort} 1</span>
            <span>{monthShort} 15</span>
            <span>
              {monthShort} {daysInMonth}
            </span>
          </div>
        </div>
      </div>

      {top && (
        <div className="flex flex-col gap-4 card-surface p-6">
          <h3 className="text-xl font-medium text-foreground">Top Category</h3>
          <div className="flex items-center gap-4">
            <span
              aria-hidden="true"
              style={{
                backgroundColor: categoryTint(top.category.color),
                color: categorySeriesColor(top.category),
              }}
              className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full"
            >
              {createElement(iconForSymbol(top.category.icon), { className: 'h-5 w-5' })}
            </span>
            <div className="flex min-w-0 flex-1 flex-col">
              <div className="mb-1 flex items-center justify-between gap-2">
                <span className="truncate text-sm font-semibold text-foreground">
                  {top.category.name}
                </span>
                <span className="text-sm font-medium tabular-nums text-foreground">
                  {formatCurrency(top.amount)}
                </span>
              </div>
              <ProgressBar value={topPct} trackClassName="bg-surface-container-low" />
              <span className="mt-1 text-xs font-semibold text-muted-foreground">
                {topPct}% of this month's spending
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Recurring Charges summary card */}
      {!recurringLoading && (
        <Link
          to="/recurring"
          className="group flex flex-col gap-4 card-surface p-6 transition-shadow hover:shadow-card-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          <div className="flex items-center justify-between">
            <h3 className="text-xl font-medium text-foreground">Recurring Charges</h3>
            <ArrowUpRight
              aria-hidden="true"
              className="h-4 w-4 shrink-0 text-muted-foreground transition-colors group-hover:text-primary"
            />
          </div>
          {activeRecurring.length === 0 ? (
            <p className="text-sm text-muted-foreground">No recurring charges detected yet.</p>
          ) : (
            <>
              <div className="flex items-baseline gap-1">
                <CountUp
                  value={recurringMonthly}
                  format={(n) => formatCurrency(n)}
                  className="text-3xl font-bold tracking-tight tabular-nums text-foreground"
                />
                <span className="text-sm font-medium text-muted-foreground">/mo</span>
              </div>
              <div className="flex flex-col gap-2">
                {activeRecurring.slice(0, 3).map((s) => (
                  <div key={s.merchantKey} className="flex items-center gap-2">
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                      <RotateCcw className="h-3.5 w-3.5" aria-hidden />
                    </span>
                    <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                      {s.displayName}
                    </span>
                    <span className="shrink-0 text-sm font-medium tabular-nums text-muted-foreground">
                      {formatCurrency(Math.abs(s.avgAmount))}
                    </span>
                  </div>
                ))}
                {activeRecurring.length > 3 && (
                  <p className="text-xs text-muted-foreground">
                    +{activeRecurring.length - 3} more
                  </p>
                )}
              </div>
            </>
          )}
        </Link>
      )}
    </aside>
  )
}

export default function AllTransactionsPage() {
  const [month, setMonth] = useState(() => new Date())
  const [monthsShown, setMonthsShown] = useState(12)
  const chipRowRef = useRef<HTMLDivElement>(null)
  // Mouse wheel fires deltaY; browsers register wheel listeners as passive by default
  // so we must attach a native listener with { passive: false } to call preventDefault()
  // and redirect vertical scroll to horizontal on the chip row.
  useEffect(() => {
    const el = chipRowRef.current
    if (!el) return
    const handler = (e: WheelEvent) => {
      if (e.deltaY === 0) return
      e.preventDefault()
      el.scrollBy({ left: e.deltaY, behavior: 'auto' })
    }
    el.addEventListener('wheel', handler, { passive: false })
    return () => el.removeEventListener('wheel', handler)
  }, [])
  const [searchParams, setSearchParams] = useSearchParams()
  const tab = searchParams.get('tab') === 'transfers' ? 'transfers' : 'transactions'
  function setTab(next: string) {
    setSearchParams(
      (prev) => {
        const p = new URLSearchParams(prev)
        if (next === 'transfers') p.set('tab', 'transfers')
        else p.delete('tab')
        return p
      },
      { replace: true },
    )
  }
  // Include excluded/transfer rows so linked transfers stay visible + unlinkable; they're
  // kept out of the Spent/Income totals below.
  const monthQuery = useTransactionsMonthAll(month)
  const { data: txns = [], isLoading } = monthQuery
  const { data: uncategorized = [] } = useUncategorized(month)
  const { data: categories = [] } = useCategories()
  const { data: tags = [] } = useTags()
  const { data: accountsList = [] } = useAccounts()
  const setCategory = useSetCategory()
  const bulkCategorize = useBulkCategorizeMerchant()

  // Build an id→Account map for the row-level account label.
  const accountsById = useMemo(
    () => new Map(accountsList.map((a) => [a.id, a])),
    [accountsList],
  )

  const [selected, setSelected] = useState<Transaction | null>(null)
  const [bulkPrompt, setBulkPrompt] = useState<BulkPrompt | null>(null)
  const [reviewOpen, setReviewOpen] = useState(false)
  const [filterIds, setFilterIds] = useState<Set<UUID>>(new Set())
  const [tagFilterIds, setTagFilterIds] = useState<Set<UUID>>(new Set())
  const [hiddenOnly, setHiddenOnly] = useState(false)

  // Search spans all months (server-side, search_transactions RPC). While a query is
  // active the list operates on the results instead of the month, and the month chips +
  // month-scoped sidebar hide (results are capped at the newest 50 matches).
  const [searchText, setSearchText] = useState('')
  const debouncedQuery = useDebouncedValue(searchText)
  const searching = searchText.trim().length > 0
  const search = useTransactionSearch(debouncedQuery)
  const activeTxns = searching ? (search.data ?? []) : txns
  const activeLoading = searching ? search.isPending : isLoading
  const activeError = searching ? search.isError : monthQuery.isError
  const retryActive = () => void (searching ? search.refetch() : monthQuery.refetch())

  // Totals ignore excluded rows (transfers, manually excluded) — they net out, not spend/income.
  // Always month-scoped (the sidebar hides while searching, so no undercount is shown).
  // Memoized so the sidebar keeps a stable `counted` identity across renders.
  const { counted, spent, income } = useMemo(() => {
    const counted = txns.filter((t) => !t.exclude_from_totals)
    // Net spend + income exclude reimbursements (contra-expense).
    return { counted, spent: sumNetSpend(counted), income: sumIncome(counted) }
  }, [txns])

  const filterCount = filterIds.size + tagFilterIds.size + (hiddenOnly ? 1 : 0)

  // The search RPC caps its result at SEARCH_LIMIT rows, and the category/tag filters
  // below run over only that set — so a capped result filters an incomplete list. Flag
  // it (raw pre-filter count) so the truncation isn't silent.
  const searchTruncated = searching && (search.data?.length ?? 0) >= SEARCH_LIMIT

  // Text matching is server-side; here we only apply the category/tag/hidden filters
  // over the active set (month rows, or search results while searching).
  const filtered = useMemo(() => {
    return activeTxns.filter((t) => {
      if (hiddenOnly && !t.hidden) return false
      if (filterIds.size > 0 && !(t.category_id && filterIds.has(t.category_id))) return false
      if (tagFilterIds.size > 0 && !txnTags(t).some((tag) => tagFilterIds.has(tag.id)))
        return false
      return true
    })
  }, [activeTxns, filterIds, tagFilterIds, hiddenOnly])

  // Month filter chips — most recent first, extendable via the "Earlier" button.
  const monthOptions = useMemo(() => {
    const now = new Date()
    const list = Array.from(
      { length: monthsShown },
      (_, i) => new Date(now.getFullYear(), now.getMonth() - i, 1),
    )
    // Keep the selected month visible even if it's outside the shown window.
    if (!list.some((m) => sameMonth(m, month))) list.push(month)
    return list
  }, [monthsShown, month])

  /** Explicit categorization; when the merchant has more uncategorized txns, offer to
   *  bulk-apply — mirrors iOS TransactionsViewModel.updateCategory(offerBulk:). */
  async function pickCategory(txn: Transaction, categoryId: UUID | null) {
    await setCategory.mutateAsync({ txn, categoryId })
    const key = merchantKey(txn)
    if (!categoryId || !key) return
    const others = await uncategorizedSameMerchant(key, txn.id).catch(() => [])
    if (others.length > 0) {
      setBulkPrompt({
        merchantName: displayName(txn),
        merchantKey: key,
        categoryId,
        count: others.length,
      })
    }
  }

  /** Export the currently-shown transactions (month or search results, after filters) to CSV. */
  function exportCsv() {
    if (filtered.length === 0) return
    const stamp = searching
      ? 'search'
      : `${month.getFullYear()}-${String(month.getMonth() + 1).padStart(2, '0')}`
    downloadCsv(`transactions-${stamp}.csv`, transactionsToCsv(filtered, accountsById))
  }

  return (
    <div className="flex flex-col gap-6 pt-2 md:pt-4 lg:flex-row">
      <div className="flex min-w-0 flex-1 flex-col gap-5">
        <div className="flex items-center justify-between gap-3">
          <h1 className="text-2xl font-semibold text-foreground md:text-[2rem] md:leading-10">
            Transactions
          </h1>
          <button
            type="button"
            onClick={exportCsv}
            disabled={filtered.length === 0}
            className="flex shrink-0 items-center gap-2 rounded-full border border-border bg-card px-4 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-surface-container-high focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50"
          >
            <Download aria-hidden="true" className="h-4 w-4" />
            <span className="hidden sm:inline">Export CSV</span>
          </button>
        </div>

        {/* Search + filters (sticky on mobile, under the 72px top app bar) */}
        <div className="sticky top-[72px] z-30 -mx-4 flex flex-col gap-3 bg-background px-4 pb-1 md:static md:z-auto md:mx-0 md:bg-transparent md:px-0 md:pb-0">
          <div className="flex items-center gap-3">
            <div className="relative flex-1">
              <Search
                aria-hidden="true"
                className="pointer-events-none absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-muted-foreground"
              />
              <input
                type="search"
                value={searchText}
                onChange={(e) => setSearchText(e.target.value)}
                placeholder="Search transactions..."
                aria-label="Search transactions"
                className="w-full card-surface border border-border py-3 pl-10 pr-10 text-sm text-foreground transition-colors placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
              />
              {searchText && (
                <button
                  type="button"
                  onClick={() => setSearchText('')}
                  aria-label="Clear search"
                  className="absolute right-3 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                >
                  <X aria-hidden="true" className="h-4 w-4" />
                </button>
              )}
            </div>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  aria-label={filterCount > 0 ? `Filters, ${filterCount} active` : 'Filters'}
                  className="flex items-center gap-2 card-surface border border-border px-4 py-3 text-sm font-medium text-muted-foreground transition-colors hover:bg-surface-container-high focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                >
                  <Filter aria-hidden="true" className="h-4 w-4" />
                  <span className="hidden sm:inline">
                    {filterCount > 0 ? `${filterCount} filtered` : 'Filter'}
                  </span>
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="max-h-96 w-52 overflow-y-auto">
                <DropdownMenuLabel>Show</DropdownMenuLabel>
                <DropdownMenuCheckboxItem checked={hiddenOnly} onCheckedChange={setHiddenOnly}>
                  Hidden only
                </DropdownMenuCheckboxItem>
                <DropdownMenuLabel>Categories</DropdownMenuLabel>
                {categories.map((c) => (
                  <DropdownMenuCheckboxItem
                    key={c.id}
                    checked={filterIds.has(c.id)}
                    onCheckedChange={(v) =>
                      setFilterIds((prev) => {
                        const next = new Set(prev)
                        if (v) next.add(c.id)
                        else next.delete(c.id)
                        return next
                      })
                    }
                  >
                    {c.name}
                  </DropdownMenuCheckboxItem>
                ))}
                {tags.length > 0 && (
                  <>
                    <DropdownMenuLabel>Tags</DropdownMenuLabel>
                    {tags.map((t) => (
                      <DropdownMenuCheckboxItem
                        key={t.id}
                        checked={tagFilterIds.has(t.id)}
                        onCheckedChange={(v) =>
                          setTagFilterIds((prev) => {
                            const next = new Set(prev)
                            if (v) next.add(t.id)
                            else next.delete(t.id)
                            return next
                          })
                        }
                      >
                        {t.name}
                      </DropdownMenuCheckboxItem>
                    ))}
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
            <SavedViewsMenu
              categoryIds={filterIds}
              tagIds={tagFilterIds}
              onApply={(params) => {
                setFilterIds(new Set(params.categoryIds))
                setTagFilterIds(new Set(params.tagIds))
              }}
            />
          </div>

          {/* Month chips — hidden while searching (results span all months) */}
          {!searching && (
            <div ref={chipRowRef} className="no-scrollbar flex gap-2 overflow-x-auto pb-1 pt-0.5">
              {monthOptions.map((m) => (
                <button
                  key={`${m.getFullYear()}-${m.getMonth()}`}
                  onClick={() => setMonth(m)}
                  aria-pressed={sameMonth(m, month)}
                  className={filterChip(sameMonth(m, month))}
                >
                  {chipMonthLabel(m)}
                </button>
              ))}
              <button
                onClick={() => setMonthsShown((n) => n + 12)}
                aria-label="Show earlier months"
                className={filterChip(false)}
              >
                <ChevronLeft aria-hidden="true" className="-ml-1 mr-1 inline h-4 w-4" />
                Earlier
              </button>
            </div>
          )}
        </div>

        <Tabs value={tab} onValueChange={setTab}>
          <TabsList className="h-auto w-auto justify-start gap-2 rounded-none bg-transparent p-0">
            <TabsTrigger
              value="transactions"
              className="rounded-full border border-border bg-card px-4 py-2 text-muted-foreground data-[state=active]:border-transparent data-[state=active]:bg-primary data-[state=active]:text-primary-foreground"
            >
              Transactions
            </TabsTrigger>
            <TabsTrigger
              value="transfers"
              className="rounded-full border border-border bg-card px-4 py-2 text-muted-foreground data-[state=active]:border-transparent data-[state=active]:bg-primary data-[state=active]:text-primary-foreground"
            >
              Transfers
            </TabsTrigger>
          </TabsList>

          <TabsContent value="transactions" className="mt-5 space-y-5">
            {/* To Categorize banner */}
            {uncategorized.length > 0 && (
              <button
                onClick={() => setReviewOpen(true)}
                className="group flex w-full items-center gap-4 card-surface p-4 text-left transition-shadow hover:shadow-card-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              >
                <span
                  aria-hidden="true"
                  className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-surface-container-low text-primary"
                >
                  <WandSparkles className="h-5 w-5" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-foreground">
                    {uncategorized.length} to categorize
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    Review them one at a time
                  </span>
                </span>
                <span className="rounded-full bg-primary px-4 py-3 text-sm font-medium text-primary-foreground transition-colors group-hover:bg-primary/90">
                  Review
                </span>
              </button>
            )}

            {searchTruncated && !activeLoading && !activeError && (
              <p className="rounded-lg bg-surface-container-low px-3 py-2 text-xs text-muted-foreground">
                Showing the first {SEARCH_LIMIT} matches — refine your search to narrow it, as
                filters apply only to the results shown.
              </p>
            )}

            {activeLoading ? (
              <p className="px-1 text-sm text-muted-foreground">
                {searching ? 'Searching…' : 'Loading…'}
              </p>
            ) : activeError ? (
              <ErrorState onRetry={retryActive} error={searching ? search.error : monthQuery.error} />
            ) : filtered.length === 0 ? (
              <div className="rounded-xl border border-dashed border-outline-variant p-8 text-center text-sm text-muted-foreground">
                {searching
                  ? `No matches for “${searchText.trim()}”.`
                  : activeTxns.length === 0
                    ? 'No transactions this month.'
                    : 'No transactions match your filters.'}
              </div>
            ) : (
              <TransactionList transactions={filtered} accounts={accountsById} onSelect={setSelected} />
            )}
          </TabsContent>

          <TabsContent value="transfers" className="mt-5">
            <TransfersTab month={month} />
          </TabsContent>
        </Tabs>
      </div>

      {/* Spend summary is transactions-scoped and month-scoped — hide it on the Transfers
          tab and while searching (results span all months / are capped at 50). */}
      {tab === 'transactions' && !searching && (
        <TransactionsSidebar month={month} spent={spent} income={income} counted={counted} />
      )}

      <CategoryPickerDialog
        txn={selected}
        open={selected != null}
        onOpenChange={(o) => !o && setSelected(null)}
        onPick={(cid) => {
          if (selected) void pickCategory(selected, cid)
          setSelected(null)
        }}
      />

      <BulkCategorizePrompt
        prompt={bulkPrompt}
        onApply={(p) => {
          bulkCategorize.mutate({ merchantKey: p.merchantKey, categoryId: p.categoryId })
          setBulkPrompt(null)
        }}
        onDismiss={() => setBulkPrompt(null)}
      />

      {reviewOpen && (
        <CategorizeReview
          queue={uncategorized}
          open={reviewOpen}
          onOpenChange={setReviewOpen}
        />
      )}
    </div>
  )
}
