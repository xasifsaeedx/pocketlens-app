import { useCallback, useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { motion } from 'framer-motion'
import {
  Bar,
  BarChart,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis,
} from 'recharts'
import {
  ArrowDownRight,
  ArrowUpRight,
  Bookmark,
  Check,
  ChevronLeft,
  ChevronRight,
  Info,
  Plus,
  Receipt,
  ChevronDown,
  Search,
  SlidersHorizontal,
  Tag,
  Trash2,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { SortableTableHead } from '@/components/sortable-table-head'
import { columnLooksNumeric, cycleSort, sortByColumn, type ColumnSortState } from '@/lib/tableSort'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import {
  breakdownMotionContainer as container,
  breakdownMotionItem as item,
  rawSlicesFromRows,
  SpendPieCard,
} from '@/components/reports/SpendBreakdownCharts'
import { formatCurrency } from '@/lib/money'
import { useAccounts, useCategories, useCategoryGroups, useTags } from '@/data/hooks'
import { fetchViewsData, type BreakdownRow, type TxnRow, type ViewsResult } from '@/data/views'
import type { UUID } from '@/types/domain'

// Named filter sets persist to this browser only (localStorage). Key predates the
// "Views" → "Explore" rename; keep it so existing saved sets survive the rename.
const EXPLORE_SAVED_STORAGE_KEY = 'keep-views-saved-v1'

/** Rows per page in the Explore results table. */
const TXN_PAGE_SIZE = 15

/** Flip breakdown totals into SpendPieCard's "outflow is negative" convention. */
function negateTotals(rows: BreakdownRow[] | undefined): BreakdownRow[] {
  return (rows ?? []).map((r) => ({ ...r, total: -Number(r.total) }))
}

function isoDate(d: Date) {
  return d.toISOString().slice(0, 10)
}

function rangeLast30Days() {
  const today = new Date()
  return {
    start: isoDate(new Date(today.getTime() - 30 * 24 * 3600 * 1000)),
    end: isoDate(today),
  }
}

function fmtShortDate(ymd: string) {
  const [y, m, d] = ymd.split('-').map(Number)
  if (!y || !m || !d) return ymd
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

type Preset = 'Custom' | 'Last 7 days' | 'Last 30 days' | 'This month' | 'Year to date'
const PRESETS: Preset[] = ['Last 7 days', 'Last 30 days', 'This month', 'Year to date', 'Custom']

type PersistedViewState = {
  preset: Preset
  startDate: string
  endDate: string
  accountId: UUID | null
  categoryGroupId: UUID | null
  categoryId: UUID | null
  selectedTagIds: UUID[]
  tagsMatchAny: boolean
  minAmount: number
  maxAmount: number
}

type SavedNamedView = { id: string; name: string; state: PersistedViewState }

function loadSavedViews(): SavedNamedView[] {
  try {
    const raw = localStorage.getItem(EXPLORE_SAVED_STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (x): x is SavedNamedView =>
        x != null &&
        typeof x === 'object' &&
        typeof (x as SavedNamedView).id === 'string' &&
        typeof (x as SavedNamedView).name === 'string' &&
        (x as SavedNamedView).state != null,
    )
  } catch {
    return []
  }
}

function persistSavedViews(views: SavedNamedView[]) {
  localStorage.setItem(EXPLORE_SAVED_STORAGE_KEY, JSON.stringify(views))
}

/** Filter-chip recipe: active = filled primary pill, inactive =
 *  white bg + hairline border. Used for the quick date-range switcher. */
function RangeChip({
  active,
  children,
  onClick,
}: {
  active: boolean
  children: React.ReactNode
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'whitespace-nowrap rounded-full px-3.5 py-1.5 text-sm font-medium transition-colors active:scale-95',
        active
          ? 'bg-primary text-primary-foreground shadow-sm'
          : 'border border-border bg-card text-muted-foreground hover:bg-surface-container-high',
      )}
    >
      {children}
    </button>
  )
}

export default function ExplorePage() {
  const initialRange = useMemo(() => rangeLast30Days(), [])
  const [preset, setPreset] = useState<Preset>('Last 30 days')
  const [startDate, setStartDate] = useState(initialRange.start)
  const [endDate, setEndDate] = useState(initialRange.end)

  // ── Supabase-backed metadata ─────────────────────────────────────────────
  const { data: accounts = [] } = useAccounts()
  const { data: allCategories = [] } = useCategories()
  const { data: categoryGroups = [] } = useCategoryGroups()
  const { data: tags = [] } = useTags()

  // ── Filter state ─────────────────────────────────────────────────────────
  const [accountId, setAccountId] = useState<UUID | null>(null)
  const [categoryGroupId, setCategoryGroupId] = useState<UUID | null>(null)
  const [categoryId, setCategoryId] = useState<UUID | null>(null)
  const [selectedTagIds, setSelectedTagIds] = useState<UUID[]>([])
  const [tagsMatchAny, setTagsMatchAny] = useState(false)
  const [minAmount, setMinAmount] = useState(0)
  const [maxAmount, setMaxAmount] = useState(0)
  const [tagSearch, setTagSearch] = useState('')

  const [breakdownTab, setBreakdownTab] = useState<'category' | 'category_group' | 'tag'>('category')

  const [viewsTagSort, setViewsTagSort] = useState<ColumnSortState | null>(null)
  const [viewsCategorySort, setViewsCategorySort] = useState<ColumnSortState | null>(null)
  const [viewsCategoryGroupSort, setViewsCategoryGroupSort] = useState<ColumnSortState | null>(null)
  const [viewsTxnSort, setViewsTxnSort] = useState<ColumnSortState | null>(null)
  const [txnPageState, setTxnPageState] = useState({ key: '', page: 0 })

  const [savedViews, setSavedViews] = useState<SavedNamedView[]>(() => loadSavedViews())
  const [saveName, setSaveName] = useState('')
  const [saveDialogOpen, setSaveDialogOpen] = useState(false)

  // ── Derived lists ─────────────────────────────────────────────────────────
  // Top-level categories (no parent) filtered by selected group
  const topLevelCategories = useMemo(() => {
    const tops = allCategories.filter((c) => c.parent_id == null)
    if (!categoryGroupId) return tops
    return tops.filter((c) => c.group_id === categoryGroupId)
  }, [allCategories, categoryGroupId])

  // Reset category when category group changes
  useEffect(() => {
    setCategoryId(null)
  }, [categoryGroupId])

  const shouldMinMaxInclude = useMemo(() => {
    const min = minAmount > 0 ? minAmount : undefined
    const max = maxAmount > 0 ? maxAmount : undefined
    return { min, max }
  }, [minAmount, maxAmount])

  const normalizedTagIds = useMemo(() => [...selectedTagIds].sort(), [selectedTagIds])

  // ── Committed params — only update when user clicks Search ─────────────
  // This prevents a Supabase request on every keystroke/dropdown change.
  const [committedParams, setCommittedParams] = useState<{
    startDate: string
    endDate: string
    accountId: UUID | null
    categoryGroupId: UUID | null
    categoryId: UUID | null
    tagIds: UUID[]
    tagsMatchAny: boolean
    minAmount: number | undefined
    maxAmount: number | undefined
  } | null>(null)

  const handleSearch = useCallback(() => {
    setCommittedParams({
      startDate,
      endDate,
      accountId,
      categoryGroupId,
      categoryId,
      tagIds: normalizedTagIds,
      tagsMatchAny,
      minAmount: shouldMinMaxInclude.min,
      maxAmount: shouldMinMaxInclude.max,
    })
  }, [
    startDate, endDate, accountId, categoryGroupId, categoryId,
    normalizedTagIds, tagsMatchAny,
    shouldMinMaxInclude.min, shouldMinMaxInclude.max,
  ])

  const viewsQuery = useQuery<ViewsResult, Error>({
    queryKey: ['views', JSON.stringify(committedParams)],
    enabled: committedParams != null,
    queryFn: () => fetchViewsData(committedParams!),
  })

  const data = viewsQuery.data ?? null
  const error = viewsQuery.error?.message ?? null
  const loading = viewsQuery.isLoading
  const isFetching = viewsQuery.isFetching

  const sortedViewsByTag = useMemo(() => {
    if (!data?.by_tag?.length) return data?.by_tag ?? []
    return sortByColumn((data.by_tag as unknown) as Record<string, unknown>[], viewsTagSort, ['total', 'count', 'percent'])
  }, [data?.by_tag, viewsTagSort])

  const sortedViewsByCategory = useMemo(() => {
    if (!data?.by_category?.length) return data?.by_category ?? []
    return sortByColumn((data.by_category as unknown) as Record<string, unknown>[], viewsCategorySort, [
      'total',
      'count',
      'percent',
    ])
  }, [data?.by_category, viewsCategorySort])

  const sortedViewsByCategoryGroup = useMemo(() => {
    if (!data?.by_category_group?.length) return data?.by_category_group ?? []
    return sortByColumn((data.by_category_group as unknown) as Record<string, unknown>[], viewsCategoryGroupSort, [
      'total',
      'count',
      'percent',
    ])
  }, [data?.by_category_group, viewsCategoryGroupSort])

  const sortedViewsTransactions = useMemo(() => {
    if (!data?.transactions?.length) return data?.transactions ?? []
    const numeric =
      viewsTxnSort && columnLooksNumeric((data.transactions as unknown) as Record<string, unknown>[], viewsTxnSort.key)
        ? [viewsTxnSort.key]
        : []
    return sortByColumn((data.transactions as unknown) as Record<string, unknown>[], viewsTxnSort, numeric)
  }, [data?.transactions, viewsTxnSort])

  // SpendPieCard only plots rows whose `total` is NEGATIVE (its outflow convention,
  // see reports.ts). Explore's breakdowns come straight from the DB sign, where an
  // outflow is POSITIVE — without this flip every slice was discarded and each pie
  // rendered its "no spending in this view" hint.
  // A new result set or a re-sort invalidates the current page offset. Derived rather
  // than reset in an effect, so paging can't render one frame against the wrong rows.
  const txnPageKey = `${viewsQuery.dataUpdatedAt}|${viewsTxnSort?.key ?? ''}|${viewsTxnSort?.dir ?? ''}`
  const txnPage = txnPageState.key === txnPageKey ? txnPageState.page : 0
  const setTxnPage = useCallback(
    (next: number | ((prev: number) => number)) => {
      setTxnPageState((prev) => {
        const current = prev.key === txnPageKey ? prev.page : 0
        return { key: txnPageKey, page: typeof next === 'function' ? next(current) : next }
      })
    },
    [txnPageKey],
  )

  const txnPageCount = Math.max(1, Math.ceil(sortedViewsTransactions.length / TXN_PAGE_SIZE))
  const safeTxnPage = Math.min(txnPage, txnPageCount - 1)
  const pagedViewsTransactions = useMemo(
    () => sortedViewsTransactions.slice(safeTxnPage * TXN_PAGE_SIZE, (safeTxnPage + 1) * TXN_PAGE_SIZE),
    [sortedViewsTransactions, safeTxnPage],
  )

  const categoryRaw = useMemo(
    () => rawSlicesFromRows(negateTotals(data?.by_category), 'category', 'category_id'),
    [data?.by_category],
  )
  const categoryGroupRaw = useMemo(
    () => rawSlicesFromRows(negateTotals(data?.by_category_group), 'name'),
    [data?.by_category_group],
  )
  const tagRaw = useMemo(() => rawSlicesFromRows(negateTotals(data?.by_tag), 'name'), [data?.by_tag])

  // Day → its transactions, for the Daily activity hover card. The rows are already
  // in hand from the same fetch that built the chart, so this is a regroup, not a query.
  const txnsByDate = useMemo(() => {
    const m = new Map<string, TxnRow[]>()
    for (const r of data?.transactions ?? []) {
      const list = m.get(r.Date)
      if (list) list.push(r)
      else m.set(r.Date, [r])
    }
    for (const list of m.values()) {
      list.sort((a, b) => Math.abs(Number(b.Amount)) - Math.abs(Number(a.Amount)))
    }
    return m
  }, [data?.transactions])

  // Slice → its transactions, for the pie hover cards. The pies plot spending only, so
  // these mirror that: debits, no transfers. Same rows the page already has in hand.
  const spendRowsBy = useMemo(() => {
    const byCategory = new Map<string, TxnRow[]>()
    const byGroup = new Map<string, TxnRow[]>()
    const byTag = new Map<string, TxnRow[]>()
    const push = (m: Map<string, TxnRow[]>, key: string, r: TxnRow) => {
      const k = key.trim() || 'Unknown'
      const list = m.get(k)
      if (list) list.push(r)
      else m.set(k, [r])
    }
    for (const r of data?.transactions ?? []) {
      if (r.is_transfer || Number(r.Amount) <= 0) continue
      push(byCategory, r.Category, r)
      push(byGroup, r.Group, r)
      for (const t of r.Tags.split(',')) {
        if (t.trim()) push(byTag, t, r)
      }
    }
    for (const m of [byCategory, byGroup, byTag]) {
      for (const list of m.values()) list.sort((a, b) => Number(b.Amount) - Number(a.Amount))
    }
    return { byCategory, byGroup, byTag }
  }, [data?.transactions])

  const sliceRowsFrom = useCallback(
    (m: Map<string, TxnRow[]>) => (slice: { name: string }) =>
      (m.get(slice.name) ?? []).map((r) => ({
        id: r.id,
        label: r.Merchant,
        amount: Number(r.Amount),
      })),
    [],
  )

  // User-facing sign: positive = took in more than you spent.
  const netCashFlow = data ? -Number(data.total) : 0
  // Money in draws upward (green), money out downward (red) — the two are stacked on a
  // shared x slot so each day reads as one diverging bar around the zero line.
  const dailyActivity = data?.daily_activity
  const barData = useMemo(
    () =>
      (dailyActivity ?? []).map((r) => ({
        label: fmtShortDate(r.date.slice(0, 10)),
        income: Number(r.income),
        spending: -Number(r.spending),
        iso: r.date.slice(0, 10),
      })),
    [dailyActivity],
  )

  const avgAbsFromTxns = useMemo(() => {
    if (!data?.transactions?.length) return 0
    const sum = data.transactions.reduce((acc, r) => acc + Math.abs(Number(r.Amount)), 0)
    return sum / data.transactions.length
  }, [data?.transactions])

  const activeFilterCount = useMemo(() => {
    let n = 0
    if (accountId != null) n++
    if (categoryGroupId != null) n++
    if (categoryId != null) n++
    if (selectedTagIds.length) n += selectedTagIds.length
    if (tagsMatchAny && selectedTagIds.length > 1) n++
    if (shouldMinMaxInclude.min !== undefined) n++
    if (shouldMinMaxInclude.max !== undefined) n++
    return n
  }, [
    accountId,
    categoryGroupId,
    categoryId,
    selectedTagIds.length,
    tagsMatchAny,
    shouldMinMaxInclude.min,
    shouldMinMaxInclude.max,
  ])

  const resetToDefaults = useCallback(() => {
    const r = rangeLast30Days()
    setPreset('Last 30 days')
    setStartDate(r.start)
    setEndDate(r.end)
    setAccountId(null)
    setCategoryGroupId(null)
    setCategoryId(null)
    setSelectedTagIds([])
    setTagsMatchAny(false)
    setMinAmount(0)
    setMaxAmount(0)
    setTagSearch('')
    setCommittedParams(null)
  }, [])

  const captureState = useCallback((): PersistedViewState => {
    return {
      preset,
      startDate,
      endDate,
      accountId,
      categoryGroupId,
      categoryId,
      selectedTagIds: [...selectedTagIds],
      tagsMatchAny,
      minAmount,
      maxAmount,
    }
  }, [
    preset,
    startDate,
    endDate,
    accountId,
    categoryGroupId,
    categoryId,
    selectedTagIds,
    tagsMatchAny,
    minAmount,
    maxAmount,
  ])

  const applyState = useCallback(
    (s: PersistedViewState & { subcategoryIds?: UUID[]; subcategoryId?: UUID | null }) => {
    setPreset(s.preset)
    setStartDate(s.startDate)
    setEndDate(s.endDate)
    setAccountId(s.accountId)
    setCategoryGroupId(s.categoryGroupId ?? null)
    setCategoryId(s.categoryId)
    // Legacy saved views may carry subcategoryIds / subcategoryId — ignore them.
    setSelectedTagIds([...s.selectedTagIds])
    setTagsMatchAny(s.tagsMatchAny)
    setMinAmount(s.minAmount)
    setMaxAmount(s.maxAmount)
  }, [])

  const handleSaveView = () => {
    const name = saveName.trim()
    if (!name) return
    const next: SavedNamedView = {
      id: crypto.randomUUID(),
      name,
      state: captureState(),
    }
    const merged = [...savedViews, next]
    setSavedViews(merged)
    persistSavedViews(merged)
    setSaveName('')
    setSaveDialogOpen(false)
  }

  const handleDeleteSaved = (id: string) => {
    const merged = savedViews.filter((v) => v.id !== id)
    setSavedViews(merged)
    persistSavedViews(merged)
  }

  const filteredTagsForList = useMemo(() => {
    const q = tagSearch.trim().toLowerCase()
    if (!q) return tags
    return tags.filter((t) => t.name.toLowerCase().includes(q))
  }, [tags, tagSearch])

  const toggleTag = (id: UUID) => {
    setSelectedTagIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
  }

  useEffect(() => {
    const today = new Date()
    const iso = (d: Date) => d.toISOString().slice(0, 10)
    if (preset === 'Custom') return
    if (preset === 'Last 7 days') {
      const start = new Date(today.getTime() - 7 * 24 * 3600 * 1000)
      setStartDate(iso(start))
      setEndDate(iso(today))
    } else if (preset === 'Last 30 days') {
      const start = new Date(today.getTime() - 30 * 24 * 3600 * 1000)
      setStartDate(iso(start))
      setEndDate(iso(today))
    } else if (preset === 'This month') {
      const start = new Date(today.getFullYear(), today.getMonth(), 1)
      setStartDate(iso(start))
      setEndDate(iso(today))
    } else if (preset === 'Year to date') {
      const start = new Date(today.getFullYear(), 0, 1)
      setStartDate(iso(start))
      setEndDate(iso(today))
    }
  }, [preset])

  const hasNoData = data != null && data.transaction_count === 0
  const awaitingData = !data && !viewsQuery.error && (loading || isFetching)
  const loadFailed = Boolean(viewsQuery.error) && !data

  const accountName = accountId != null ? accounts.find((a) => a.id === accountId)?.name : null
  const categoryGroupName = categoryGroupId != null ? categoryGroups.find((g) => g.id === categoryGroupId)?.name : null
  const categoryName = categoryId != null ? allCategories.find((c) => c.id === categoryId)?.name : null

  return (
    <div className="space-y-6 py-2 md:py-4">
      {/* ── Header ── */}
      <div className="space-y-1 pt-2">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">Explore</h1>
        <p className="max-w-2xl text-sm text-muted-foreground">
          Filter and analyze your transactions by date, account, category, tag, and amount.
        </p>
      </div>

      {/* ── Filter bar ── */}
      <div className="card-surface border border-border p-4 md:p-5">
        <div className="space-y-3">
          {/* Row 1: quick range + custom dates + saved + reset */}
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex flex-wrap items-center gap-1.5">
              {PRESETS.map((p) => (
                <RangeChip key={p} active={preset === p} onClick={() => setPreset(p)}>
                  {p}
                </RangeChip>
              ))}
            </div>

            {preset === 'Custom' ? (
              <div className="flex items-center gap-2">
                <Input
                  aria-label="Start date"
                  type="date"
                  className="h-9 w-[150px]"
                  value={startDate}
                  onChange={(e) => {
                    setPreset('Custom')
                    setStartDate(e.target.value)
                  }}
                />
                <span className="text-muted-foreground">→</span>
                <Input
                  aria-label="End date"
                  type="date"
                  className="h-9 w-[150px]"
                  value={endDate}
                  onChange={(e) => {
                    setPreset('Custom')
                    setEndDate(e.target.value)
                  }}
                />
              </div>
            ) : (
              <span className="text-xs text-muted-foreground">
                {startDate} → {endDate}
              </span>
            )}

            <div className="ml-auto flex items-center gap-1.5">
              {/* Saved views (this browser) */}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" className="gap-1.5">
                    <Bookmark className="h-4 w-4" />
                    Saved
                    {savedViews.length > 0 ? (
                      <Badge variant="secondary" className="ml-0.5 h-5 min-w-5 justify-center px-1 tabular-nums">
                        {savedViews.length}
                      </Badge>
                    ) : null}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-64">
                  <DropdownMenuLabel className="text-xs text-muted-foreground">
                    Saved filter sets (this browser)
                  </DropdownMenuLabel>
                  {savedViews.length === 0 ? (
                    <p className="px-2 py-3 text-xs text-muted-foreground">
                      No saved filter sets yet.
                    </p>
                  ) : (
                    savedViews.map((v) => (
                      <DropdownMenuItem
                        key={v.id}
                        className="flex items-center justify-between gap-2"
                        onSelect={(e) => {
                          e.preventDefault()
                          applyState(v.state)
                        }}
                      >
                        <span className="truncate">{v.name}</span>
                        <button
                          type="button"
                          className="rounded-sm p-1 text-muted-foreground hover:bg-surface-container-high hover:text-destructive"
                          aria-label={`Delete saved view ${v.name}`}
                          onClick={(e) => {
                            e.stopPropagation()
                            handleDeleteSaved(v.id)
                          }}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </DropdownMenuItem>
                    ))
                  )}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onSelect={(e) => {
                      e.preventDefault()
                      setSaveDialogOpen(true)
                    }}
                  >
                    <Plus className="mr-2 h-4 w-4" />
                    Save current filters…
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>

              <Button type="button" variant="ghost" size="sm" onClick={resetToDefaults}>
                Reset
              </Button>
            </div>
          </div>

          {/* Row 2: classification selects + search */}
          <div className="flex flex-wrap items-center gap-2">
            <Select value={accountId ?? '__all__'} onValueChange={(v) => setAccountId(v === '__all__' ? null : v)}>
              <SelectTrigger className="h-9 w-[160px]" aria-label="Account">
                <SelectValue placeholder="All accounts" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">All accounts</SelectItem>
                {accounts.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select
              value={categoryGroupId ?? '__all__'}
              onValueChange={(v) => setCategoryGroupId(v === '__all__' ? null : v)}
            >
              <SelectTrigger className="h-9 w-[160px]" aria-label="Category group">
                <SelectValue placeholder="All groups" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">All groups</SelectItem>
                {categoryGroups.map((g) => (
                  <SelectItem key={g.id} value={g.id}>
                    {g.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select value={categoryId ?? '__all__'} onValueChange={(v) => setCategoryId(v === '__all__' ? null : v)}>
              <SelectTrigger className="h-9 w-[160px]" aria-label="Category">
                <SelectValue placeholder="All categories" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">All categories</SelectItem>
                {topLevelCategories.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {/* Tags — inline multi-select popover */}
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  className={cn(
                    'h-9 gap-1.5 font-normal',
                    selectedTagIds.length ? 'border-primary/40 text-foreground' : 'text-muted-foreground',
                  )}
                  aria-label="Tags"
                >
                  <Tag className="h-4 w-4 opacity-70" />
                  {selectedTagIds.length ? `Tags · ${selectedTagIds.length}` : 'Tags'}
                  <ChevronDown className="h-3.5 w-3.5 opacity-60" />
                </Button>
              </PopoverTrigger>
              <PopoverContent align="start" className="w-64 p-3">
                <div className="space-y-2">
                  <Input
                    id="explore-tag-search"
                    className="h-9"
                    placeholder="Search tags…"
                    value={tagSearch}
                    onChange={(e) => setTagSearch(e.target.value)}
                  />
                  <div className="max-h-[200px] space-y-1 overflow-y-auto rounded-md border border-border bg-card p-2">
                    {filteredTagsForList.length === 0 ? (
                      <p className="px-2 py-3 text-xs text-muted-foreground">No tags match.</p>
                    ) : (
                      filteredTagsForList.map((t) => (
                        <label
                          key={t.id}
                          className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 hover:bg-surface-container-high"
                        >
                          <Checkbox checked={selectedTagIds.includes(t.id)} onCheckedChange={() => toggleTag(t.id)} />
                          <span className="text-sm">{t.name}</span>
                        </label>
                      ))
                    )}
                  </div>
                  <label className="flex items-center gap-2">
                    <Checkbox checked={tagsMatchAny} onCheckedChange={(c) => setTagsMatchAny(c === true)} />
                    <span className="cursor-pointer text-xs leading-snug text-muted-foreground">
                      Match <span className="font-medium text-foreground">any</span> selected tag (OR). Off = must have
                      all (AND).
                    </span>
                  </label>
                </div>
              </PopoverContent>
            </Popover>

            {/* Amount range — inline popover */}
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  className={cn(
                    'h-9 gap-1.5 font-normal',
                    minAmount > 0 || maxAmount > 0 ? 'border-primary/40 text-foreground' : 'text-muted-foreground',
                  )}
                  aria-label="Amount range"
                >
                  <SlidersHorizontal className="h-4 w-4 opacity-70" />
                  {minAmount > 0 || maxAmount > 0
                    ? `$${minAmount > 0 ? minAmount : '0'}–${maxAmount > 0 ? maxAmount : '∞'}`
                    : 'Amount'}
                  <ChevronDown className="h-3.5 w-3.5 opacity-60" />
                </Button>
              </PopoverTrigger>
              <PopoverContent align="start" className="w-64 p-3">
                <div className="space-y-2">
                  <p className="text-xs text-muted-foreground">Leave at 0 for no bound.</p>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="space-y-1">
                      <Label htmlFor="explore-min-amt" className="text-xs text-muted-foreground">
                        Min
                      </Label>
                      <Input
                        id="explore-min-amt"
                        type="number"
                        step="0.01"
                        min={0}
                        className="h-9"
                        value={minAmount || ''}
                        onChange={(e) => setMinAmount(e.target.value === '' ? 0 : Number(e.target.value))}
                        placeholder="0.00"
                      />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="explore-max-amt" className="text-xs text-muted-foreground">
                        Max
                      </Label>
                      <Input
                        id="explore-max-amt"
                        type="number"
                        step="0.01"
                        min={0}
                        className="h-9"
                        value={maxAmount || ''}
                        onChange={(e) => setMaxAmount(e.target.value === '' ? 0 : Number(e.target.value))}
                        placeholder="0.00"
                      />
                    </div>
                  </div>
                </div>
              </PopoverContent>
            </Popover>

            <Button
              type="button"
              variant="pill"
              size="pill"
              onClick={handleSearch}
              disabled={!startDate || !endDate || viewsQuery.isFetching}
              className="ml-auto gap-1.5"
            >
              <Search className="h-4 w-4" />
              {viewsQuery.isFetching ? 'Searching…' : 'Search'}
            </Button>
          </div>

          {/* Active filter chips (live, reflects pending selection) */}
          {activeFilterCount > 0 ? (
            <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
              {accountName ? (
                <ActiveChip label={`Account: ${accountName}`} onClear={() => setAccountId(null)} />
              ) : null}
              {categoryGroupName ? (
                <ActiveChip label={`Group: ${categoryGroupName}`} onClear={() => setCategoryGroupId(null)} />
              ) : null}
              {categoryName ? (
                <ActiveChip label={`Category: ${categoryName}`} onClear={() => setCategoryId(null)} />
              ) : null}
              {selectedTagIds.map((tid) => {
                const tname = tags.find((t) => t.id === tid)?.name ?? `#${tid}`
                return (
                  <ActiveChip
                    key={tid}
                    icon={<Tag className="h-3 w-3 opacity-70" />}
                    label={tname}
                    onClear={() => setSelectedTagIds((prev) => prev.filter((x) => x !== tid))}
                  />
                )
              })}
              {tagsMatchAny && selectedTagIds.length > 1 ? (
                <ActiveChip label="Tags: match any" onClear={() => setTagsMatchAny(false)} />
              ) : null}
              {shouldMinMaxInclude.min !== undefined ? (
                <ActiveChip label={`Min $${shouldMinMaxInclude.min.toFixed(2)}`} onClear={() => setMinAmount(0)} />
              ) : null}
              {shouldMinMaxInclude.max !== undefined ? (
                <ActiveChip label={`Max $${shouldMinMaxInclude.max.toFixed(2)}`} onClear={() => setMaxAmount(0)} />
              ) : null}
            </div>
          ) : null}
        </div>
      </div>

      {/* Save-current-filters dialog */}
      <Dialog open={saveDialogOpen} onOpenChange={setSaveDialogOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Save filter set</DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="explore-save-name" className="text-sm text-muted-foreground">
              Name
            </Label>
            <Input
              id="explore-save-name"
              value={saveName}
              onChange={(e) => setSaveName(e.target.value)}
              placeholder="e.g. Dining out — last quarter"
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleSaveView()
              }}
              autoFocus
            />
            <p className="text-xs text-muted-foreground">
              Saves the current filters to this browser so you can reload them anytime.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSaveDialogOpen(false)}>
              Cancel
            </Button>
            <Button variant="pill" size="pill" onClick={handleSaveView} disabled={!saveName.trim()}>
              <Check className="mr-1.5 h-4 w-4" />
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {error ? <div className="text-sm text-destructive">{error}</div> : null}

      {!committedParams && !error ? (
        <div className="rounded-xl border border-dashed border-border bg-surface-container-low/40 px-4 py-12 text-center">
          <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-full bg-surface-container text-primary">
            <Search className="h-5 w-5" />
          </div>
          <p className="mt-3 text-sm text-muted-foreground">
            Set your filters above and click <span className="font-medium text-foreground">Search</span> to run the
            query.
          </p>
        </div>
      ) : null}

      {committedParams && !data && loading ? (
        <div className="space-y-8">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
            {Array.from({ length: 5 }, (_, i) => (
              <Skeleton key={i} className="h-28 w-full rounded-xl" />
            ))}
          </div>
          <Skeleton className="h-64 w-full rounded-xl" />
        </div>
      ) : null}

      {data ? (
        <>
          {!loadFailed && hasNoData && !awaitingData ? (
            <div className="rounded-lg border border-dashed border-border bg-surface-container-low px-4 py-3 text-sm text-muted-foreground">
              No transactions match these filters. Try widening the date range or removing filters.
            </div>
          ) : null}

          {!loadFailed ? (
            <motion.div
              variants={container}
              initial="hidden"
              animate="show"
              className="space-y-8"
              style={{ opacity: awaitingData ? 0.72 : 1, transition: 'opacity 0.15s ease' }}
            >
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
                <StatCard
                  icon={<ArrowDownRight className="h-4 w-4" />}
                  iconClass="text-destructive"
                  label="Total spending"
                  hint="Adds up every matching debit (money out). Transfers between your own accounts, income, hidden rows, and rows excluded from totals are all left out."
                  awaiting={awaitingData}
                  value={formatCurrency(Number(data.total_spending))}
                />
                <StatCard
                  icon={<ArrowUpRight className="h-4 w-4" />}
                  iconClass="text-income"
                  label="Total income"
                  hint="Adds up every matching credit (money in) — paychecks, refunds, interest. Transfers between your own accounts are left out."
                  awaiting={awaitingData}
                  value={formatCurrency(Number(data.total_income))}
                />
                <StatCard
                  icon={<Receipt className="h-4 w-4" />}
                  iconClass="text-primary"
                  label="Net cash flow"
                  hint="Total income minus total spending. Green means you took in more than you spent over this window; red means you spent more than you took in."
                  awaiting={awaitingData}
                  value={formatCurrency(Math.abs(netCashFlow))}
                  valueClass={
                    netCashFlow > 0 ? 'text-income' : netCashFlow < 0 ? 'text-destructive' : 'text-foreground'
                  }
                  sub={netCashFlow < 0 ? 'Spent more than you took in' : undefined}
                />
                <StatCard
                  icon={<Tag className="h-4 w-4" />}
                  iconClass="text-primary"
                  label="Transactions"
                  hint="How many transactions matched your filters, including transfers."
                  awaiting={awaitingData}
                  value={String(data.transaction_count)}
                  sub={`${data.start_date} → ${data.end_date}`}
                />
                <StatCard
                  icon={<Receipt className="h-4 w-4" />}
                  iconClass="text-primary"
                  label="Avg transaction size"
                  hint="Mean of the matching transaction amounts, ignoring their sign — so a $50 charge and a $50 refund both count as $50."
                  awaiting={awaitingData}
                  value={data.transaction_count === 0 ? '—' : formatCurrency(avgAbsFromTxns)}
                />
              </div>

              <motion.div variants={item} className="card-surface border border-border p-6">
                <div className="mb-4 flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
                  <div>
                    <h2 className="mb-1 text-sm font-semibold">Daily activity</h2>
                    <p className="text-xs text-muted-foreground">
                      Money in and money out per day, kept apart rather than netted (excludes
                      transfers).
                    </p>
                  </div>
                  <div className="flex items-center gap-3 text-xs text-muted-foreground">
                    <span className="flex items-center gap-1.5">
                      <span className="h-2.5 w-2.5 rounded-sm bg-income" aria-hidden />
                      Money in
                    </span>
                    <span className="flex items-center gap-1.5">
                      <span className="h-2.5 w-2.5 rounded-sm bg-destructive" aria-hidden />
                      Money out
                    </span>
                  </div>
                </div>
                {awaitingData ? (
                  <Skeleton className="h-[220px] w-full rounded-xl" />
                ) : hasNoData ? (
                  <p className="py-12 text-center text-sm text-muted-foreground">No data for this view.</p>
                ) : barData.length === 0 ? (
                  <p className="py-12 text-center text-sm text-muted-foreground">No daily series for this range.</p>
                ) : (
                  <div className="h-[min(38vh,320px)] min-h-[220px] w-full">
                    <ResponsiveContainer width="100%" height="100%">
                      {/* stackOffset="sign" is what anchors BOTH bars to the zero line:
                          the default ("none") sums naively, which stacked the negative
                          spending bar on top of the positive income bar. */}
                      <BarChart
                        data={barData}
                        stackOffset="sign"
                        margin={{ top: 8, right: 12, left: 4, bottom: 8 }}
                      >
                        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                        <XAxis
                          dataKey="label"
                          tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }}
                          tickLine={false}
                          axisLine={false}
                          interval="preserveStartEnd"
                          height={36}
                        />
                        <YAxis
                          tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }}
                          tickLine={false}
                          axisLine={false}
                          width={56}
                          tickFormatter={(v) => {
                            const n = Number(v)
                            const s = Math.abs(n).toLocaleString('en-US', { maximumFractionDigits: 0 })
                            if (n < 0) return `−$${s}`
                            if (n > 0) return `$${s}`
                            return '$0'
                          }}
                        />
                        <RechartsTooltip
                          cursor={{ fill: 'hsl(var(--muted) / 0.4)' }}
                          content={<DailyActivityTooltip txnsByDate={txnsByDate} />}
                        />
                        <ReferenceLine y={0} stroke="hsl(var(--border))" />
                        <Bar
                          dataKey="income"
                          stackId="daily"
                          fill="hsl(var(--income))"
                          maxBarSize={32}
                          radius={[4, 4, 0, 0]}
                        />
                        <Bar
                          dataKey="spending"
                          stackId="daily"
                          fill="hsl(var(--destructive))"
                          maxBarSize={32}
                          radius={[0, 0, 4, 4]}
                        />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                )}
              </motion.div>

              <motion.div variants={item}>
                <Tabs value={breakdownTab} onValueChange={(v) => setBreakdownTab(v as typeof breakdownTab)}>
                  <TabsList className="mb-4">
                    <TabsTrigger value="category">By category</TabsTrigger>
                    <TabsTrigger value="category_group">By group</TabsTrigger>
                    <TabsTrigger value="tag">By tag</TabsTrigger>
                  </TabsList>

                  {/* ── By category ── */}
                  <TabsContent value="category" className="mt-0">
                    <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
                      <div className="card-surface min-w-0 border border-border p-6">
                        <h2 className="mb-4 text-sm font-semibold">Breakdown</h2>
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <SortableTableHead label="Category" columnKey="category" sort={viewsCategorySort} onSort={(k) => setViewsCategorySort((p) => cycleSort(p, k))} />
                              <SortableTableHead label="Total" columnKey="total" sort={viewsCategorySort} onSort={(k) => setViewsCategorySort((p) => cycleSort(p, k))} />
                              <SortableTableHead label="Count" columnKey="count" sort={viewsCategorySort} onSort={(k) => setViewsCategorySort((p) => cycleSort(p, k))} />
                              <SortableTableHead label="%" columnKey="percent" sort={viewsCategorySort} onSort={(k) => setViewsCategorySort((p) => cycleSort(p, k))} />
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {data.by_category.length === 0 ? (
                              <TableRow><TableCell colSpan={4} className="text-muted-foreground">No categories.</TableCell></TableRow>
                            ) : (
                              sortedViewsByCategory.map((r, idx) => (
                                <TableRow key={idx}>
                                  <TableCell className="font-medium">{String(r.category)}</TableCell>
                                  <TableCell className="tabular-nums">{formatCurrency(Number(r.total))}</TableCell>
                                  <TableCell className="tabular-nums">{String(r.count ?? '')}</TableCell>
                                  <TableCell className="tabular-nums">{Number(r.percent).toFixed(1)}%</TableCell>
                                </TableRow>
                              ))
                            )}
                          </TableBody>
                        </Table>
                      </div>
                      <SpendPieCard
                        title="Spend by category"
                        rawSlices={categoryRaw}
                        emptyHint="No categorized spending in this view."
                        sliceRows={sliceRowsFrom(spendRowsBy.byCategory)}
                        twoThirdsPieLayout
                      />
                    </div>
                  </TabsContent>

                  {/* ── By category group ── */}
                  <TabsContent value="category_group" className="mt-0">
                    <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
                      <div className="card-surface min-w-0 border border-border p-6">
                        <h2 className="mb-4 text-sm font-semibold">Breakdown</h2>
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <SortableTableHead label="Group" columnKey="name" sort={viewsCategoryGroupSort} onSort={(k) => setViewsCategoryGroupSort((p) => cycleSort(p, k))} />
                              <SortableTableHead label="Total" columnKey="total" sort={viewsCategoryGroupSort} onSort={(k) => setViewsCategoryGroupSort((p) => cycleSort(p, k))} />
                              <SortableTableHead label="Count" columnKey="count" sort={viewsCategoryGroupSort} onSort={(k) => setViewsCategoryGroupSort((p) => cycleSort(p, k))} />
                              <SortableTableHead label="%" columnKey="percent" sort={viewsCategoryGroupSort} onSort={(k) => setViewsCategoryGroupSort((p) => cycleSort(p, k))} />
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {data.by_category_group.length === 0 ? (
                              <TableRow><TableCell colSpan={4} className="text-muted-foreground">No group data.</TableCell></TableRow>
                            ) : (
                              sortedViewsByCategoryGroup.map((r, idx) => (
                                <TableRow key={idx}>
                                  <TableCell className="font-medium">{String(r.name)}</TableCell>
                                  <TableCell className="tabular-nums">{formatCurrency(Number(r.total))}</TableCell>
                                  <TableCell className="tabular-nums">{String(r.count ?? '')}</TableCell>
                                  <TableCell className="tabular-nums">{Number(r.percent).toFixed(1)}%</TableCell>
                                </TableRow>
                              ))
                            )}
                          </TableBody>
                        </Table>
                      </div>
                      <SpendPieCard
                        title="Spend by group"
                        rawSlices={categoryGroupRaw}
                        emptyHint="No group spending in this view."
                        sliceRows={sliceRowsFrom(spendRowsBy.byGroup)}
                        twoThirdsPieLayout
                      />
                    </div>
                  </TabsContent>

                  {/* ── By tag ── */}
                  <TabsContent value="tag" className="mt-0">
                    <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
                      <div className="card-surface min-w-0 border border-border p-6">
                        <h2 className="mb-4 text-sm font-semibold">Breakdown</h2>
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <SortableTableHead label="Tag" columnKey="name" sort={viewsTagSort} onSort={(k) => setViewsTagSort((p) => cycleSort(p, k))} />
                              <SortableTableHead label="Total" columnKey="total" sort={viewsTagSort} onSort={(k) => setViewsTagSort((p) => cycleSort(p, k))} />
                              <SortableTableHead label="Count" columnKey="count" sort={viewsTagSort} onSort={(k) => setViewsTagSort((p) => cycleSort(p, k))} />
                              <SortableTableHead label="%" columnKey="percent" sort={viewsTagSort} onSort={(k) => setViewsTagSort((p) => cycleSort(p, k))} />
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {data.by_tag.length === 0 ? (
                              <TableRow><TableCell colSpan={4} className="text-muted-foreground">No tags assigned.</TableCell></TableRow>
                            ) : (
                              sortedViewsByTag.map((r, idx) => (
                                <TableRow key={idx}>
                                  <TableCell className="font-medium">{String(r.name)}</TableCell>
                                  <TableCell className="tabular-nums">{formatCurrency(Number(r.total))}</TableCell>
                                  <TableCell className="tabular-nums">{String(r.count ?? '')}</TableCell>
                                  <TableCell className="tabular-nums">{Number(r.percent).toFixed(1)}%</TableCell>
                                </TableRow>
                              ))
                            )}
                          </TableBody>
                        </Table>
                      </div>
                      <SpendPieCard
                        title="Spend by tag"
                        rawSlices={tagRaw}
                        emptyHint="No tagged spending in this view."
                        sliceRows={sliceRowsFrom(spendRowsBy.byTag)}
                        twoThirdsPieLayout
                      />
                    </div>
                  </TabsContent>
                </Tabs>
              </motion.div>

              <motion.div variants={item} className="card-surface border border-border p-6">
                <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
                  <h2 className="text-sm font-semibold">Transactions</h2>
                  {sortedViewsTransactions.length > 0 ? (
                    <p className="text-xs tabular-nums text-muted-foreground">
                      Showing {safeTxnPage * TXN_PAGE_SIZE + 1}–
                      {Math.min((safeTxnPage + 1) * TXN_PAGE_SIZE, sortedViewsTransactions.length)} of{' '}
                      {sortedViewsTransactions.length}
                    </p>
                  ) : null}
                </div>
                <div className="-mx-2 overflow-x-auto px-2">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <SortableTableHead label="Date" columnKey="Date" sort={viewsTxnSort} onSort={(k) => setViewsTxnSort((p) => cycleSort(p, k))} />
                        <SortableTableHead label="Merchant" columnKey="Merchant" sort={viewsTxnSort} onSort={(k) => setViewsTxnSort((p) => cycleSort(p, k))} />
                        <SortableTableHead label="Amount" columnKey="Amount" sort={viewsTxnSort} onSort={(k) => setViewsTxnSort((p) => cycleSort(p, k))} align="right" />
                        <SortableTableHead label="Category" columnKey="Category" sort={viewsTxnSort} onSort={(k) => setViewsTxnSort((p) => cycleSort(p, k))} />
                        <SortableTableHead label="Tags" columnKey="Tags" sort={viewsTxnSort} onSort={(k) => setViewsTxnSort((p) => cycleSort(p, k))} />
                        <SortableTableHead label="Notes" columnKey="Notes" sort={viewsTxnSort} onSort={(k) => setViewsTxnSort((p) => cycleSort(p, k))} />
                        <SortableTableHead label="Account" columnKey="Acct" sort={viewsTxnSort} onSort={(k) => setViewsTxnSort((p) => cycleSort(p, k))} />
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.transactions.length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={7} className="text-muted-foreground">
                            No transactions found.
                          </TableCell>
                        </TableRow>
                      ) : (
                        pagedViewsTransactions.map((r, idx) => {
                          const row = r as unknown as TxnRow
                          return (
                            <TableRow key={row.id ?? idx}>
                              <TableCell className="whitespace-nowrap tabular-nums text-xs">{row.Date}</TableCell>
                              <TableCell className="max-w-[140px] truncate" title={row.Merchant}>
                                {row.Merchant}
                              </TableCell>
                              <TableCell className="text-right tabular-nums">
                                {formatCurrency(Number(row.Amount))}
                              </TableCell>
                              <TableCell>{row.Category}</TableCell>
                              <TableCell className="max-w-[120px] truncate" title={row.Tags}>
                                {row.Tags}
                              </TableCell>
                              <TableCell className="max-w-[120px] truncate" title={row.Notes}>
                                {row.Notes}
                              </TableCell>
                              <TableCell className="whitespace-nowrap">
                                <span className="mr-1.5">{row.Acct}</span>
                                {row.is_transfer ? (
                                  <Badge variant="outline" className="px-1.5 py-0 text-[10px] font-normal">
                                    Transfer
                                  </Badge>
                                ) : null}
                              </TableCell>
                            </TableRow>
                          )
                        })
                      )}
                    </TableBody>
                  </Table>
                </div>
                {txnPageCount > 1 ? (
                  <div className="mt-4 flex items-center justify-between gap-2 border-t border-border pt-3">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="gap-1"
                      disabled={safeTxnPage === 0}
                      onClick={() => setTxnPage((p) => Math.max(0, p - 1))}
                    >
                      <ChevronLeft className="h-4 w-4" />
                      Previous
                    </Button>
                    <span className="text-xs tabular-nums text-muted-foreground">
                      Page {safeTxnPage + 1} of {txnPageCount}
                    </span>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="gap-1"
                      disabled={safeTxnPage >= txnPageCount - 1}
                      onClick={() => setTxnPage((p) => Math.min(txnPageCount - 1, p + 1))}
                    >
                      Next
                      <ChevronRight className="h-4 w-4" />
                    </Button>
                  </div>
                ) : null}
              </motion.div>
            </motion.div>
          ) : null}
        </>
      ) : null}
    </div>
  )
}

/** Removable active-filter chip shown under the filter bar. */
function ActiveChip({
  label,
  icon,
  onClear,
}: {
  label: string
  icon?: React.ReactNode
  onClear: () => void
}) {
  return (
    <Badge variant="secondary" className="gap-1 font-normal">
      {icon}
      {label}
      <button
        type="button"
        className="rounded-sm p-0.5 hover:bg-surface-container-high"
        aria-label={`Remove ${label}`}
        onClick={onClear}
      >
        <X className="h-3 w-3" />
      </button>
    </Badge>
  )
}

/** Most transactions listed in one Daily activity hover card before it truncates. */
const DAILY_TOOLTIP_MAX_ROWS = 7

/** Hover card for the Daily activity chart: the day's in/out totals plus the actual
 *  transactions behind them, regrouped from rows the page already fetched. */
function DailyActivityTooltip({
  active,
  payload,
  txnsByDate,
}: {
  active?: boolean
  payload?: Array<{ payload?: { label?: string; iso?: string; income?: number; spending?: number } }>
  txnsByDate: Map<string, TxnRow[]>
}) {
  const point = payload?.[0]?.payload
  if (!active || !point?.iso) return null

  const income = Number(point.income ?? 0)
  const spending = Math.abs(Number(point.spending ?? 0))
  const dayRows = txnsByDate.get(point.iso) ?? []
  // The bars exclude transfers, so the list must too — otherwise the rows wouldn't
  // add up to the totals directly above them.
  const rows = dayRows.filter((r) => !r.is_transfer)
  const transferCount = dayRows.length - rows.length
  const shown = rows.slice(0, DAILY_TOOLTIP_MAX_ROWS)

  return (
    <div className="max-w-[280px] rounded-md border border-border bg-popover px-3 py-2 text-popover-foreground shadow-overlay">
      <p className="text-xs font-semibold">{point.label}</p>
      <div className="mt-1 flex gap-3 text-[11px] tabular-nums">
        {income > 0 ? <span className="text-income">In {formatCurrency(income)}</span> : null}
        {spending > 0 ? <span className="text-destructive">Out {formatCurrency(spending)}</span> : null}
      </div>
      {shown.length > 0 ? (
        <ul className="mt-2 space-y-1 border-t border-border/60 pt-2 text-[11px]">
          {shown.map((r, i) => (
            <li key={r.id ?? i} className="flex items-baseline justify-between gap-3">
              <span className="min-w-0 flex-1 truncate">{r.Merchant || '—'}</span>
              <span
                className={cn(
                  'shrink-0 tabular-nums',
                  Number(r.Amount) < 0 ? 'text-income' : 'text-foreground',
                )}
              >
                {formatCurrency(Math.abs(Number(r.Amount)))}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {rows.length > shown.length ? (
        <p className="mt-1.5 text-[11px] text-muted-foreground">
          +{rows.length - shown.length} more
        </p>
      ) : null}
      {transferCount > 0 ? (
        <p className="mt-1 text-[11px] text-muted-foreground">
          {transferCount} transfer{transferCount === 1 ? '' : 's'} not counted
        </p>
      ) : null}
    </div>
  )
}

/** "How is this calculated?" affordance next to a stat label.
 *  A Popover, not a Tooltip: tooltips are hover-only, so tapping the ⓘ on touch
 *  (or clicking it on desktop, which dismisses a tooltip) showed nothing. */
function InfoHint({ label, text }: { label: string; text: string }) {
  return (
    <Popover>
      <PopoverTrigger
        type="button"
        aria-label={`How ${label} is calculated`}
        className="shrink-0 rounded-full text-muted-foreground/60 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Info className="h-3.5 w-3.5" />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-3 text-xs leading-relaxed text-muted-foreground">
        <p className="mb-1 text-xs font-semibold text-foreground">{label}</p>
        {text}
      </PopoverContent>
    </Popover>
  )
}

/** Summary metric tile (list-row icon well + value). */
function StatCard({
  icon,
  iconClass,
  label,
  hint,
  awaiting,
  value,
  valueClass,
  sub,
}: {
  icon: React.ReactNode
  iconClass?: string
  label: string
  hint?: string
  awaiting: boolean
  value: string
  valueClass?: string
  sub?: string
}) {
  return (
    <motion.div variants={item} className="card-surface border border-border p-5">
      <div className="mb-2.5 flex items-center gap-2">
        <div className={cn('flex h-8 w-8 items-center justify-center rounded-full bg-surface-container', iconClass)}>
          {icon}
        </div>
        <div className="flex min-w-0 items-center gap-1.5">
          <p className="text-xs font-medium text-muted-foreground">{label}</p>
          {hint ? <InfoHint label={label} text={hint} /> : null}
        </div>
      </div>
      {awaiting ? (
        <div className="text-2xl tabular-nums text-muted-foreground">—</div>
      ) : (
        <p className={cn('text-2xl font-bold tabular-nums', valueClass ?? 'text-foreground')}>{value}</p>
      )}
      {sub ? <p className="mt-1.5 text-[11px] text-muted-foreground">{sub}</p> : null}
    </motion.div>
  )
}
