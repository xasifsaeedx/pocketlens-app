// Budgets — per spend-category monthly limits with spent-vs-limit progress.
// Mirrors PocketLens/Views/Budget/BudgetView.swift.
// Terracotta/sage restyle.

import { useMemo, useState } from 'react'
import { motion } from 'framer-motion'
import { useSearchParams } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { useMutation } from '@/demo/demoMutation'
import { CheckCircle2, ChevronLeft, ChevronRight, Lightbulb, PiggyBank, Settings2, Trash2, TriangleAlert } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useBudgetLimits, useCategories, useCategoryGroups, useDeleteCategory, useGroupBudgetLimits, useReport, useSaveGroupBudget, useDeleteGroupBudget, useSpendByCategory, useUncategorizedSpend, useUpsertCategory, useZbbSettings } from '@/data/hooks'
import { saveBudget, deleteBudget, resolveLimit, resolveLimits } from '@/data/budgets'
import { resolveGroupLimit, resolveGroupLimits } from '@/data/groupBudgets'
import { categoryHasSplits } from '@/data/categories'
import { sbKeys } from '@/data/hooks'
import ZbbBudgetView from '@/features/budgets/ZbbBudgetView'
import { CategoryIconWell } from '@/features/budgets/CategoryIconWell'
import { CategoryIcon } from '@/components/finance/CategoryIcon'
import { ManageCategoriesDialog } from '@/components/finance/ManageCategoriesDialog'
import { ManageCategoryGroupsDialog } from '@/components/finance/ManageCategoryGroupsDialog'
import { IconPicker } from '@/components/finance/IconPicker'
import { ProgressBar } from '@/components/finance/ProgressBar'
import { ErrorState } from '@/components/ErrorState'
import { formatMonthLabel } from '@/lib/dates'
import { formatCurrency } from '@/lib/money'
import { budgetPaceStatus } from '@/lib/budgetPace'
import {
  breakdownMotionContainer,
  breakdownMotionItem,
  rawSlicesFromRows,
  SpendPieCard,
} from '@/components/reports/SpendBreakdownCharts'
import { CountUp } from '@/lib/motion'
import { TAG_PALETTE } from '@/lib/tagColors'
import { cn } from '@/lib/utils'
import { type Category } from '@/types/domain'

const RING_RADIUS = 54
const RING_CIRC = 2 * Math.PI * RING_RADIUS // ≈ 339.292 (viewBox 0 0 120 120)

// Whole dollars for the hero ring center — cents don't fit the 48px display size.
const wholeCurrencyFmt = new Intl.NumberFormat(undefined, {
  style: 'currency',
  currency: 'USD',
  currencyDisplay: 'narrowSymbol', // bare "$" in every locale (see lib/money.ts)
  maximumFractionDigits: 0,
})

/** Segmented progress bar that shows each category's share of a group's total spend.
 *  Hovering a segment reveals a tooltip with the category name, $ amount, and % of group. */
function SegmentedGroupBar({
  cats,
  groupTotal,
}: {
  cats: Array<{ category: Category; total: number }>
  groupTotal: number
}) {
  const [tooltip, setTooltip] = useState<{
    name: string
    total: number
    pct: number
    x: number
    y: number
  } | null>(null)

  if (groupTotal <= 0 || cats.length === 0) {
    return (
      <div className="h-2 w-full overflow-hidden rounded-full bg-surface-container-high" aria-hidden />
    )
  }

  return (
    <div className="relative">
      <div
        className="flex h-2 w-full overflow-hidden rounded-full bg-surface-container-high"
        aria-hidden="true"
        onMouseLeave={() => setTooltip(null)}
      >
        {cats.map(({ category, total }) => {
          const segPct = (total / groupTotal) * 100
          return (
            <div
              key={category.id}
              className="h-full cursor-pointer transition-opacity hover:opacity-80"
              style={{ width: `${segPct}%`, backgroundColor: category.color }}
              onMouseEnter={(e) => {
                const rect = e.currentTarget.closest('.relative')!.getBoundingClientRect()
                const segRect = e.currentTarget.getBoundingClientRect()
                setTooltip({
                  name: category.name,
                  total,
                  pct: segPct,
                  x: segRect.left - rect.left + segRect.width / 2,
                  y: -8,
                })
              }}
            />
          )
        })}
      </div>
      {tooltip && (
        <div
          className="pointer-events-none absolute z-50 -translate-x-1/2 -translate-y-full rounded-lg bg-popover px-3 py-2 text-xs shadow-md ring-1 ring-border"
          style={{ left: tooltip.x, top: tooltip.y }}
        >
          <p className="font-semibold text-foreground">{tooltip.name}</p>
          <p className="text-muted-foreground">
            {formatCurrency(tooltip.total)} · {Math.round(tooltip.pct)}%
          </p>
        </div>
      )}
    </div>
  )
}

export default function BudgetsPage() {
  // Anchored to the first of a month so month arithmetic stays clean. Limits are effective-dated
  // (budget_limits), so each month resolves the limit that was in effect then — a past month shows
  // its true historical limit against that month's spend. The edit modal can write any month's
  // limit via its own navigator (initialized to this viewed month).
  const [month, setMonth] = useState(() => {
    const d = new Date()
    return new Date(d.getFullYear(), d.getMonth(), 1)
  })
  const [params, setParams] = useSearchParams()
  const { data: zbbSettings } = useZbbSettings()
  const categoriesQuery = useCategories()
  const budgetLimitsQuery = useBudgetLimits()
  const spendRowsQuery = useSpendByCategory(month)
  const uncategorizedSpendQuery = useUncategorizedSpend(month)
  const categoryGroupsQuery = useCategoryGroups()
  const { data: categories = [] } = categoriesQuery
  const { data: budgetLimits = [] } = budgetLimitsQuery
  const { data: spendRows = [] } = spendRowsQuery
  const { data: uncategorizedSpend = 0 } = uncategorizedSpendQuery
  const { data: categoryGroups = [] } = categoryGroupsQuery
  const groupBudgetLimitsQuery = useGroupBudgetLimits()
  const { data: groupBudgetLimits = [] } = groupBudgetLimitsQuery
  // Monthly report powers the savings-rate stat + the spend-by donuts (moved here from the
  // retired Reports page). Same viewed month as the rest of the page.
  const { data: report } = useReport(month.getFullYear(), month.getMonth() + 1)
  const saveGroupBudget = useSaveGroupBudget()
  const deleteGroupBudget = useDeleteGroupBudget()
  const qc = useQueryClient()

  // A failed fetch of any core budget dataset would otherwise read as "no budgets
  // set yet" — surface the error + Retry instead of that misleading zero state.
  const budgetsError = categoriesQuery.isError || budgetLimitsQuery.isError || spendRowsQuery.isError
  const retryBudgets = () => {
    void categoriesQuery.refetch()
    void budgetLimitsQuery.refetch()
    void spendRowsQuery.refetch()
  }

  // Move by whole months; never into the future (no spend/limits to show yet).
  function step(delta: number) {
    setMonth((m) => new Date(m.getFullYear(), m.getMonth() + delta, 1))
  }
  const today = new Date()
  const isCurrentMonth =
    month.getFullYear() === today.getFullYear() && month.getMonth() === today.getMonth()
  const monthLabel = formatMonthLabel(month)

  // Zero-sum is an opt-in advanced mode; flat monthly limits stay the default. The mode tab only
  // appears once the user enables ZBB in Settings.
  const zbbEnabled = zbbSettings?.enabled ?? false
  const mode = zbbEnabled && params.get('mode') === 'zbb' ? 'zbb' : 'flat'

  const [manageCategoriesOpen, setManageCategoriesOpen] = useState(false)
  const [manageCategoryGroupsOpen, setManageCategoryGroupsOpen] = useState(false)
  // Spend-breakdown donut toggles between per-category and per-group rollup (one card, not two).
  const [breakdownView, setBreakdownView] = useState<'category' | 'group'>('category')

  // Keep only the id in state — the editing category is derived fresh from `categories` so a
  // rename/recolor/re-icon (which invalidates the categories cache) shows immediately in the dialog.
  const [editingId, setEditingId] = useState<string | null>(null)
  const editing = editingId != null ? categories.find((c) => c.id === editingId) ?? null : null
  const [limitInput, setLimitInput] = useState('')
  const [nameInput, setNameInput] = useState('')
  const [iconPickerOpen, setIconPickerOpen] = useState(false)
  // The month the editor writes to — independent of the page's viewed `month` so the user can
  // set a specific month's limit from the modal. Initialized to the viewed month on open.
  const [editMonth, setEditMonth] = useState(month)

  const upsertCategory = useUpsertCategory()

  const save = useMutation({
    mutationFn: ({ categoryId, limit, month: m }: { categoryId: string; limit: number; month: Date }) =>
      saveBudget(categoryId, limit, { month: m }),
    onSuccess: () => qc.invalidateQueries({ queryKey: sbKeys.budgetLimits }),
  })
  const remove = useMutation({
    mutationFn: ({ categoryId, month: m }: { categoryId: string; month: Date }) =>
      deleteBudget(categoryId, { month: m }),
    onSuccess: () => qc.invalidateQueries({ queryKey: sbKeys.budgetLimits }),
  })

  // Persist a category field change (color/icon apply immediately, like ManageCategoriesDialog).
  function saveCategory(cat: Category, patch: Partial<Category>) {
    upsertCategory.mutate({ id: cat.id, name: cat.name, color: cat.color, icon: cat.icon, ...patch })
  }
  function cycleColor(cat: Category) {
    const i = TAG_PALETTE.indexOf(cat.color)
    saveCategory(cat, { color: TAG_PALETTE[(i + 1) % TAG_PALETTE.length] })
  }

  const del = useDeleteCategory()
  // Delete the whole category from the edit modal (parity with iOS CategoryBudgetSheet + the
  // ManageCategoriesDialog row action). Same split-guard as ManageCategoriesDialog.remove: a
  // category used by a split leg can't be deleted (the cascade drops one leg and the deferred
  // split_sum_balanced trigger rolls it back at COMMIT), so block it up front.
  async function removeCategory(cat: Category) {
    let hasSplits = false
    try {
      hasSplits = await categoryHasSplits(cat.id)
    } catch {
      toast.error(`Couldn't check "${cat.name}" before deleting. Please try again.`)
      return
    }
    if (hasSplits) {
      toast.error(
        `Can't delete "${cat.name}" — it's used in split transactions. Edit those splits first.`,
      )
      return
    }
    if (
      window.confirm(
        `Delete "${cat.name}"? Its transactions become uncategorized and its budgets are removed. This can't be undone.`,
      )
    )
      del.mutate(cat.id, {
        onSuccess: () => setEditingId(null),
        onError: () => toast.error(`Couldn't delete "${cat.name}". Please try again.`),
      })
  }

  const spendByCat = useMemo(
    () => new Map(spendRows.map((r) => [r.category.id, r.total])),
    [spendRows],
  )

  // Resolve each category's limit as-of the viewed month (effective-dated as-of rule).
  const limitByCat = useMemo(() => resolveLimits(budgetLimits, month), [budgetLimits, month])

  // Resolve each group's limit as-of the viewed month.
  const limitByGroup = useMemo(
    () => resolveGroupLimits(groupBudgetLimits, month),
    [groupBudgetLimits, month],
  )

  // Group budget editor state
  const [groupEditingId, setGroupEditingId] = useState<string | null>(null)
  const [groupLimitInput, setGroupLimitInput] = useState('')
  const [groupEditMonth, setGroupEditMonth] = useState(month)

  // Aggregate spend by category group — sum all spend rows whose category has a group_id.
  // Each group row includes a per-category breakdown for the segmented bar.
  const spendByGroup = useMemo(() => {
    const groupCats = new Map<string, Array<{ category: Category; total: number }>>()
    for (const row of spendRows) {
      const gid = row.category.group_id
      if (gid) {
        const arr = groupCats.get(gid) ?? []
        arr.push({ category: row.category, total: row.total })
        groupCats.set(gid, arr)
      }
    }
    const ungroupedCategories = spendRows.filter((r) => !r.category.group_id)
    const ungroupedTotal = ungroupedCategories.reduce((s, r) => s + r.total, 0)
    const groupRows = categoryGroups
      .map((g) => {
        const cats = (groupCats.get(g.id) ?? []).sort((a, b) => b.total - a.total)
        const total = cats.reduce((s, r) => s + r.total, 0)
        return { id: g.id, name: g.name, total, cats }
      })
      .filter((r) => r.total > 0)
      .sort((a, b) => b.total - a.total)
    return { groupRows, ungroupedTotal, ungroupedCategories }
  }, [spendRows, categoryGroups])

  // Stored category colors keep a category the SAME hue in the donut as everywhere else.
  const colorById = useMemo(
    () => new Map(categories.map((c) => [String(c.id), c.color])),
    [categories],
  )
  const categoryRaw = useMemo(() => {
    const rows = (report?.byCategory ?? []).map((r) => ({
      ...r,
      color: r.category_id != null ? colorById.get(String(r.category_id)) : undefined,
    }))
    return rawSlicesFromRows(rows, 'category', 'category_id')
  }, [report?.byCategory, colorById])
  const tagRaw = useMemo(() => rawSlicesFromRows(report?.byTag ?? [], 'tag'), [report?.byTag])
  const categoryGroupRaw = useMemo(
    () => rawSlicesFromRows(report?.byCategoryGroup ?? [], 'category'),
    [report?.byCategoryGroup],
  )

  const spendCategories = categories.filter((c) => c.kind === 'spend')

  const rows = spendCategories.map((c) => {
    const limit = limitByCat.get(c.id) ?? 0
    const spent = spendByCat.get(c.id) ?? 0
    const pct = limit > 0 ? spent / limit : 0
    return { category: c, limit, spent, pct, over: limit > 0 && spent > limit }
  })
  const budgeted = rows.filter((r) => r.limit > 0)
  const unbudgeted = rows.filter((r) => r.limit <= 0)

  const totalLimit = budgeted.reduce((s, r) => s + r.limit, 0)
  const totalSpent = budgeted.reduce((s, r) => s + r.spent, 0)
  const totalOver = totalLimit > 0 && totalSpent > totalLimit
  const ringPct = totalLimit > 0 ? Math.min(totalSpent / totalLimit, 1) : 0

  // Total spend across ALL categories this month (budgeted + unbudgeted) — shown in the
  // hero when no limits are set yet, so the tab is still informative without a budget.
  const totalAllSpent = rows.reduce((s, r) => s + r.spent, 0)

  // True cash outflow = all categorized spend + uncategorized transactions.
  // This is the macro number shown in the hero so ghost spending is never hidden.
  const totalOutflow = totalAllSpent + uncategorizedSpend

  // Insights — derived only from data already on the page (no invented numbers).
  const topRow = budgeted.length
    ? budgeted.reduce((a, b) => (b.pct > a.pct ? b : a))
    : null
  const overCount = budgeted.filter((r) => r.over).length

  function openEditor(c: Category) {
    setEditingId(c.id)
    setEditMonth(month)
    const lim = resolveLimit(budgetLimits, c.id, month)
    setLimitInput(lim > 0 ? String(lim) : '')
    setNameInput(c.name)
    setIconPickerOpen(false)
  }

  // Navigate the editor's target month (capped at the current month, like the page navigator),
  // re-reflecting the limit resolved for that month in the input.
  function stepEditMonth(delta: number) {
    if (!editing) return
    const next = new Date(editMonth.getFullYear(), editMonth.getMonth() + delta, 1)
    setEditMonth(next)
    const lim = resolveLimit(budgetLimits, editing.id, next)
    setLimitInput(lim > 0 ? String(lim) : '')
  }
  const editIsCurrentMonth =
    editMonth.getFullYear() === today.getFullYear() && editMonth.getMonth() === today.getMonth()
  // Whether a positive limit is in effect at the editor's month (drives the Remove action).
  const editHasLimit = editing != null && resolveLimit(budgetLimits, editing.id, editMonth) > 0

  const chipBase =
    'min-h-[44px] rounded-full px-5 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background'
  const modeTabs = zbbEnabled ? (
    <div className="flex justify-center gap-2">
      <button
        className={cn(
          chipBase,
          mode === 'flat'
            ? 'bg-primary text-primary-foreground'
            : 'border border-border bg-card text-muted-foreground hover:bg-surface-container-high',
        )}
        aria-pressed={mode === 'flat'}
        onClick={() => setParams({})}
      >
        Monthly limits
      </button>
      <button
        className={cn(
          chipBase,
          mode === 'zbb'
            ? 'bg-primary text-primary-foreground'
            : 'border border-border bg-card text-muted-foreground hover:bg-surface-container-high',
        )}
        aria-pressed={mode === 'zbb'}
        onClick={() => setParams({ mode: 'zbb' })}
      >
        Zero-sum
      </button>
    </div>
  ) : null

  if (mode === 'zbb') {
    return (
      <div className="flex flex-col gap-4 pt-4 md:pt-6">
        <h1 className="sr-only">Budget</h1>
        {modeTabs}
        <ZbbBudgetView />
      </div>
    )
  }

  if (budgetsError) {
    return (
      <div className="flex flex-col gap-8 pt-4 md:pt-6">
        <h1 className="sr-only">Budget</h1>
        {modeTabs}
        <ErrorState
          onRetry={retryBudgets}
          error={categoriesQuery.error ?? budgetLimitsQuery.error ?? spendRowsQuery.error}
          message="We couldn't load your budgets. Check your connection and try again."
        />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-8 pt-4 md:pt-6">
      <h1 className="sr-only">Budget</h1>
      {modeTabs}

      {/* Month navigator — view past months' spend (capped at the current month; no future). */}
      <div className="flex flex-col items-center gap-1">
        <div className="flex w-full max-w-md items-center justify-between px-1">
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
            className="h-11 w-11 rounded-full text-primary hover:bg-surface-container-high focus-visible:ring-primary disabled:pointer-events-none disabled:opacity-40"
            onClick={() => step(1)}
            disabled={isCurrentMonth}
            aria-label="Next month"
          >
            <ChevronRight className="h-5 w-5" />
          </Button>
        </div>
      </div>

      {/* ── Hero Health Check ──────────────────────────────────────────────────
          Left: Total Cash Outflow — every dollar that left the account this month,
                including unbudgeted and uncategorized spend, so nothing is hidden.
          Right: Budget Progress ring — tracks budgeted-category spend vs. limits.
          The two numbers deliberately differ: the gap is the "ghost spending" signal.
      ────────────────────────────────────────────────────────────────────────── */}
      <section
        aria-label="Monthly spending health check"
        className="card-surface overflow-hidden"
      >
        <div className="flex flex-col divide-y divide-border md:flex-row md:divide-x md:divide-y-0">

          {/* ── Left panel: Total Outflow ───────────────────────────────── */}
          <div className="flex flex-1 flex-col justify-center gap-5 p-6 md:p-8">
            <div>
              <p className="eyebrow mb-1">Total Cash Outflow</p>
              <CountUp
                value={totalOutflow}
                format={wholeCurrencyFmt.format}
                className="text-hero-number text-foreground"
              />
              <p className="mt-1 text-sm text-muted-foreground">all spending this month</p>
            </div>

            {/* Stacked breakdown bar: budgeted | unbudgeted | uncategorized */}
            {totalOutflow > 0 && (() => {
              const budgetedPct  = (totalSpent          / totalOutflow) * 100
              const unbudgetedSpend = rows.filter(r => r.limit <= 0).reduce((s, r) => s + r.spent, 0)
              const unbudgetedPct = (unbudgetedSpend    / totalOutflow) * 100
              const uncatPct     = (uncategorizedSpend  / totalOutflow) * 100
              return (
                <div className="flex flex-col gap-3">
                  {/* Bar */}
                  <div
                    className="flex h-5 w-full overflow-hidden rounded-full bg-surface-container-high"
                    aria-label="Spend breakdown"
                  >
                    {budgetedPct > 0 && (
                      <div
                        className="h-full bg-primary transition-all"
                        style={{ width: `${budgetedPct}%` }}
                        title={`Budgeted: ${wholeCurrencyFmt.format(totalSpent)}`}
                      />
                    )}
                    {unbudgetedPct > 0 && (
                      <div
                        className="h-full bg-secondary/70 transition-all"
                        style={{ width: `${unbudgetedPct}%` }}
                        title={`Unbudgeted: ${wholeCurrencyFmt.format(unbudgetedSpend)}`}
                      />
                    )}
                    {uncatPct > 0 && (
                      <div
                        className="h-full bg-muted-foreground/40 transition-all"
                        style={{ width: `${uncatPct}%` }}
                        title={`Uncategorized: ${wholeCurrencyFmt.format(uncategorizedSpend)}`}
                      />
                    )}
                  </div>
                  {/* Legend */}
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                    {budgetedPct > 0 && (
                      <span className="flex items-center gap-1.5">
                        <span className="inline-block h-2 w-2 rounded-full bg-primary" aria-hidden />
                        Budgeted <span className="font-medium text-foreground">{wholeCurrencyFmt.format(totalSpent)}</span>
                      </span>
                    )}
                    {unbudgetedPct > 0 && (
                      <span className="flex items-center gap-1.5">
                        <span className="inline-block h-2 w-2 rounded-full bg-secondary/70" aria-hidden />
                        Unbudgeted <span className="font-medium text-foreground">{wholeCurrencyFmt.format(unbudgetedSpend)}</span>
                      </span>
                    )}
                    {uncatPct > 0 && (
                      <span className="flex items-center gap-1.5">
                        <span className="inline-block h-2 w-2 rounded-full bg-muted-foreground/40" aria-hidden />
                        Uncategorized <span className="font-medium text-foreground">{wholeCurrencyFmt.format(uncategorizedSpend)}</span>
                      </span>
                    )}
                  </div>
                </div>
              )
            })()}
          </div>

          {/* ── Right panel: Budget Progress ring ──────────────────────── */}
          <div className="flex shrink-0 flex-col items-center justify-center gap-0 p-6 md:p-8">
            {totalLimit > 0 ? (
              <div className="relative flex h-52 w-52 items-center justify-center md:h-56 md:w-56">
                <svg className="h-full w-full -rotate-90" viewBox="0 0 120 120" aria-hidden="true">
                  <circle
                    className="text-surface-container-high stroke-current"
                    cx="60" cy="60" r={RING_RADIUS}
                    fill="transparent" strokeWidth="8"
                  />
                  <circle
                    className="text-primary stroke-current motion-safe:transition-[stroke-dashoffset] motion-safe:duration-700"
                    cx="60" cy="60" r={RING_RADIUS}
                    fill="transparent" strokeWidth="8"
                    strokeLinecap="round"
                    strokeDasharray={RING_CIRC}
                    strokeDashoffset={RING_CIRC * (1 - ringPct)}
                  />
                </svg>
                <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
                  <span className="eyebrow mb-1">Budget Progress</span>
                  <CountUp
                    value={totalSpent}
                    format={wholeCurrencyFmt.format}
                    className="text-hero-number text-foreground"
                  />
                  <span className="mt-1 text-sm text-muted-foreground">
                    of {wholeCurrencyFmt.format(totalLimit)} budgeted
                  </span>
                  <div
                    className={cn(
                      'mt-3 flex items-center gap-1 rounded-full border px-3 py-1 text-xs font-semibold',
                      totalOver
                        ? 'border-destructive/20 bg-destructive/10 text-destructive'
                        : 'border-secondary/20 bg-secondary/10 text-secondary',
                    )}
                  >
                    {totalOver
                      ? <TriangleAlert className="h-3.5 w-3.5" aria-hidden="true" />
                      : <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />}
                    {totalOver ? 'Over Budget' : 'On Track'}
                  </div>
                </div>
              </div>
            ) : (
              <div className="flex flex-col items-center text-center">
                <p className="eyebrow mb-1">Budget Progress</p>
                <p className="mt-2 max-w-[14rem] text-sm text-muted-foreground">
                  Set a monthly limit on any category below to start tracking progress.
                </p>
              </div>
            )}
          </div>

        </div>
      </section>

      <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
        {/* Left column — Spending by Category */}
        <section className="grid grid-cols-2 gap-3">
          <div className="col-span-2 flex items-center justify-between">
            <h2 className="text-xl font-medium text-foreground">Spending by Category</h2>
            <button
              type="button"
              onClick={() => setManageCategoriesOpen(true)}
              className="flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-surface-container-high hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              aria-label="Manage categories"
            >
              <Settings2 aria-hidden className="h-4 w-4" />
            </button>
          </div>

          {budgeted.map(({ category: c, limit, spent, pct }) => {
            // Single source of truth: the pace word/color AND the bar color come from the
            // same classifier so they always agree (no red text over an orange bar).
            const pace = budgetPaceStatus(spent, limit)
            return (
              <button
                key={c.id}
                onClick={() => openEditor(c)}
                aria-label={`Edit ${c.name} budget`}
                className={cn(
                  'flex w-full flex-col gap-2 card-surface p-4 text-left',
                  'transition-shadow hover:shadow-card-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background',
                )}
              >
                <div className="flex min-w-0 items-center gap-2">
                  <CategoryIconWell category={c} />
                  <span className="truncate text-sm font-medium text-foreground">{c.name}</span>
                </div>
                <div className="flex items-baseline justify-between gap-1">
                  <span className="text-base font-semibold text-foreground">
                    {formatCurrency(spent)}
                  </span>
                  <span className={cn('text-xs font-medium', pace.textClass)}>{pace.label}</span>
                </div>
                <ProgressBar value={pct * 100} fillClassName={pace.barClass} />
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>{Math.round(pct * 100)}%</span>
                  <span>{formatCurrency(limit)}</span>
                </div>
              </button>
            )
          })}

          {/* Unbudgeted categories — solid card showing actual spend + "Set Goal" action. */}
          {unbudgeted.map(({ category: c, spent }) => (
            <button
              key={c.id}
              onClick={() => openEditor(c)}
              aria-label={`Set budget goal for ${c.name}`}
              className={cn(
                'flex w-full flex-col gap-2 card-surface p-4 text-left',
                'transition-shadow hover:shadow-card-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background',
              )}
            >
              <div className="flex min-w-0 items-center gap-2">
                <CategoryIconWell category={c} />
                <span className="truncate text-sm font-medium text-foreground">{c.name}</span>
              </div>
              <div className="flex items-center justify-between gap-2">
                {spent > 0 ? (
                  <span className="text-base font-semibold text-foreground">
                    {formatCurrency(spent)}
                  </span>
                ) : (
                  <span className="text-xs text-muted-foreground">No spending</span>
                )}
                <span className="shrink-0 rounded-full border border-outline-variant bg-surface-container-high px-3 py-1 text-xs font-medium text-foreground transition-colors hover:bg-surface-variant">
                  Set Goal
                </span>
              </div>
            </button>
          ))}
        </section>

        {/* Right column — Spending by Category Group */}
        <section className="flex flex-col gap-4">
          <div className="flex items-center justify-between">
            <h2 className="text-xl font-medium text-foreground">Spending by Group</h2>
            <button
              type="button"
              onClick={() => setManageCategoryGroupsOpen(true)}
              className="flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-surface-container-high hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              aria-label="Manage category groups"
            >
              <Settings2 aria-hidden className="h-4 w-4" />
            </button>
          </div>

          {spendByGroup.groupRows.length === 0 && spendByGroup.ungroupedTotal === 0 ? (
            <div className="card-surface p-6 text-sm text-muted-foreground">
              No group spending this month.
            </div>
          ) : (
            <>
              {spendByGroup.groupRows.map(({ id, name, total, cats }) => {
                const groupLimit = limitByGroup.get(id) ?? 0
                const hasLimit = groupLimit > 0
                const pct = hasLimit ? Math.min(total / groupLimit, 1) : 0
                const over = hasLimit && total > groupLimit
                const floor = categories
                  .filter((c) => c.group_id === id && c.kind === 'spend')
                  .reduce((s, c) => s + (limitByCat.get(c.id) ?? 0), 0)

                return (
                  <button
                    key={id}
                    onClick={() => {
                      setGroupEditingId(id)
                      setGroupEditMonth(month)
                      const existing = resolveGroupLimit(groupBudgetLimits, id, month)
                      setGroupLimitInput(existing > 0 ? String(existing) : '')
                    }}
                    aria-label={`${hasLimit ? 'Edit' : 'Set'} budget for ${name} group`}
                    className={cn(
                      'flex w-full flex-col gap-3 card-surface p-6 text-left',
                      'transition-shadow hover:shadow-card-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background',
                    )}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <span className="truncate text-xl font-medium text-foreground">{name}</span>
                      <div className="flex shrink-0 items-center gap-2">
                        <span className="text-xl font-medium text-foreground">
                          {formatCurrency(total)}
                        </span>
                        {!hasLimit && (
                          <span className="rounded-full border border-outline-variant bg-surface-container-high px-3 py-1 text-xs font-medium text-foreground">
                            Set Goal
                          </span>
                        )}
                      </div>
                    </div>

                    {hasLimit && (
                      <>
                        <ProgressBar
                          value={pct * 100}
                          fillClassName={
                            over ? 'bg-destructive' : pct >= 0.8 ? 'bg-amber-500' : 'bg-secondary'
                          }
                        />
                        <div className="flex justify-between text-xs font-medium text-muted-foreground">
                          <span className={over ? 'text-destructive font-semibold' : ''}>
                            {over ? 'Over budget' : `${Math.round(pct * 100)}% used`}
                          </span>
                          <span>{formatCurrency(groupLimit)} limit</span>
                        </div>
                      </>
                    )}

                    {!hasLimit && floor > 0 && (
                      <p className="text-xs text-muted-foreground">
                        Category budgets sum to {formatCurrency(floor)}
                      </p>
                    )}

                    <SegmentedGroupBar cats={cats} groupTotal={total} />
                  </button>
                )
              })}

              {spendByGroup.ungroupedTotal > 0 && (() => {
                const groupTotal =
                  spendByGroup.groupRows.reduce((s, r) => s + r.total, 0) +
                  spendByGroup.ungroupedTotal
                const pct = groupTotal > 0 ? spendByGroup.ungroupedTotal / groupTotal : 0
                return (
                  <div className="flex flex-col gap-3 card-surface p-6">
                    <div className="flex items-center justify-between gap-3">
                      <span className="truncate text-xl font-medium text-muted-foreground">Ungrouped</span>
                      <span className="shrink-0 text-xl font-medium text-foreground">
                        {formatCurrency(spendByGroup.ungroupedTotal)}
                      </span>
                    </div>
                    <SegmentedGroupBar
                      cats={spendByGroup.ungroupedCategories}
                      groupTotal={spendByGroup.ungroupedTotal}
                    />
                    <div className="flex justify-between text-xs font-medium text-muted-foreground">
                      <span>{Math.round(pct * 100)}% of total</span>
                      <span>{formatCurrency(spendByGroup.ungroupedTotal)}</span>
                    </div>
                  </div>
                )
              })()}
            </>
          )}

          {/* Savings rate — (income − spending) ÷ income for the viewed month. Moved here from
              the retired Reports page. Transfers (e.g. moves to savings) are excluded from
              spending; blank when there's no income that month. */}
          <div className="flex items-center justify-between gap-4 card-surface p-6">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/10 ring-1 ring-primary/20">
                <PiggyBank className="h-5 w-5 text-primary" aria-hidden="true" />
              </div>
              <div>
                <p className="text-xl font-medium text-foreground">Savings rate</p>
                <p className="text-sm text-muted-foreground">saved of income in {monthLabel}</p>
              </div>
            </div>
            {report?.savingsRatePct == null ? (
              <span className="text-2xl font-semibold tabular-nums text-muted-foreground">—</span>
            ) : (
              <CountUp
                value={report.savingsRatePct}
                format={(n) => `${n.toFixed(1)}%`}
                className={cn(
                  'text-2xl font-semibold tabular-nums',
                  report.savingsRatePct >= 0 ? 'text-income' : 'text-expense',
                )}
              />
            )}
          </div>

          {/* Insights */}
          {topRow && (
            <div className="relative overflow-hidden card-surface p-6 transition-shadow duration-300 hover:shadow-card-hover">
              <div
                className="pointer-events-none absolute -right-8 -top-8 h-32 w-32 rounded-bl-full bg-primary-container/20"
                aria-hidden="true"
              />
              <div className="relative z-10 mb-4 flex items-start gap-3">
                <Lightbulb className="h-6 w-6 shrink-0 text-primary" aria-hidden="true" />
                <h3 className="text-xl font-medium text-foreground">Budget Insight</h3>
              </div>
              <p className="relative z-10 text-base text-muted-foreground">
                {totalOver ? (
                  <>
                    You are{' '}
                    <span className="font-medium text-destructive">
                      {formatCurrency(totalSpent - totalLimit)} over
                    </span>{' '}
                    your total budget in {monthLabel}.
                  </>
                ) : (
                  <>
                    You have used{' '}
                    <span className="font-medium text-primary">{Math.round(ringPct * 100)}%</span>{' '}
                    of your total budget, with {formatCurrency(totalLimit - totalSpent)} left in{' '}
                    {monthLabel}.
                  </>
                )}
              </p>
              <p className="relative z-10 mt-4 text-base text-muted-foreground">
                {overCount > 0 ? (
                  <>
                    {overCount === 1 ? '1 category is' : `${overCount} categories are`} over
                    limit — {topRow.category.name} is the furthest along at{' '}
                    {Math.round(topRow.pct * 100)}% of its {formatCurrency(topRow.limit)} limit.
                  </>
                ) : (
                  <>
                    {topRow.category.name} is your most used budget at{' '}
                    <span className="font-medium text-primary">
                      {Math.round(topRow.pct * 100)}%
                    </span>{' '}
                    of its {formatCurrency(topRow.limit)} limit.
                  </>
                )}
              </p>
            </div>
          )}
        </section>
      </div>

      {/* ── Spend breakdowns ───────────────────────────────────────────────
          Donut mix for the viewed month (moved here from the retired Reports page;
          reuses the shared SpendPieCard). The first card toggles between per-category
          and per-group rollups; the second is the tag breakdown. */}
      <motion.div
        variants={breakdownMotionContainer}
        initial="hidden"
        animate="show"
        className="grid grid-cols-1 gap-6 xl:grid-cols-2"
      >
        <motion.div variants={breakdownMotionItem} className="flex flex-col gap-3">
          {/* Category ↔ Group toggle */}
          <div className="flex items-center gap-1 self-start rounded-full border border-border bg-card p-1">
            {(['category', 'group'] as const).map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setBreakdownView(v)}
                aria-pressed={breakdownView === v}
                className={cn(
                  'rounded-full px-4 py-1.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
                  breakdownView === v
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:bg-surface-container-high',
                )}
              >
                {v === 'category' ? 'By category' : 'By group'}
              </button>
            ))}
          </div>
          {breakdownView === 'category' ? (
            <SpendPieCard
              title="Spend by category"
              subtitle="Non-Income categories; transfers excluded."
              rawSlices={categoryRaw}
              emptyHint="No categorized spending this month."
              twoThirdsPieLayout
            />
          ) : (
            <SpendPieCard
              title="Spend by category group"
              subtitle="Spending rolled up to your category groups. Ungrouped categories appear together."
              rawSlices={categoryGroupRaw}
              emptyHint="No category group spending this month."
              twoThirdsPieLayout
            />
          )}
        </motion.div>
        <motion.div variants={breakdownMotionItem} className="flex flex-col gap-3">
          {/* Spacer matches the sibling column's toggle height so both donut cards align. */}
          <div className="h-10 shrink-0" aria-hidden="true" />
          <SpendPieCard
            title="Spend by tag"
            rawSlices={tagRaw}
            emptyHint="No tagged spending this month."
            twoThirdsPieLayout
          />
        </motion.div>
      </motion.div>

      <ManageCategoriesDialog open={manageCategoriesOpen} onOpenChange={setManageCategoriesOpen} />
      <ManageCategoryGroupsDialog open={manageCategoryGroupsOpen} onOpenChange={setManageCategoryGroupsOpen} />

      <Dialog open={editing != null} onOpenChange={(o) => !o && setEditingId(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Edit {editing?.name}</DialogTitle>
          </DialogHeader>

          {editing && (
            <div className="flex flex-col gap-3">
              {/* Category identity — icon, color, name (applies alongside the limit on Save). */}
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setIconPickerOpen((v) => !v)}
                  aria-label={`Change ${editing.name} icon`}
                  aria-expanded={iconPickerOpen}
                  className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full transition-colors hover:bg-surface-variant focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                >
                  <CategoryIcon category={editing} size={28} />
                </button>
                <button
                  type="button"
                  onClick={() => cycleColor(editing)}
                  aria-label={`Change ${editing.name} color`}
                  className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full transition-colors hover:bg-surface-variant focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                >
                  <span
                    aria-hidden
                    className="h-5 w-5 rounded-full border border-outline-variant/60"
                    style={{ backgroundColor: editing.color }}
                  />
                </button>
                <Input
                  value={nameInput}
                  onChange={(e) => setNameInput(e.target.value)}
                  placeholder="Category name"
                  aria-label="Category name"
                />
              </div>

              {iconPickerOpen && (
                <IconPicker
                  value={editing.icon}
                  color={editing.color}
                  onSelect={(symbol) => {
                    saveCategory(editing, { icon: symbol })
                    setIconPickerOpen(false)
                  }}
                />
              )}

              {/* Month navigator — the limit applies to this month (capped at the current month). */}
              <div className="flex items-center justify-between rounded-full bg-surface-container px-1 py-1">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-9 w-9 rounded-full text-primary hover:bg-surface-container-high focus-visible:ring-primary"
                  onClick={() => stepEditMonth(-1)}
                  aria-label="Previous budget month"
                >
                  <ChevronLeft className="h-5 w-5" />
                </Button>
                <span className="text-sm font-semibold text-foreground">
                  {formatMonthLabel(editMonth)}
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-9 w-9 rounded-full text-primary hover:bg-surface-container-high focus-visible:ring-primary disabled:pointer-events-none disabled:opacity-40"
                  onClick={() => stepEditMonth(1)}
                  disabled={editIsCurrentMonth}
                  aria-label="Next budget month"
                >
                  <ChevronRight className="h-5 w-5" />
                </Button>
              </div>

              <Input
                type="number"
                inputMode="decimal"
                placeholder="Monthly limit"
                value={limitInput}
                onChange={(e) => setLimitInput(e.target.value)}
              />

              <p className="text-xs text-muted-foreground">
                Name, icon &amp; color apply to this category everywhere. The limit applies to{' '}
                {formatMonthLabel(editMonth)}.
              </p>

              <button
                type="button"
                onClick={() => void removeCategory(editing)}
                className="mt-1 inline-flex items-center gap-1.5 self-start rounded text-sm font-medium text-destructive transition-colors hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              >
                <Trash2 aria-hidden className="h-4 w-4" /> Delete category
              </button>
            </div>
          )}

          <DialogFooter className="gap-2 sm:justify-between">
            {editHasLimit && (
              <Button
                variant="ghost"
                className="text-destructive"
                onClick={() => {
                  if (editing) remove.mutate({ categoryId: editing.id, month: editMonth })
                  setEditingId(null)
                }}
              >
                Remove
              </Button>
            )}
            <Button
              onClick={() => {
                if (editing) {
                  const name = nameInput.trim()
                  if (name && name !== editing.name) saveCategory(editing, { name })
                  const limit = parseFloat(limitInput)
                  if (!isNaN(limit)) save.mutate({ categoryId: editing.id, limit, month: editMonth })
                }
                setEditingId(null)
              }}
            >
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Group budget dialog ── */}
      {(() => {
        const editingGroup = groupEditingId != null
          ? categoryGroups.find((g) => g.id === groupEditingId) ?? null
          : null

        // Per-category spend slices for this group, sorted highest first
        const groupSpendSlices = editingGroup != null
          ? categories
              .filter((c) => c.group_id === editingGroup.id && c.kind === 'spend')
              .map((c) => ({
                category: c,
                spent: spendByCat.get(c.id) ?? 0,
                catLimit: resolveLimit(budgetLimits, c.id, groupEditMonth),
              }))
              .sort((a, b) => b.spent - a.spent)
          : []

        // Correct floor computation using budgetLimits (category limits)
        const catLimitsInGroup = editingGroup != null
          ? categories
              .filter((c) => c.group_id === editingGroup.id && c.kind === 'spend')
              .map((c) => resolveLimit(budgetLimits, c.id, groupEditMonth))
          : []

        const budgetedCatLimits = catLimitsInGroup.filter((l) => l > 0)
        const floor = budgetedCatLimits.reduce((s, l) => s + l, 0)
        const allBudgeted =
          catLimitsInGroup.length > 0 &&
          catLimitsInGroup.every((l) => l > 0)
        const someBudgeted = budgetedCatLimits.length > 0 && !allBudgeted

        const groupEditIsCurrentMonth =
          groupEditMonth.getFullYear() === today.getFullYear() &&
          groupEditMonth.getMonth() === today.getMonth()

        const groupInputVal = parseFloat(groupLimitInput)
        const groupInputValid = !isNaN(groupInputVal) && groupInputVal > 0 && groupInputVal >= floor
        const groupHasLimit =
          editingGroup != null &&
          resolveGroupLimit(groupBudgetLimits, editingGroup.id, groupEditMonth) > 0

        function stepGroupEditMonth(delta: number) {
          const next = new Date(groupEditMonth.getFullYear(), groupEditMonth.getMonth() + delta, 1)
          if (next > today) return
          setGroupEditMonth(next)
          if (editingGroup) {
            const existing = resolveGroupLimit(groupBudgetLimits, editingGroup.id, next)
            setGroupLimitInput(existing > 0 ? String(existing) : '')
          }
        }

        return (
          <Dialog open={editingGroup != null} onOpenChange={(o) => !o && setGroupEditingId(null)}>
            <DialogContent className="max-w-sm">
              <DialogHeader>
                <DialogTitle>{editingGroup?.name ?? ''} Group Budget</DialogTitle>
              </DialogHeader>

              {editingGroup && (
                <div className="flex flex-col gap-3">
                  {/* Month navigator */}
                  <div className="flex items-center justify-between rounded-full bg-surface-container px-1 py-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-9 w-9 rounded-full text-primary hover:bg-surface-container-high focus-visible:ring-primary"
                      onClick={() => stepGroupEditMonth(-1)}
                      aria-label="Previous month"
                    >
                      <ChevronLeft className="h-5 w-5" />
                    </Button>
                    <span className="text-sm font-semibold text-foreground">
                      {formatMonthLabel(groupEditMonth)}
                    </span>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-9 w-9 rounded-full text-primary hover:bg-surface-container-high focus-visible:ring-primary disabled:pointer-events-none disabled:opacity-40"
                      onClick={() => stepGroupEditMonth(1)}
                      disabled={groupEditIsCurrentMonth}
                      aria-label="Next month"
                    >
                      <ChevronRight className="h-5 w-5" />
                    </Button>
                  </div>

                  {/* Category spend breakdown */}
                  {groupSpendSlices.length > 0 && (
                    <div className="flex flex-col gap-2 rounded-xl bg-surface-container p-3">
                      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        Spending this month
                      </p>
                      {groupSpendSlices.map(({ category: c, spent, catLimit }) => {
                        const pct = catLimit > 0 ? Math.min(spent / catLimit, 1) : 0
                        const over = catLimit > 0 && spent > catLimit
                        const fillColor = over
                          ? 'var(--color-destructive, #ef4444)'
                          : pct >= 0.8
                            ? 'var(--color-amber-500, #f59e0b)'
                            : c.color
                        return (
                          <div key={c.id} className="flex flex-col gap-1">
                            <div className="flex items-center gap-2">
                              <CategoryIcon category={c} size={16} />
                              <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
                                {c.name}
                              </span>
                              <span className="shrink-0 text-xs tabular-nums text-foreground">
                                {formatCurrency(spent)}
                              </span>
                              {catLimit > 0 && (
                                <span className="shrink-0 text-xs text-muted-foreground">
                                  / {formatCurrency(catLimit)}
                                </span>
                              )}
                            </div>
                            {catLimit > 0 && (
                              <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-container-high">
                                <div
                                  className="h-full rounded-full transition-[width] duration-500 ease-out motion-reduce:transition-none"
                                  style={{ width: `${pct * 100}%`, backgroundColor: fillColor }}
                                />
                              </div>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  )}

                  <Input
                    type="number"
                    inputMode="decimal"
                    placeholder="Monthly group limit"
                    value={groupLimitInput}
                    onChange={(e) => setGroupLimitInput(e.target.value)}
                    className={
                      groupLimitInput !== '' && !groupInputValid
                        ? 'border-destructive focus-visible:ring-destructive'
                        : ''
                    }
                  />

                  {/* Helper copy — explains the floor and auto-suggest */}
                  {allBudgeted && floor > 0 && (
                    <p className="text-xs text-muted-foreground">
                      All categories are budgeted. Their sum is{' '}
                      <span className="font-medium text-foreground">{formatCurrency(floor)}</span>
                      {' '}— you can raise this limit higher.
                    </p>
                  )}
                  {someBudgeted && floor > 0 && (
                    <p className="text-xs text-muted-foreground">
                      Some categories have budgets summing to{' '}
                      <span className="font-medium text-foreground">{formatCurrency(floor)}</span>
                      . Group limit must be at least that amount.
                    </p>
                  )}

                  {/* Inline floor-violation error */}
                  {groupLimitInput !== '' && !isNaN(groupInputVal) && groupInputVal < floor && (
                    <p className="text-xs font-medium text-destructive">
                      Must be at least {formatCurrency(floor)} (sum of category budgets in this group).
                    </p>
                  )}
                </div>
              )}

              <DialogFooter className="gap-2 sm:justify-between">
                {groupHasLimit && (
                  <Button
                    variant="ghost"
                    className="text-destructive"
                    onClick={() => {
                      if (editingGroup) {
                        deleteGroupBudget.mutate({ groupId: editingGroup.id, month: groupEditMonth })
                      }
                      setGroupEditingId(null)
                    }}
                  >
                    Remove
                  </Button>
                )}
                <Button
                  disabled={groupLimitInput === '' || !groupInputValid}
                  onClick={() => {
                    if (editingGroup && groupInputValid) {
                      saveGroupBudget.mutate({
                        groupId: editingGroup.id,
                        monthlyLimit: groupInputVal,
                        month: groupEditMonth,
                      })
                    }
                    setGroupEditingId(null)
                  }}
                >
                  Save
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        )
      })()}
    </div>
  )
}
