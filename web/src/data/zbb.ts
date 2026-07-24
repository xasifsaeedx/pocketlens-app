// Zero-sum (zero-based) budgeting data layer. Mirrors PocketLens/Services/ZbbService.swift.
// Persistence only — the month overview (rollover chain + RTA) is computed server-side by
// the zbb_month_overview RPC (migration 20260717123756); @/lib/zbb keeps the pure mirror
// for optimistic UI previews.

import { supabase } from '@/lib/supabase'
import type { UUID, ZbbSettings } from '@/types/domain'
import type { RolloverMode, ZbbMonthOverview, ZbbRow } from '@/lib/zbb'

const DEFAULT_SETTINGS: ZbbSettings = {
  enabled: false,
  rollover_mode: 'strict',
  monthly_income: 0,
  budget_start_year: null,
  budget_start_month: null,
}

// Cap the rollover walk so a stray budget_start far in the past can't fan out into hundreds of
// months. ~5 years is plenty; older history rarely affects today's availables. The
// zbb_month_overview RPC applies the same 60-month clamp server-side.
const MAX_CHAIN_MONTHS = 60

export async function fetchZbbSettings(): Promise<ZbbSettings> {
  const { data, error } = await supabase.from('zbb_settings').select('*').maybeSingle()
  if (error) throw error
  return (data as ZbbSettings) ?? { ...DEFAULT_SETTINGS }
}

export async function saveZbbSettings(patch: Partial<ZbbSettings>): Promise<ZbbSettings> {
  const next = { ...(await fetchZbbSettings()), ...patch }
  const { data, error } = await supabase
    .from('zbb_settings')
    .upsert(
      {
        enabled: next.enabled,
        rollover_mode: next.rollover_mode,
        monthly_income: next.monthly_income,
        budget_start_year: next.budget_start_year,
        budget_start_month: next.budget_start_month,
      },
      { onConflict: 'user_id' },
    )
    .select()
    .single()
  if (error) throw error
  return data as ZbbSettings
}

export type ZbbMonthResult = {
  settings: ZbbSettings
  overview: ZbbMonthOverview
  /** Assigned amounts for the viewed month, keyed by category — drives the assign inputs. */
  assignments: Record<UUID, number>
}

/** Shape of the zbb_month_overview RPC's jsonb result (migration 20260717123756). */
type ZbbMonthRpcResult = {
  settings: {
    enabled: boolean
    rollover_mode: RolloverMode
    monthly_income: number
    budget_start_year: number | null
    budget_start_month: number | null
  }
  income: number
  rows: ZbbRow[]
  total_assigned: number
  ready_to_assign: number
  assignments: Record<UUID, number>
}

/** Viewed-month overview (rollover chain + Ready-to-Assign), computed server-side by the
 *  zbb_month_overview RPC in ONE round trip. The RPC walks the chain from budget_start
 *  (bounded to MAX_CHAIN_MONTHS) with activity from the category_spend view — the previous
 *  client-side walk fired one spend query per chain month. */
export async function fetchZbbMonth(year: number, month: number): Promise<ZbbMonthResult> {
  const { data, error } = await supabase.rpc('zbb_month_overview', {
    p_year: year,
    p_month: month,
  })
  if (error) throw error
  const r = data as ZbbMonthRpcResult

  return {
    settings: r.settings,
    overview: {
      rows: r.rows,
      total_assigned: r.total_assigned,
      ready_to_assign: r.ready_to_assign,
    },
    assignments: r.assignments,
  }
}

export async function setAssignment(
  categoryId: UUID,
  year: number,
  month: number,
  assigned: number,
): Promise<void> {
  const { error } = await supabase
    .from('zbb_assignments')
    .upsert(
      { category_id: categoryId, year, month, assigned },
      { onConflict: 'user_id,category_id,year,month' },
    )
  if (error) throw error
}

/** Atomic assign-shift between two categories (Postgres RPC — see migration 20260703025619). */
export async function moveMoney(
  year: number,
  month: number,
  from: UUID,
  to: UUID,
  amount: number,
): Promise<void> {
  const { error } = await supabase.rpc('zbb_move_money', {
    p_year: year,
    p_month: month,
    p_from: from,
    p_to: to,
    p_amount: amount,
  })
  if (error) throw error
}

const idx = (y: number, m: number) => y * 12 + (m - 1) // absolute month index

/** Ascending {year, month} list from (sy,sm) through (ey,em) inclusive. If the start is after the
 *  end (blank/bad settings) it collapses to just the viewed month; if the span exceeds
 *  MAX_CHAIN_MONTHS it keeps the most recent window ending at the viewed month.
 *  No longer called on the load path (the zbb_month_overview RPC clamps server-side with the
 *  same semantics) — kept, with its tests, as the executable spec of that clamp. */
export function monthRange(sy: number, sm: number, ey: number, em: number): { year: number; month: number }[] {
  const end = idx(ey, em)
  const start = Math.min(Math.max(idx(sy, sm), end - (MAX_CHAIN_MONTHS - 1)), end)
  const out: { year: number; month: number }[] = []
  for (let i = start; i <= end; i++) out.push({ year: Math.floor(i / 12), month: (i % 12) + 1 })
  return out
}
