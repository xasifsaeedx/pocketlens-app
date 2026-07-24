// SpendDonutChart — nested two-ring pie for monthly category spend.
//
// ARCHITECTURE
// Both rings iterate over the exact same ordered segment list so their arcs
// are always angularly aligned:
//
//   [group A cats...] [group B cats...] [ungrouped cats...] [uncategorized]
//
// Inner ring: one colored slice per segment entry.
// Outer ring: one arc per *group* (summed value), followed by a transparent
//   placeholder whose value = Σ(ungrouped) + uncategorized.  Because both
//   rings share the same total and the same ordering, the group arc on the
//   outer ring always sits exactly on top of its categories on the inner ring.
//
// GAP FIX
// Recharts has a known bug with endAngle = startAngle ± 360 — it treats that
// as a degenerate full circle and renders a gap at the seam.  The only
// reliable fix is endAngle = startAngle - 360 (clockwise, -270 when start=90).

import { useMemo, useState } from 'react'
import type { ReactElement } from 'react'
import { PieChart, Pie, Cell, Tooltip, Sector } from 'recharts'
import { formatCurrency } from '@/lib/money'
import { cn } from '@/lib/utils'
import type { Category, CategoryGroup } from '@/types/domain'

// ─── public types ────────────────────────────────────────────────────────────

export interface SpendRow {
  category: Category
  total: number
}

interface Props {
  spendRows: SpendRow[]
  groups: CategoryGroup[]
  /** Total gross spend (including uncategorized). Falls back to Σ spendRows. */
  totalSpend?: number
  className?: string
}

// ─── ring geometry ───────────────────────────────────────────────────────────

const CHART_SIZE      = 260
const CX              = CHART_SIZE / 2
const CY              = CHART_SIZE / 2

const INNER_IR = 54
const INNER_OR = 82   // 28 px thick
const OUTER_IR = 92   // 10 px gap
const OUTER_OR = 114  // 22 px thick

// Clockwise from 12 o'clock.  endAngle = startAngle - 360 avoids Recharts'
// full-circle degenerate bug while still closing the ring exactly.
const START_ANGLE =  90
const END_ANGLE   = -270

const UNCATEGORIZED_COLOR = '#64748b'
const TRANSPARENT         = 'transparent'

// ─── helpers ─────────────────────────────────────────────────────────────────

function groupColor(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  const tint = (v: number) =>
    Math.round(v * 0.6 + 255 * 0.4).toString(16).padStart(2, '0')
  return `#${tint(r)}${tint(g)}${tint(b)}`
}

/** Fallback only — groups without a stored color borrow a tint of their biggest category. */
function pickGroupColor(catIds: Set<string>, rows: SpendRow[]): string {
  let best: SpendRow | undefined
  for (const row of rows) {
    if (catIds.has(row.category.id)) {
      if (!best || row.total > best.total) best = row
    }
  }
  return best ? groupColor(best.category.color) : '#94a3b8'
}

// ─── active shape ────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function ActiveShape(props: any): ReactElement {
  const { cx, cy, innerRadius, outerRadius, startAngle, endAngle, fill } = props
  if (!fill || fill === TRANSPARENT) return <></>
  return (
    <Sector
      cx={cx} cy={cy}
      innerRadius={innerRadius - 3}
      outerRadius={outerRadius + 4}
      startAngle={startAngle}
      endAngle={endAngle}
      fill={fill}
    />
  )
}

// ─── slice shape types ───────────────────────────────────────────────────────

interface InnerSlice {
  name: string
  value: number
  color: string
  id: string
}

interface OuterSlice {
  name: string
  value: number
  color: string   // transparent for placeholder
  id: string
  isPlaceholder: boolean
}

// ─── component ───────────────────────────────────────────────────────────────

export function SpendDonutChart({ spendRows, groups, totalSpend, className }: Props) {
  const [activeInner, setActiveInner] = useState<number | undefined>()
  const [activeOuter, setActiveOuter] = useState<number | undefined>()

  const total = totalSpend ?? spendRows.reduce((s, r) => s + r.total, 0)
  const rows  = useMemo(() => spendRows.filter((r) => r.total > 0), [spendRows])

  // group_id → rows sorted by spend desc
  const groupMap = useMemo(() => {
    const m = new Map<string, SpendRow[]>()
    for (const r of rows) {
      const gid = r.category.group_id ?? '__none__'
      const arr = m.get(gid) ?? []
      arr.push(r)
      m.set(gid, arr)
    }
    for (const arr of m.values()) arr.sort((a, b) => b.total - a.total)
    return m
  }, [rows])

  const { innerData, outerData, legendSections } = useMemo(() => {
    const categorizedTotal   = rows.reduce((s, r) => s + r.total, 0)
    const uncategorizedTotal = Math.max(0, total - categorizedTotal)

    // Groups sorted by aggregate spend desc
    const sortedGroups = [...groups]
      .filter((g) => groupMap.has(g.id))
      .sort((a, b) => {
        const sa = (groupMap.get(a.id) ?? []).reduce((s, r) => s + r.total, 0)
        const sb = (groupMap.get(b.id) ?? []).reduce((s, r) => s + r.total, 0)
        return sb - sa
      })

    const inner: InnerSlice[] = []
    const outer: OuterSlice[] = []

    type LegendSection = {
      groupName: string | null
      groupColor: string | null
      groupTotal: number
      rows: Array<{ id: string; name: string; color: string; total: number }>
      isUncategorized?: boolean
    }
    const sections: LegendSection[] = []

    // ── Grouped categories ────────────────────────────────────────────────
    for (const g of sortedGroups) {
      const catRows    = groupMap.get(g.id) ?? []
      const groupTotal = catRows.reduce((s, r) => s + r.total, 0)
      const catIds     = new Set(catRows.map((r) => r.category.id))
      const gColor     = g.color ?? pickGroupColor(catIds, rows)

      // Outer: one arc for the whole group
      outer.push({ name: g.name, value: groupTotal, color: gColor, id: g.id, isPlaceholder: false })

      // Inner: one slice per category in this group
      for (const r of catRows) {
        inner.push({ name: r.category.name, value: r.total, color: r.category.color, id: r.category.id })
      }

      sections.push({
        groupName: g.name, groupColor: gColor, groupTotal,
        rows: catRows.map((r) => ({ id: r.category.id, name: r.category.name, color: r.category.color, total: r.total })),
      })
    }

    // ── Ungrouped categories ──────────────────────────────────────────────
    const ungrouped      = groupMap.get('__none__') ?? []
    const ungroupedTotal = ungrouped.reduce((s, r) => s + r.total, 0)

    for (const r of ungrouped) {
      inner.push({ name: r.category.name, value: r.total, color: r.category.color, id: r.category.id })
    }
    if (ungrouped.length > 0) {
      sections.push({
        groupName: null, groupColor: null, groupTotal: ungroupedTotal,
        rows: ungrouped.map((r) => ({ id: r.category.id, name: r.category.name, color: r.category.color, total: r.total })),
      })
    }

    // ── Uncategorized slice ───────────────────────────────────────────────
    if (uncategorizedTotal > 0) {
      inner.push({ name: 'Uncategorized', value: uncategorizedTotal, color: UNCATEGORIZED_COLOR, id: '__uncategorized__' })
      sections.push({
        groupName: 'Uncategorized', groupColor: UNCATEGORIZED_COLOR,
        groupTotal: uncategorizedTotal,
        rows: [{ id: '__uncategorized__', name: 'Uncategorized', color: UNCATEGORIZED_COLOR, total: uncategorizedTotal }],
        isUncategorized: true,
      })
    }

    // ── Outer placeholder for ungrouped + uncategorized ───────────────────
    // This keeps the outer ring's total identical to the inner ring's total
    // so both arcs span the same angle range and stay aligned.
    const placeholderValue = ungroupedTotal + uncategorizedTotal
    if (placeholderValue > 0) {
      outer.push({
        name: '', value: placeholderValue,
        color: TRANSPARENT, id: '__placeholder__', isPlaceholder: true,
      })
    }

    return { innerData: inner, outerData: outer, legendSections: sections }
  }, [groups, groupMap, rows, total])

  if (rows.length === 0 && total === 0) {
    return (
      <div className={cn('flex items-center justify-center py-8', className)}>
        <p className="text-sm text-muted-foreground">No spend data for this month</p>
      </div>
    )
  }

  const strokeColor = 'hsl(var(--surface-container))'

  return (
    <div className={cn('flex flex-col gap-6 sm:flex-row sm:items-start', className)}>

      {/* ── Chart (fixed size — avoids ResponsiveContainer 360° bug) ── */}
      <div
        className="flex-shrink-0 self-center"
        style={{ width: CHART_SIZE, height: CHART_SIZE }}
      >
        <PieChart width={CHART_SIZE} height={CHART_SIZE}>
          {/* Inner ring — categories */}
          <Pie
            data={innerData}
            cx={CX} cy={CY}
            innerRadius={INNER_IR} outerRadius={INNER_OR}
            dataKey="value"
            startAngle={START_ANGLE} endAngle={END_ANGLE}
            cornerRadius={4}
            activeIndex={activeInner}
            activeShape={ActiveShape}
            onMouseEnter={(_, idx) => setActiveInner(idx)}
            onMouseLeave={() => setActiveInner(undefined)}
            isAnimationActive animationDuration={600} animationEasing="ease-out"
          >
            {innerData.map((e) => (
              <Cell key={e.id} fill={e.color} stroke={strokeColor} strokeWidth={2} />
            ))}
          </Pie>

          {/* Outer ring — groups + transparent placeholder */}
          <Pie
            data={outerData}
            cx={CX} cy={CY}
            innerRadius={OUTER_IR} outerRadius={OUTER_OR}
            dataKey="value"
            startAngle={START_ANGLE} endAngle={END_ANGLE}
            cornerRadius={4}
            activeIndex={activeOuter}
            activeShape={ActiveShape}
            onMouseEnter={(_, idx) => { if (!outerData[idx]?.isPlaceholder) setActiveOuter(idx) }}
            onMouseLeave={() => setActiveOuter(undefined)}
            isAnimationActive animationDuration={600} animationEasing="ease-out"
          >
            {outerData.map((e) => (
              <Cell
                key={e.id}
                fill={e.color}
                stroke={e.isPlaceholder ? TRANSPARENT : strokeColor}
                strokeWidth={e.isPlaceholder ? 0 : 2}
                opacity={e.isPlaceholder ? 0 : 1}
              />
            ))}
          </Pie>

          <Tooltip
            contentStyle={{
              background: 'hsl(var(--surface-container))',
              border: '1px solid hsl(var(--outline-variant))',
              borderRadius: '10px',
              boxShadow: 'var(--shadow-overlay)',
              fontSize: 13,
              padding: '8px 12px',
              color: 'hsl(var(--foreground))',
            }}
            itemStyle={{ color: 'hsl(var(--foreground))' }}
            formatter={(value: number, name: string) =>
              name
                ? [`${formatCurrency(value)} · ${total > 0 ? ((value / total) * 100).toFixed(1) : 0}%`, name]
                : null
            }
          />
        </PieChart>
      </div>

      {/* ── Legend ── */}
      <div className="min-w-0 flex-1 overflow-y-auto max-h-[260px] space-y-3 pr-1">
        {legendSections.map((section, si) => (
          <div
            key={section.groupName ?? '__none__'}
            className={cn(si > 0 && 'pt-2 border-t border-outline-variant/30')}
          >
            {/* Group header */}
            <div className="mb-1 flex items-center gap-2 px-2">
              <span
                className={cn('h-2.5 w-2.5 flex-shrink-0', section.isUncategorized ? 'rounded-full' : 'rounded-sm')}
                style={{ background: section.groupColor ?? '#94a3b8' }}
              />
              <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {section.groupName ?? 'Other'}
              </span>
              <span className="ml-auto text-xs tabular-nums text-muted-foreground">
                {total > 0 ? ((section.groupTotal / total) * 100).toFixed(1) : 0}%
              </span>
            </div>

            {/* Category rows (skip for uncategorized — single item, shown in header) */}
            {!section.isUncategorized && section.rows.map((r) => {
              const pct = total > 0 ? (r.total / total) * 100 : 0
              return (
                <div
                  key={r.id}
                  className="flex items-center gap-2.5 rounded-md px-2 py-1 transition-colors hover:bg-surface-container"
                >
                  <span className="h-2.5 w-2.5 flex-shrink-0 rounded-full" style={{ background: r.color }} />
                  <span className="min-w-0 flex-1 truncate text-sm text-foreground">{r.name}</span>
                  <span className="flex-shrink-0 text-sm tabular-nums font-medium text-foreground">
                    {formatCurrency(r.total)}
                  </span>
                  <span className="w-10 flex-shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                    {pct.toFixed(1)}%
                  </span>
                </div>
              )
            })}

            {/* Uncategorized: amount + % on its own row */}
            {section.isUncategorized && (
              <div className="flex items-center gap-2.5 px-2 py-1">
                <span className="flex-1" />
                <span className="flex-shrink-0 text-sm tabular-nums font-medium text-foreground">
                  {formatCurrency(section.groupTotal)}
                </span>
                <span className="w-10 flex-shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                  {total > 0 ? ((section.groupTotal / total) * 100).toFixed(1) : 0}%
                </span>
              </div>
            )}
          </div>
        ))}
      </div>

    </div>
  )
}
