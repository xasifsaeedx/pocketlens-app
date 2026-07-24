import { beforeEach, describe, it, expect, vi } from 'vitest'
import {
  autoCategorizeUncategorized,
  excludeAfterHiddenChange,
  fetchUncategorized,
} from './transactions'
import { resolveCategorization } from '@/lib/categorySuggester'
import { makeTxn } from '@/test/factories'
import type { Transaction, TransactionSplit } from '@/types/domain'

describe('excludeAfterHiddenChange', () => {
  it('hiding always excludes', () => {
    expect(excludeAfterHiddenChange(makeTxn(), true)).toBe(true)
    expect(excludeAfterHiddenChange(makeTxn({ transfer_group_id: 'g-1' }), true)).toBe(true)
  })

  it('unhiding re-includes a plain txn', () => {
    expect(excludeAfterHiddenChange(makeTxn({ hidden: true }), false)).toBe(false)
  })

  it('unhiding keeps a transfer leg excluded', () => {
    expect(
      excludeAfterHiddenChange(makeTxn({ hidden: true, transfer_group_id: 'g-1' }), false),
    ).toBe(true)
  })
})

// ── fetchUncategorized: the split-parent exclusion. ──
// A split txn has a null category_id, so the DB query (is category_id null) surfaces it, but it's
// already categorized via its splits — confirming it in the queue would re-learn merchant memory
// from a non-spend parent. The client-side !hasSplits filter drops it, mirroring iOS.
let queryRows: Transaction[] = []
let filterCalls: Array<{ fn: string; col: string; val: string }> = []
let memoryRows: Array<{ merchant_key: string; category_id: string }> = []
let updateCalls: Array<{ categoryId: unknown; isReimbursement: unknown; ids: string[] }> = []
vi.mock('@/lib/supabase', () => {
  const record = (fn: string) => (col: string, val: string) => {
    filterCalls.push({ fn, col, val })
    return txns
  }
  const txns: Record<string, unknown> = {
    select: () => txns,
    is: () => txns,
    eq: () => txns,
    gte: record('gte'),
    lte: record('lte'),
    order: () => Promise.resolve({ data: queryRows, error: null }),
    update: (patch: { category_id?: unknown; is_reimbursement?: unknown }) => ({
      in: (_col: string, ids: string[]) => {
        updateCalls.push({
          categoryId: patch.category_id,
          isReimbursement: patch.is_reimbursement,
          ids,
        })
        return Promise.resolve({ error: null })
      },
    }),
  }
  const merchantCategories = {
    select: () => Promise.resolve({ data: memoryRows, error: null }),
  }
  return {
    supabase: {
      from: (table: string) => (table === 'merchant_categories' ? merchantCategories : txns),
    },
  }
})

// fetchRules/fetchCategories are irrelevant to the batching logic — autoMatch is stubbed.
vi.mock('./categories', () => ({
  fetchRules: () => Promise.resolve([]),
  fetchCategories: () => Promise.resolve([]),
}))
vi.mock('@/lib/categorySuggester', () => ({ resolveCategorization: vi.fn() }))

// Convenience: the shape resolveCategorization returns.
const resolved = (categoryId: string | null, setReimbursement = false) => ({
  categoryId,
  setReimbursement,
})

const split = (p: Partial<TransactionSplit> = {}): TransactionSplit => ({
  id: 's-1',
  transaction_id: 't-split',
  category_id: 'cat-1',
  amount: 21.25,
  ...p,
})

describe('fetchUncategorized — split parents excluded', () => {
  beforeEach(() => {
    queryRows = []
  })

  it('drops a split parent (null category_id but has splits) and keeps a plain uncategorized txn', async () => {
    const plain = makeTxn({ id: 't-plain' })
    const splitParent = makeTxn({
      id: 't-split',
      transaction_splits: [split({ amount: 21.25 }), split({ id: 's-2', category_id: 'cat-2', amount: 21.25 })],
    })
    queryRows = [plain, splitParent]

    const result = await fetchUncategorized()

    expect(result.map((t) => t.id)).toEqual(['t-plain'])
  })

  it('keeps a txn with an empty splits array', async () => {
    queryRows = [makeTxn({ id: 't-plain', transaction_splits: [] })]
    const result = await fetchUncategorized()
    expect(result.map((t) => t.id)).toEqual(['t-plain'])
  })
})

// ── fetchUncategorized: month scoping. ──
// The banner/review queue must be scoped to the viewed month, not the entire all-time
// backlog (the #149 regression). The bulk flows (auto-categorize, retroactive same-merchant)
// still call with no month and must stay all-months.
describe('fetchUncategorized — month scoping', () => {
  beforeEach(() => {
    queryRows = []
    filterCalls = []
  })

  it('bounds effective_date to the calendar month when a month is passed', async () => {
    await fetchUncategorized(new Date(2026, 6, 15)) // July 2026 (local)
    const gte = filterCalls.find((c) => c.fn === 'gte' && c.col === 'effective_date')
    const lte = filterCalls.find((c) => c.fn === 'lte' && c.col === 'effective_date')
    expect(gte?.val).toBe('2026-07-01')
    expect(lte?.val).toBe('2026-07-31')
  })

  it('omits date bounds when no month is passed (all-months bulk flows)', async () => {
    await fetchUncategorized()
    expect(filterCalls.some((c) => c.fn === 'gte' || c.fn === 'lte')).toBe(false)
  })
})

// ── autoCategorizeUncategorized: batched writes. ──
// Matched txns are grouped by category and applied in one bulk `.in('id', …)` update per
// category (chunked to ≤200 ids), never one round-trip per txn. Only confident matches
// (autoMatch → non-null) are applied.
describe('autoCategorizeUncategorized — batched per-category writes', () => {
  beforeEach(() => {
    queryRows = []
    memoryRows = []
    updateCalls = []
    vi.mocked(resolveCategorization).mockReset()
  })

  it('issues one update per category, groups ids, skips unmatched, and counts applied', async () => {
    queryRows = [
      makeTxn({ id: 't-1' }),
      makeTxn({ id: 't-2' }),
      makeTxn({ id: 't-3' }),
      makeTxn({ id: 't-4' }), // unmatched → no write
    ]
    const catFor: Record<string, string | null> = {
      't-1': 'cat-A',
      't-2': 'cat-B',
      't-3': 'cat-A',
      't-4': null,
    }
    vi.mocked(resolveCategorization).mockImplementation((txn: Transaction) =>
      resolved(catFor[txn.id] ?? null),
    )

    const applied = await autoCategorizeUncategorized()

    expect(applied).toBe(3)
    // One update per category (two categories), not one per txn.
    expect(updateCalls).toHaveLength(2)
    const byCat = new Map(updateCalls.map((c) => [c.categoryId, c.ids]))
    expect(byCat.get('cat-A')).toEqual(['t-1', 't-3'])
    expect(byCat.get('cat-B')).toEqual(['t-2'])
    // The unmatched txn was never written.
    expect(updateCalls.flatMap((c) => c.ids)).not.toContain('t-4')
  })

  it('chunks a category with >200 matches into ≤200-id requests', async () => {
    queryRows = Array.from({ length: 250 }, (_, i) => makeTxn({ id: `t-${i}` }))
    vi.mocked(resolveCategorization).mockReturnValue(resolved('cat-A'))

    const applied = await autoCategorizeUncategorized()

    expect(applied).toBe(250)
    expect(updateCalls).toHaveLength(2)
    expect(updateCalls[0].ids).toHaveLength(200)
    expect(updateCalls[1].ids).toHaveLength(50)
    expect(updateCalls.every((c) => c.categoryId === 'cat-A')).toBe(true)
  })

  it('writes nothing when no txn matches', async () => {
    queryRows = [makeTxn({ id: 't-1' }), makeTxn({ id: 't-2' })]
    vi.mocked(resolveCategorization).mockReturnValue(resolved(null))

    const applied = await autoCategorizeUncategorized()

    expect(applied).toBe(0)
    expect(updateCalls).toHaveLength(0)
  })

  it('applies reimbursement in its own pass, and counts a reimbursed txn as handled', async () => {
    queryRows = [
      makeTxn({ id: 't-1' }), // Rent + reimbursement (the Ved Rao case)
      makeTxn({ id: 't-2' }), // plain category
    ]
    const map: Record<string, ReturnType<typeof resolved>> = {
      't-1': resolved('cat-rent', true),
      't-2': resolved('cat-dining', false),
    }
    vi.mocked(resolveCategorization).mockImplementation((txn: Transaction) => map[txn.id])

    const applied = await autoCategorizeUncategorized()

    expect(applied).toBe(2)
    // Two category updates + one reimbursement update.
    const reimb = updateCalls.filter((c) => c.isReimbursement === true)
    expect(reimb).toHaveLength(1)
    expect(reimb[0].ids).toEqual(['t-1'])
    const cats = updateCalls.filter((c) => c.categoryId != null)
    expect(new Map(cats.map((c) => [c.categoryId, c.ids])).get('cat-rent')).toEqual(['t-1'])
  })
})
