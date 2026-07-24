// resolveLimit / resolveLimits — the effective-dated as-of rule (the shared source of truth
// behind the Budgets page's per-month limits and the Dashboard's safe-to-spend). Pure, so no
// Supabase mocking is needed.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { deleteBudget, resolveLimit, resolveLimits, saveBudget } from './budgets'
import { toISODate } from '@/lib/dates'
import type { BudgetLimit } from '@/types/domain'

// ── Mocks for the write-path tests. The pure resolver tests below don't touch these. ──
// Rows fetchBudgetLimits() returns; each test seeds this to control the as-of prior limit.
let fetchRows: BudgetLimit[] = []
// The last upsert payload written to budget_limits (what saveBudget/deleteBudget persist).
let lastUpsert: { effective_month: string; monthly_limit: number } | null = null

vi.mock('@/lib/supabase', () => {
  const makeBuilder = () => {
    const b: Record<string, unknown> = {
      select: () => b,
      order: () => Promise.resolve({ data: fetchRows, error: null }),
      single: () => Promise.resolve({ data: { id: 'new-id' }, error: null }),
      upsert: (payload: { effective_month: string; monthly_limit: number }) => {
        lastUpsert = payload
        return b
      },
      insert: () => Promise.resolve({ error: null }),
      // deleteBudget awaits the upsert(...) builder directly (no .select().single()).
      then: (resolve: (v: { data: null; error: null }) => unknown) =>
        resolve({ data: null, error: null }),
    }
    return b
  }
  return { supabase: { from: () => makeBuilder() } }
})

// Spy on the activity log builders to assert the captured prior limit (resolved as-of target).
const logSetBudget = vi.fn()
const logDeleteBudget = vi.fn()
vi.mock('./activity', () => ({
  logSetBudget: (...a: unknown[]) => logSetBudget(...a),
  logDeleteBudget: (...a: unknown[]) => logDeleteBudget(...a),
}))

function row(category_id: string, effective_month: string, monthly_limit: number): BudgetLimit {
  return { id: `${category_id}-${effective_month}`, category_id, effective_month, monthly_limit }
}

// Food: 300 from Jan, raised to 500 from Apr. Rent: 1000 from Feb, unbudgeted (0) from May.
const rows: BudgetLimit[] = [
  row('food', '2026-01-01', 300),
  row('food', '2026-04-01', 500),
  row('rent', '2026-02-01', 1000),
  row('rent', '2026-05-01', 0),
]

// Mid-month Date so first-of-month normalization is exercised too.
const mid = (y: number, m: number) => new Date(y, m - 1, 15)

describe('resolveLimit — as-of rule', () => {
  it('picks the latest row on/before the month', () => {
    expect(resolveLimit(rows, 'food', mid(2026, 1))).toBe(300) // exactly at first row
    expect(resolveLimit(rows, 'food', mid(2026, 3))).toBe(300) // before the raise
    expect(resolveLimit(rows, 'food', mid(2026, 4))).toBe(500) // at the raise
    expect(resolveLimit(rows, 'food', mid(2026, 9))).toBe(500) // long after
  })

  it('returns 0 when no row is on/before the month', () => {
    expect(resolveLimit(rows, 'food', mid(2025, 12))).toBe(0) // before any food row
    expect(resolveLimit(rows, 'missing', mid(2026, 6))).toBe(0) // unknown category
  })

  it('honors the 0-sentinel: unbudgeted from its month while earlier months keep the prior limit', () => {
    expect(resolveLimit(rows, 'rent', mid(2026, 4))).toBe(1000) // before the sentinel
    expect(resolveLimit(rows, 'rent', mid(2026, 5))).toBe(0) // at the sentinel → unbudgeted
    expect(resolveLimit(rows, 'rent', mid(2026, 8))).toBe(0) // stays unbudgeted after
  })
})

describe('resolveLimits — as-of map', () => {
  it('resolves every category with a row on/before the month', () => {
    const m = resolveLimits(rows, mid(2026, 4))
    expect(m.get('food')).toBe(500)
    expect(m.get('rent')).toBe(1000)
  })

  it('reflects the 0-sentinel as a 0 entry (caller filters unbudgeted)', () => {
    const m = resolveLimits(rows, mid(2026, 5))
    expect(m.get('food')).toBe(500)
    expect(m.get('rent')).toBe(0)
    expect([...m.values()].filter((v) => v > 0)).toEqual([500])
  })

  it('omits categories with no row yet', () => {
    const m = resolveLimits(rows, mid(2026, 1))
    expect(m.get('food')).toBe(300)
    expect(m.has('rent')).toBe(false) // rent's first row is Feb
  })
})

// ── saveBudget / deleteBudget target-month behavior. ──
// Two past food rows so the as-of prior limit differs by target month: 100 from Jan 2020,
// raised to 300 from Jun 2020. Any month in 2020–today resolves 300; March 2020 resolves 100.
const priorRows: BudgetLimit[] = [
  row('food', '2020-01-01', 100),
  row('food', '2020-06-01', 300),
]
const currentMonthISO = toISODate(new Date(new Date().getFullYear(), new Date().getMonth(), 1))

beforeEach(() => {
  fetchRows = priorRows
  lastUpsert = null
  logSetBudget.mockClear()
  logDeleteBudget.mockClear()
})

describe('saveBudget — target month', () => {
  it('writes at an explicit month and logs the prior limit resolved as-of that month', async () => {
    await saveBudget('food', 500, { month: new Date(2020, 2, 1) }) // March 2020
    expect(lastUpsert).toEqual({ category_id: 'food', effective_month: '2020-03-01', monthly_limit: 500 })
    // Prior (arg index 2) is the as-of-March limit (100), not today's (300).
    expect(logSetBudget).toHaveBeenCalledWith('new-id', 'food', 100, 500)
  })

  it('defaults to the current month when no month is given', async () => {
    await saveBudget('food', 500)
    expect(lastUpsert?.effective_month).toBe(currentMonthISO)
    expect(logSetBudget).toHaveBeenCalledWith('new-id', 'food', 300, 500) // as-of today = 300
  })

  it('skips logging (and its prior-limit fetch) on the undo path', async () => {
    await saveBudget('food', 500, { log: false, month: new Date(2020, 2, 1) })
    expect(lastUpsert?.effective_month).toBe('2020-03-01')
    expect(logSetBudget).not.toHaveBeenCalled()
  })
})

describe('deleteBudget — target month', () => {
  it('writes a 0 sentinel at an explicit month and logs the as-of prior limit', async () => {
    await deleteBudget('food', { month: new Date(2020, 2, 1) }) // March 2020
    expect(lastUpsert).toEqual({ category_id: 'food', effective_month: '2020-03-01', monthly_limit: 0 })
    expect(logDeleteBudget).toHaveBeenCalledWith('food', 100) // as-of March = 100
  })

  it('defaults to the current month when no month is given', async () => {
    await deleteBudget('food')
    expect(lastUpsert).toEqual({ category_id: 'food', effective_month: currentMonthISO, monthly_limit: 0 })
    expect(logDeleteBudget).toHaveBeenCalledWith('food', 300) // as-of today = 300
  })
})
