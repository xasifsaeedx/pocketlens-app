// Pure zero-sum (zero-based) budgeting math — no Supabase, no React.
// Unit-tested in zbb.test.ts. Model reference: migration 20260703025619_zbb.sql.
//
// SOURCE OF TRUTH ON LOAD: the zbb_month_overview Postgres RPC (migration
// 20260717123756) reproduces this exact math server-side and is what fetchZbbMonth
// renders from. This lib is kept for optimistic UI previews (canAssign, applyMoveMoney)
// and as the executable spec (zbb.test.ts) the RPC must keep matching.
//
// Per spend-category, for a month:
//   rollover  = strict:   prevAvailable
//               flexible: max(0, prevAvailable)
//   available = rollover + assigned - activity
// Month:
//   flexibleDeficit  = sum of -prevAvailable over categories where prevAvailable < 0 (flexible only)
//   ready_to_assign  = income - totalAssigned - flexibleDeficit
//
// ponytail: unassigned RTA does NOT carry to next month (each month starts from its own
// income + per-category rollovers). Upgrade path noted in the migration header.

export type RolloverMode = 'strict' | 'flexible'

export type ZbbRow = {
  category_id: string
  assigned: number
  activity: number
  rollover: number
  available: number
}

export type ZbbMonthOverview = {
  rows: ZbbRow[]
  total_assigned: number
  ready_to_assign: number
}

export type ComputeInput = {
  income: number
  categoryIds: string[]
  assignments: Record<string, number> // category_id -> assigned
  activity: Record<string, number> // category_id -> spent this month (positive outflow)
  prevAvailable: Record<string, number> // category_id -> available at end of previous month
  mode: RolloverMode
  isBeforeStart?: boolean // month precedes budget_start → everything zeroed
}

const EPS = 1e-6
const round2 = (n: number) => Math.round(n * 100) / 100

export function rolloverFor(prevAvailable: number, mode: RolloverMode): number {
  return mode === 'strict' ? prevAvailable : Math.max(0, prevAvailable)
}

export function computeMonthOverview(input: ComputeInput): ZbbMonthOverview {
  const { income, categoryIds, assignments, activity, prevAvailable, mode, isBeforeStart } = input

  if (isBeforeStart) {
    return {
      rows: categoryIds.map((id) => ({
        category_id: id, assigned: 0, activity: 0, rollover: 0, available: 0,
      })),
      total_assigned: 0,
      ready_to_assign: 0,
    }
  }

  let totalAssigned = 0
  let flexibleDeficit = 0
  const rows: ZbbRow[] = categoryIds.map((id) => {
    const prev = prevAvailable[id] ?? 0
    const rollover = rolloverFor(prev, mode)
    if (mode === 'flexible' && prev < 0) flexibleDeficit += -prev
    const assigned = assignments[id] ?? 0
    const act = activity[id] ?? 0
    totalAssigned += assigned
    return {
      category_id: id,
      assigned: round2(assigned),
      activity: round2(act),
      rollover: round2(rollover),
      available: round2(rollover + assigned - act),
    }
  })

  return {
    rows,
    total_assigned: round2(totalAssigned),
    ready_to_assign: round2(income - totalAssigned - flexibleDeficit),
  }
}

// Would setting `newAssigned` on `categoryId` keep Ready-to-Assign non-negative?
export function canAssign(input: ComputeInput, categoryId: string, newAssigned: number): boolean {
  const next = computeMonthOverview({
    ...input,
    assignments: { ...input.assignments, [categoryId]: newAssigned },
  })
  return next.ready_to_assign >= -EPS
}

export type MonthInput = {
  year: number
  month: number
  income: number
  assignments: Record<string, number>
  activity: Record<string, number>
}

// Walk months ascending (budget_start … viewed), feeding each month's end-of-month category
// availables in as the next month's rollover. Returns the overview for the LAST month in the list.
// This is the correct multi-month rollover: a balance parked in a category three months ago still
// shows up today.
export function computeChain(
  months: MonthInput[],
  categoryIds: string[],
  mode: RolloverMode,
): ZbbMonthOverview {
  let prevAvailable: Record<string, number> = {}
  let overview: ZbbMonthOverview = { rows: [], total_assigned: 0, ready_to_assign: 0 }
  for (const m of months) {
    overview = computeMonthOverview({
      income: m.income,
      categoryIds,
      assignments: m.assignments,
      activity: m.activity,
      prevAvailable,
      mode,
    })
    prevAvailable = Object.fromEntries(overview.rows.map((r) => [r.category_id, r.available]))
  }
  return overview
}

// Client-side optimistic move-money (mirrors the zbb_move_money RPC guards). Total assigned
// is conserved: dollars leave `from` and land in `to`.
export function applyMoveMoney(
  assignments: Record<string, number>,
  from: string,
  to: string,
  amount: number,
): Record<string, number> {
  if (from === to) throw new Error('from and to categories must differ')
  if (amount <= 0) throw new Error('amount must be positive')
  return {
    ...assignments,
    [from]: round2((assignments[from] ?? 0) - amount),
    [to]: round2((assignments[to] ?? 0) + amount),
  }
}
