// Dashboard — monthly spending hero + cumulative spend line chart, month navigator,
// net worth + net cashflow small cards, recent activity.
// Mirrors iOS HomeView after the Jul 2026 redesign.

import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowLeftRight, ChevronLeft, ChevronRight, TrendingUp } from 'lucide-react'
import { TransactionList } from '@/features/transactions/TransactionList'
import { ErrorState } from '@/components/ErrorState'
import { CategoryPickerDialog } from '@/components/finance/CategoryPickerDialog'
import { SpendDonutChart } from '@/components/finance/SpendDonutChart'
import { TrendAreaChart } from '@/components/finance/TrendAreaChart'
import { Skeleton } from '@/components/ui/skeleton'
import {
  useCurrentNetWorth,
  useMyProfile,
  useRecent,
  useSetCategory,
  useTransactionsMonth,
  useAccounts,
  useSpendByCategory,
  useCategoryGroups,
} from '@/data/hooks'
import {
  cumulativeSpend,
  netSpendMTD,
  netCashflowMTD,
} from '@/lib/dashboard'
import { getGreeting } from '@/lib/greeting'
import { CountUp } from '@/lib/motion'
import { formatCurrency } from '@/lib/money'
import { cn } from '@/lib/utils'
import type { Transaction, UUID } from '@/types/domain'

// ─── helpers ────────────────────────────────────────────────────────────────

function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1)
}

function addMonths(d: Date, delta: number): Date {
  return new Date(d.getFullYear(), d.getMonth() + delta, 1)
}

const MONTH_FMT = new Intl.DateTimeFormat('en-US', { month: 'short', year: 'numeric' })

// ─── page ────────────────────────────────────────────────────────────────────

export default function DashboardPage() {
  const todayMonth = useMemo(() => startOfMonth(new Date()), [])
  const [selectedMonth, setSelectedMonth] = useState<Date>(todayMonth)

  const isCurrentMonth =
    selectedMonth.getFullYear() === todayMonth.getFullYear() &&
    selectedMonth.getMonth() === todayMonth.getMonth()

  const monthTxnsQuery = useTransactionsMonth(selectedMonth)
  const recentQuery = useRecent(8)
  const currentNwQuery = useCurrentNetWorth()
  const profileQuery = useMyProfile()
  const spendByCategoryQuery = useSpendByCategory(selectedMonth)
  const categoryGroupsQuery = useCategoryGroups()

  const { data: monthTxns = [], isLoading: monthLoading } = monthTxnsQuery
  const { data: recent = [], isLoading: recentLoading } = recentQuery
  const { data: currentNw } = currentNwQuery
  const { data: accountsList = [] } = useAccounts()
  const { data: spendRows = [] } = spendByCategoryQuery
  const { data: categoryGroups = [] } = categoryGroupsQuery
  const firstName = profileQuery.data?.first_name ?? null

  const accountsById = useMemo(
    () => new Map(accountsList.map((a) => [a.id, a])),
    [accountsList],
  )

  const [selected, setSelected] = useState<Transaction | null>(null)
  const setCategory = useSetCategory()

  const netSpend = netSpendMTD(monthTxns)
  const netCashflow = netCashflowMTD(monthTxns)

  // X-axis: always 1 → last day of the selected month (28/29/30/31)
  const xMax = useMemo(() => {
    const lastDay = new Date(selectedMonth.getFullYear(), selectedMonth.getMonth() + 1, 0)
    return lastDay.getDate()
  }, [selectedMonth])

  // Cumulative spend line data: [{day, total}, ...]
  // Produces a point for every day from 1 to the last plottable day so the line
  // always starts at day 1 (value 0) and carries the running total forward on
  // days without transactions. On the current month the line stops at today;
  // on past months it extends to the end of the month. The x-axis domain (xMax)
  // always spans the full month regardless.
  const spendLine = useMemo(() => {
    const sparse = cumulativeSpend(monthTxns)
    const byDay = new Map(sparse.map((p) => [p.day, p.total]))
    const lastPlotDay = isCurrentMonth ? new Date().getDate() : xMax
    const result: { day: number; total: number }[] = []
    let running = 0
    for (let d = 1; d <= lastPlotDay; d++) {
      if (byDay.has(d)) running = byDay.get(d)!
      result.push({ day: d, total: running })
    }
    return result
  }, [monthTxns, xMax, isCurrentMonth])

  // Y-axis domain: floor at 75% of the first point so step variance fills the chart
  // instead of compressing against a zero baseline. If all zero (no spend), let
  // Recharts auto-scale (undefined).
  const spendDomain = useMemo((): [number, number] | undefined => {
    if (spendLine.length < 2) return undefined
    const max = spendLine[spendLine.length - 1].total
    if (max === 0) return undefined
    const min = spendLine[0].total
    const floor = Math.max(0, min * 0.75)
    const ceil = max * 1.08
    return [floor, ceil]
  }, [spendLine])

  const netWorth = currentNw ? Number(currentNw.net_worth) : null

  const greeting = getGreeting(firstName)

  function stepMonth(delta: number) {
    setSelectedMonth((prev) => addMonths(prev, delta))
  }

  return (
    <div className="pt-4 md:pt-6">
      {/* Two-column layout on lg+: left = summary, right = recent activity */}
      <div className="lg:grid lg:grid-cols-[1fr_380px] lg:gap-8 xl:grid-cols-[1fr_420px]">

        {/* ── Left column ─────────────────────────────────────────────── */}
        <div className="space-y-6">

          {/* Personalized greeting */}
          <p className="text-lg font-medium text-foreground tracking-tight">{greeting}</p>

          {/* Monthly spending hero card */}
          <section className="card-surface p-6 space-y-4">

            {/* Month navigator */}
            <div className="flex items-center justify-between">
              <button
                type="button"
                onClick={() => stepMonth(-1)}
                aria-label="Previous month"
                className="flex h-8 w-8 items-center justify-center rounded-full bg-surface-container text-primary transition-colors hover:bg-surface-container-high"
              >
                <ChevronLeft className="h-4 w-4" aria-hidden />
              </button>

              <p className="eyebrow tracking-widest">
                {MONTH_FMT.format(selectedMonth).toUpperCase()}
              </p>

              <button
                type="button"
                onClick={() => stepMonth(1)}
                disabled={isCurrentMonth}
                aria-label="Next month"
                className={cn(
                  'flex h-8 w-8 items-center justify-center rounded-full transition-colors',
                  isCurrentMonth
                    ? 'cursor-not-allowed bg-surface-container text-muted-foreground opacity-40'
                    : 'bg-surface-container text-primary hover:bg-surface-container-high',
                )}
              >
                <ChevronRight className="h-4 w-4" aria-hidden />
              </button>
            </div>

            {/* Big spend number */}
            <div>
              <p className="text-xs text-muted-foreground mb-1">Monthly Spending</p>
              {monthLoading ? (
                <Skeleton className="h-12 w-48" />
              ) : (
                <CountUp
                  value={netSpend}
                  format={formatCurrency}
                  className="text-hero-number text-foreground"
                />
              )}
            </div>

            {/* Cumulative spend line chart */}
            {monthLoading ? (
              <Skeleton className="h-52 w-full" />
            ) : (
              <TrendAreaChart
                data={spendLine}
                yKey="total"
                xKey="day"
                xType="number"
                gradientId="dash-spend"
                color="hsl(var(--brand))"
                height={200}
                tooltipLabel="Cumulative spend"
                valueFormatter={formatCurrency}
                labelFormatter={(label) => `Day ${label}`}
                ariaLabel="Cumulative monthly spending"
                yDomain={spendDomain}
                xDomain={[1, xMax]}
              />
            )}
          </section>

          {/* Net worth + net cashflow — half-width side by side */}
          <section className="grid grid-cols-2 gap-4" aria-label="Financial stats">
            <Link to="/accounts" className="block rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background">
              <StatCard
                label="Net Worth"
                amount={netWorth}
                isLoading={currentNwQuery.isLoading}
                icon="nw"
              />
            </Link>
            <StatCard
              label="Monthly Net Cashflow"
              amount={netCashflow}
              isLoading={monthLoading}
              icon="net"
            />
          </section>

          {/* Spend breakdown donut */}
          <section className="card-surface p-5 space-y-3">
            <h2 className="text-sm font-semibold text-foreground">Spending by Category</h2>
            {spendByCategoryQuery.isLoading ? (
              <div className="flex items-center justify-center py-10">
                <Skeleton className="h-[280px] w-[280px] rounded-full" />
              </div>
            ) : (
              <SpendDonutChart
                spendRows={spendRows}
                groups={categoryGroups}
                totalSpend={netSpend}
              />
            )}
          </section>
        </div>

        {/* ── Right column: Recent Activity ───────────────────────────── */}
        <section className="mt-6 lg:mt-0 lg:sticky lg:top-6 lg:self-start">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-xl font-semibold leading-8 text-foreground">Recent Activity</h2>
            <Link
              to="/transactions"
              className="rounded-md px-1 text-sm font-medium text-primary transition-opacity duration-150 hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background motion-reduce:transition-none"
            >
              See All
            </Link>
          </div>
          {recentLoading ? (
            <div className="card-surface space-y-4 p-3 sm:p-4" aria-hidden>
              {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
                <div key={i} className="flex items-center gap-3">
                  <Skeleton className="h-10 w-10 rounded-full" />
                  <div className="flex-1 space-y-2">
                    <Skeleton className="h-4 w-1/3" />
                    <Skeleton className="h-3 w-1/5" />
                  </div>
                  <Skeleton className="h-4 w-16" />
                </div>
              ))}
            </div>
          ) : recentQuery.isError ? (
            <ErrorState onRetry={() => void recentQuery.refetch()} error={recentQuery.error} />
          ) : recent.length === 0 ? (
            <div className="rounded-xl border border-dashed border-outline-variant p-8 text-center">
              <p className="text-sm text-muted-foreground">No recent transactions.</p>
            </div>
          ) : (
            <div className="card-surface max-h-[32rem] overflow-y-auto overscroll-contain p-3 sm:p-4 lg:max-h-[calc(100dvh-9rem)]">
              <TransactionList transactions={recent} accounts={accountsById} onSelect={setSelected} />
            </div>
          )}
        </section>

      </div>

      <CategoryPickerDialog
        txn={selected}
        open={selected != null}
        onOpenChange={(o) => !o && setSelected(null)}
        onPick={(cid: UUID | null) => {
          if (selected) setCategory.mutate({ txn: selected, categoryId: cid })
          setSelected(null)
        }}
      />
    </div>
  )
}

// ─── Half-width stat card ─────────────────────────────────────────────────────

function StatCard({
  label,
  amount,
  isLoading,
  icon,
}: {
  label: string
  amount: number | null
  isLoading: boolean
  icon: 'nw' | 'net'
}) {
  const Icon = icon === 'nw' ? TrendingUp : ArrowLeftRight

  const amountColor =
    amount == null
      ? 'text-foreground'
      : icon === 'nw'
        ? amount < 0
          ? 'text-destructive'
          : 'text-foreground'
        : amount >= 0
          ? 'text-money-income'
          : 'text-destructive'

  return (
    <div className="card-surface p-4">
      <div className="mb-3 flex items-center gap-2">
        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-surface-container text-primary">
          <Icon className="h-4 w-4" aria-hidden />
        </div>
        <p className="text-xs text-muted-foreground leading-tight">{label}</p>
      </div>
      {isLoading || amount == null ? (
        <Skeleton className="h-7 w-24" />
      ) : (
        <p className={cn('text-xl font-bold tabular-nums', amountColor)}>
          {formatCurrency(amount)}
        </p>
      )}
    </div>
  )
}
