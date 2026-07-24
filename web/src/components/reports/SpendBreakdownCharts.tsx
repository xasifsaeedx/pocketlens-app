import { useMemo } from 'react'
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip as RechartsTooltip } from 'recharts'
import { categorySeriesColor } from '@/lib/categoryColors'
import { cn } from '@/lib/utils'
import { formatCurrency } from '@/lib/money'

// `category_id` is a Keep int id on the FastAPI-backed ViewsPage but a Supabase UUID
// (string) on the Supabase-backed BudgetsPage — this component is shared by both, so
// the id type is widened to accept either.
export type CategoryId = string | number

export type BreakdownRow = {
  total: number
  count?: number
  percent: number
  name?: string
  tag?: string
  category?: string
  subcategory?: string
  category_id?: CategoryId
  /** Optional stored hex color (e.g. category.color) for identity-stable slice fills. */
  color?: string
}

export type RawSlice = {
  name: string
  value: number
  pct: number
  categoryId?: CategoryId
  /** Signed contribution from backend row.total (negative=outflow/spending). */
  signedTotal: number
  /** Stored hex color, when the source row carries one; drives identity-stable fills. */
  color?: string
}

type PieSlice = RawSlice & {
  isEtAl: boolean
  fill: string
}

type LegendRow = {
  name: string
  pct: number
  color: string
  inEtAlGroup?: boolean
}

const pieColors = [
  'hsl(217, 91%, 54%)',
  'hsl(199, 80%, 48%)',
  'hsl(160, 84%, 38%)',
  'hsl(262, 52%, 52%)',
  'hsl(239, 58%, 58%)',
  'hsl(330, 65%, 52%)',
  'hsl(38, 92%, 50%)',
  'hsl(220, 11%, 58%)',
]

const ET_AL_COLOR = 'hsl(var(--muted-foreground) / 0.35)'
const ET_AL_SLICE_FILL = 'hsl(var(--muted) / 0.55)'

const SMALL_SLICE_PCT = 1

export const breakdownMotionContainer = {
  hidden: {},
  show: { transition: { staggerChildren: 0.06 } },
}

export const breakdownMotionItem = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0, transition: { duration: 0.35 } },
}

function consolidatePieSlices(raw: RawSlice[]): { pieSlices: PieSlice[]; legendRows: LegendRow[] } {
  if (raw.length === 0) return { pieSlices: [], legendRows: [] }

  // Spend pies should represent outflows only.
  // Use negative signed totals to decide what's included in the pie and recompute share %
  // from the outflow magnitudes (ignore any backend sign inconsistencies on `percent`).
  const plotable = raw.filter((s) => s.signedTotal < 0)
  const totalOutflow = plotable.reduce((acc, s) => acc + s.value, 0)
  if (totalOutflow <= 0) return { pieSlices: [], legendRows: [] }

  const sorted = [...plotable].sort((a, b) => b.value - a.value).map((s) => ({
    ...s,
    pct: (s.value / totalOutflow) * 100,
  }))

  const major = sorted.filter((s) => s.pct >= SMALL_SLICE_PCT)
  const minor = sorted.filter((s) => s.pct < SMALL_SLICE_PCT)

  const pieSlices: PieSlice[] = []
  const legendRows: LegendRow[] = []

  major.forEach((s, i) => {
    // Identity-stable: when the row carries its own stored color (category.color), a
    // category keeps the SAME hue in every chart. Fall back to the rank palette for
    // sources without stored colors (tags, Keep's ViewsPage).
    const fill = s.color ? categorySeriesColor(s.color) : pieColors[i % pieColors.length]
    pieSlices.push({ ...s, isEtAl: false, fill })
    legendRows.push({ name: s.name, pct: s.pct, color: fill })
  })

  if (minor.length > 0) {
    const sumV = minor.reduce((a, b) => a + b.value, 0)
    const sumP = minor.reduce((a, b) => a + b.pct, 0)
    const sumSigned = minor.reduce((a, b) => a + b.signedTotal, 0)
    pieSlices.push({
      name: 'et al.',
      value: sumV,
      pct: sumP,
      isEtAl: true,
      fill: ET_AL_SLICE_FILL,
      signedTotal: sumSigned,
    })
    minor.forEach((s) => {
      legendRows.push({
        name: s.name,
        pct: s.pct,
        color: ET_AL_COLOR,
        inEtAlGroup: true,
      })
    })
  }

  return { pieSlices, legendRows }
}

export function rawSlicesFromRows(
  rows: BreakdownRow[],
  nameKey: 'name' | 'tag' | 'category' | 'subcategory',
  idKey?: 'category_id',
): RawSlice[] {
  const out: RawSlice[] = []
  for (const row of rows) {
    const rawSigned = Number(row.total)
    if (!Number.isFinite(rawSigned)) continue
    const magnitude = Math.abs(rawSigned)
    if (magnitude <= 0) continue
    const label = String(row[nameKey] ?? 'Unknown').trim() || 'Unknown'

    // Exclude Income category from visualization entirely.
    // For subcategories we can still inspect the parent category name.
    const parentCategoryName = String(row.category ?? '').toLowerCase()
    const isIncomeCategory = label.toLowerCase() === 'income' || parentCategoryName === 'income'
    if ((nameKey === 'category' && label.toLowerCase() === 'income') || (nameKey === 'subcategory' && isIncomeCategory)) {
      continue
    }

    const slice: RawSlice = {
      name: label,
      value: magnitude,
      // `pct` is recomputed in `consolidatePieSlices` from outflow magnitudes, but we
      // keep a numeric field to satisfy the type contract.
      pct: 0,
      signedTotal: rawSigned,
    }
    if (idKey && row.category_id != null) {
      slice.categoryId = row.category_id
    }
    if (row.color) {
      slice.color = row.color
    }
    out.push(slice)
  }
  return out
}

/** One line in a slice's hover breakdown — kept deliberately generic so this component
 *  stays independent of any particular page's transaction shape. */
export type SliceDetailRow = { id?: string; label: string; amount: number }

/** Most detail rows shown in a slice hover card before it truncates. */
const SLICE_TOOLTIP_MAX_ROWS = 7

/** Hover card for a pie slice: its total and share, plus the rows behind it when the
 *  caller supplies a `sliceRows` lookup. Falls back to total-only otherwise. */
function SliceTooltip({
  active,
  payload,
  sliceRows,
}: {
  active?: boolean
  payload?: Array<{ payload?: PieSlice }>
  sliceRows?: (slice: PieSlice) => SliceDetailRow[]
}) {
  const slice = payload?.[0]?.payload
  if (!active || !slice) return null

  // "et al." is a synthetic bucket of many small slices — there is no single row set
  // behind it, so it stays a total-only tooltip.
  const rows = sliceRows && !slice.isEtAl ? sliceRows(slice) : []
  const shown = rows.slice(0, SLICE_TOOLTIP_MAX_ROWS)

  return (
    <div className="max-w-[280px] rounded-md border border-border bg-popover px-3 py-2 text-popover-foreground shadow-overlay">
      <p className="text-xs font-semibold">{slice.name}</p>
      <p className="mt-0.5 text-[11px] tabular-nums text-muted-foreground">
        {formatCurrency(slice.value)} · {slice.pct.toFixed(1)}%
      </p>
      {shown.length > 0 ? (
        <ul className="mt-2 space-y-1 border-t border-border/60 pt-2 text-[11px]">
          {shown.map((r, i) => (
            <li key={r.id ?? i} className="flex items-baseline justify-between gap-3">
              <span className="min-w-0 flex-1 truncate">{r.label || '—'}</span>
              <span className="shrink-0 tabular-nums">{formatCurrency(Math.abs(r.amount))}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {rows.length > shown.length ? (
        <p className="mt-1.5 text-[11px] text-muted-foreground">
          +{rows.length - shown.length} more
        </p>
      ) : null}
    </div>
  )
}

function PieLegendList({
  rows,
  showEtAlNote,
  large,
}: {
  rows: LegendRow[]
  showEtAlNote: boolean
  large?: boolean
}) {
  return (
    <div>
      {showEtAlNote ? (
        <p
          className={cn(
            'text-muted-foreground mb-2 leading-snug',
            large ? 'text-xs' : 'text-[10px]',
          )}
        >
          Segments under 1% are drawn as one &quot;et al.&quot; slice; each category still appears here.
        </p>
      ) : null}
      <ul
        className={cn(
          'leading-snug max-h-[min(52vh,360px)] overflow-y-auto pr-1',
          large ? 'space-y-2 text-sm' : 'space-y-1.5 text-[11px]',
        )}
      >
        {rows.map((row, i) => (
          <li key={`${row.name}-${i}`} className="flex items-start gap-2 min-w-0">
            <span
              className={cn(
                'shrink-0 rounded-sm',
                large ? 'mt-0.5 h-3 w-3' : 'mt-1 h-2.5 w-2.5',
              )}
              style={{ backgroundColor: row.color }}
              aria-hidden
            />
            <span className={row.inEtAlGroup ? 'text-muted-foreground' : 'text-foreground'}>
              <span className="break-words">{row.name}</span>
              <span className="tabular-nums text-muted-foreground"> — {row.pct.toFixed(1)}%</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

export function SpendPieCard({
  title,
  subtitle,
  rawSlices,
  emptyHint,
  interactiveCategory,
  selectedCategoryId,
  onCategorySliceClick,
  twoThirdsPieLayout,
  sliceRows,
}: {
  title: string
  subtitle?: string
  rawSlices: RawSlice[]
  emptyHint: string
  interactiveCategory?: boolean
  selectedCategoryId?: CategoryId | null
  onCategorySliceClick?: (categoryId: CategoryId) => void
  twoThirdsPieLayout?: boolean
  /** Optional lookup of the rows behind a slice, listed in its hover card. */
  sliceRows?: (slice: RawSlice) => SliceDetailRow[]
}) {
  const { pieSlices, legendRows } = useMemo(() => consolidatePieSlices(rawSlices), [rawSlices])
  const showEtAlNote = legendRows.some((r) => r.inEtAlGroup)
  // Total outflow plotted — shown as the hero readout in the donut hole.
  const donutTotal = useMemo(() => pieSlices.reduce((acc, s) => acc + s.value, 0), [pieSlices])

  // If there are no *plotable* slices (e.g. only income/refunds), we still want to show the legend.
  if (rawSlices.length === 0) {
    return (
      <div className="card-surface border p-6 flex flex-col min-h-[320px]">
        <h2 className="text-sm font-semibold mb-1">{title}</h2>
        {subtitle ? <p className="text-xs text-muted-foreground mb-4">{subtitle}</p> : null}
        <p className="text-sm text-muted-foreground flex-1 flex items-center justify-center">{emptyHint}</p>
      </div>
    )
  }

  return (
    <div className="card-surface border p-6 min-w-0">
      <h2 className="text-sm font-semibold mb-1">{title}</h2>
      {subtitle ? <p className="text-xs text-muted-foreground mb-4">{subtitle}</p> : null}
      <div className="flex flex-col lg:flex-row lg:items-stretch gap-4 min-w-0">
        <div
          className={cn(
            'relative h-[min(52vh,420px)] min-h-[260px] min-w-0',
            twoThirdsPieLayout ? 'lg:flex-[2]' : 'flex-1',
          )}
        >
          {pieSlices.length === 0 ? (
            <p className="text-sm text-muted-foreground flex-1 flex items-center justify-center">{emptyHint}</p>
          ) : (
            <>
            {/* Hero total centered in the donut hole. */}
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center px-6 text-center">
              <span className="eyebrow">Total</span>
              <span className="text-2xl font-bold leading-tight tracking-tight tabular-nums text-foreground sm:text-3xl">
                {formatCurrency(donutTotal)}
              </span>
            </div>
            <ResponsiveContainer width="100%" height="100%">
              <PieChart margin={{ top: 4, right: 4, bottom: 4, left: 4 }}>
                <Pie
                  data={pieSlices}
                  dataKey="value"
                  nameKey="name"
                  cx="50%"
                  cy="50%"
                  innerRadius="44%"
                  outerRadius="76%"
                  paddingAngle={1.2}
                  strokeWidth={1}
                  stroke="hsl(var(--background))"
                  label={false}
                  cursor={interactiveCategory ? 'pointer' : 'default'}
                  onClick={
                    interactiveCategory && onCategorySliceClick
                      ? (_, index) => {
                          const s = pieSlices[index]
                          if (!s || s.isEtAl || s.categoryId == null) return
                          onCategorySliceClick(s.categoryId)
                        }
                      : undefined
                  }
                >
                  {pieSlices.map((s, i) => {
                    const selected =
                      interactiveCategory &&
                      !s.isEtAl &&
                      s.categoryId != null &&
                      selectedCategoryId === s.categoryId
                    return (
                      <Cell
                        key={i}
                        fill={s.fill}
                        stroke={selected ? 'hsl(var(--primary))' : 'hsl(var(--background))'}
                        strokeWidth={selected ? 3 : 1}
                        className={interactiveCategory ? 'outline-none' : ''}
                      />
                    )
                  })}
                </Pie>
                <RechartsTooltip content={<SliceTooltip sliceRows={sliceRows} />} />
              </PieChart>
            </ResponsiveContainer>
            </>
          )}
        </div>
        <div
          className={cn(
            'w-full shrink-0 lg:border-l lg:border-border/60 lg:pl-4',
            twoThirdsPieLayout ? 'lg:flex-1 lg:min-w-0' : 'lg:w-[min(100%,280px)]',
          )}
        >
          <p
            className={cn(
              'font-medium uppercase tracking-wide text-muted-foreground mb-2',
              twoThirdsPieLayout ? 'text-xs' : 'text-[10px]',
            )}
          >
            Legend
          </p>
          <PieLegendList rows={legendRows} showEtAlNote={showEtAlNote} large={twoThirdsPieLayout} />
        </div>
      </div>
    </div>
  )
}
