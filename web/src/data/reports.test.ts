import { describe, expect, it } from 'vitest'
import {
  buildCategoryRows,
  buildComparison,
  buildReport,
  buildTagRows,
  computeMetrics,
} from './reports'
import { makeCategory, makeTxn } from '@/test/factories'
import type { Category, Transaction } from '@/types/domain'

// Category tree: Food (parent) → Groceries, Dining; plus an income-kind category.
const food = makeCategory({ id: 'food', name: 'Food', kind: 'spend' })
const groceries = makeCategory({ id: 'groc', name: 'Groceries', kind: 'spend', parent_id: 'food' })
const dining = makeCategory({ id: 'din', name: 'Dining', kind: 'spend', parent_id: 'food' })
const income = makeCategory({ id: 'inc', name: 'Income', kind: 'income' })
const cats: Category[] = [food, groceries, dining, income]
const catById = new Map(cats.map((c) => [c.id, c]))

function txn(p: Partial<Transaction>): Transaction {
  return makeTxn(p)
}

describe('computeMetrics', () => {
  const txns: Transaction[] = [
    txn({ id: 't1', amount: 100, category_id: 'groc', effective_date: '2026-07-03' }),
    txn({ id: 't2', amount: 50, category_id: 'din', effective_date: '2026-07-05' }),
    txn({ id: 't3', amount: -2000, category_id: 'inc', effective_date: '2026-07-01' }),
    txn({ id: 't4', amount: 30, category_id: null, effective_date: '2026-07-08' }), // uncategorized spend still counts
  ]

  it('sums positive amounts as spend and credit magnitudes as income (iOS parity)', () => {
    const m = computeMetrics(txns)
    expect(m.totalSpending).toBe(180) // 100 + 50 + 30 (positive amounts)
    expect(m.totalIncome).toBe(2000) // |−2000| credit
    expect(m.transactionCount).toBe(4) // all counted rows
  })

  it('avg transaction = mean amount over spending (positive) txns only', () => {
    const m = computeMetrics(txns)
    expect(m.avgTransactionAmount).toBeCloseTo((100 + 50 + 30) / 3) // 60 — income row excluded from the mean
  })

  it('savings rate = (income − spending) / income', () => {
    const m = computeMetrics(txns)
    expect(m.savingsRatePct).toBeCloseTo(((2000 - 180) / 2000) * 100) // 91.0
  })

  it('savings rate is null with no income', () => {
    const m = computeMetrics([txn({ amount: 40, category_id: 'groc' })])
    expect(m.savingsRatePct).toBeNull()
  })

  it('nets reimbursements out of income and spend (contra-expense)', () => {
    const withReimb: Transaction[] = [
      txn({ id: 'rent', amount: 3000, category_id: 'groc' }),
      txn({ id: 'zelle', amount: -1500, category_id: 'groc', is_reimbursement: true }),
      txn({ id: 'pay', amount: -2000, category_id: 'inc' }),
    ]
    const m = computeMetrics(withReimb)
    expect(m.totalSpending).toBe(1500) // 3000 − 1500 reimbursement
    expect(m.totalIncome).toBe(2000) // paycheck only; the Zelle is not income
    expect(m.avgTransactionAmount).toBe(3000) // avg over gross positive-spend txns (just Rent)
    expect(m.savingsRatePct).toBeCloseTo(((2000 - 1500) / 2000) * 100) // 25%
  })

  it('drops exclude_from_totals rows and counts the whole transaction amount', () => {
    const spend = txn({ id: 'spend', amount: 90, category_id: 'groc' })
    const excluded = txn({ id: 'x', amount: 500, category_id: 'groc', exclude_from_totals: true })
    const m = computeMetrics([spend, excluded])
    expect(m.totalSpending).toBe(90) // excluded (transfer/hidden) row ignored
    expect(m.transactionCount).toBe(1)
  })
})

describe('buildCategoryRows', () => {
  it('rolls leaves up to the top-level parent for byCategory and keeps leaves for bySubcategory', () => {
    const spend = [
      { category: groceries, total: 100 },
      { category: dining, total: 50 },
    ]
    const { byCategory, bySubcategory } = buildCategoryRows(spend, catById)

    expect(byCategory).toHaveLength(1)
    expect(byCategory[0]).toMatchObject({ category: 'Food', category_id: 'food', total: -150 })

    expect(bySubcategory).toHaveLength(2)
    expect(bySubcategory).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ category: 'Food', subcategory: 'Groceries', category_id: 'food', total: -100 }),
        expect.objectContaining({ category: 'Food', subcategory: 'Dining', category_id: 'food', total: -50 }),
      ]),
    )
  })

  it('negates totals so the outflow pie plots them, and skips income categories', () => {
    const spend = [
      { category: food, total: 100 }, // top-level → itself
      { category: income, total: 25 }, // an income category should never enter the spend pie
    ]
    const { byCategory } = buildCategoryRows(spend, catById)
    expect(byCategory).toHaveLength(1)
    expect(byCategory[0].total).toBeLessThan(0)
    expect(byCategory[0].category).toBe('Food')
  })
})

describe('buildTagRows', () => {
  it('sums net spend per tag (negated for the outflow pie), ignoring untagged/income rows', () => {
    const coffee = { id: 'tg', name: 'Coffee', color: '#000' }
    const txns: Transaction[] = [
      txn({ id: 'a', amount: 100, category_id: 'groc', transaction_tags: [{ tag_id: 'tg', tags: coffee }] }),
      txn({ id: 'b', amount: 40, category_id: 'din' }), // untagged → skipped
      txn({ id: 'c', amount: -500, category_id: 'inc', transaction_tags: [{ tag_id: 'tg', tags: coffee }] }), // income → no spend
    ]
    const rows = buildTagRows(txns)
    expect(rows).toEqual([{ total: -100, percent: 0, tag: 'Coffee' }])
  })
})

describe('buildComparison', () => {
  const now = new Date(2026, 6, 15) // 15 July 2026 → current month is in-progress
  const thisTxns = [txn({ id: 'j3', amount: 100, category_id: 'groc', effective_date: '2026-07-03' })]
  const prevTxns = [txn({ id: 'jun10', amount: 60, category_id: 'groc', effective_date: '2026-06-10' })]

  it('caps the current month at today and runs the prior month to its last calendar day', () => {
    const points = buildComparison(thisTxns, prevTxns, 2026, 7, now)
    expect(points).toHaveLength(30) // June has 30 days; July capped at 15 → max = 30

    const day3 = points.find((p) => p.day_of_month === 3)!
    expect(day3.this_month).toBe(100) // cumulative includes the July 3 spend

    const day15 = points.find((p) => p.day_of_month === 15)!
    expect(day15.this_month).toBe(100) // carried flat to today

    const day16 = points.find((p) => p.day_of_month === 16)!
    expect(day16.this_month).toBeNull() // past today → no this-month line

    const day10 = points.find((p) => p.day_of_month === 10)!
    expect(day10.last_month).toBe(60)
    const day30 = points.find((p) => p.day_of_month === 30)!
    expect(day30.last_month).toBe(60) // prior month runs full length
  })
})

describe('buildReport', () => {
  it('assembles metrics + comparison + breakdowns and derives the prior month', () => {
    const report = buildReport({
      year: 2026,
      month: 1, // January → prior month rolls back a year
      thisTxns: [txn({ id: 't1', amount: 100, category_id: 'groc', effective_date: '2026-01-04' })],
      prevTxns: [],
      spend: [{ category: groceries, total: 100 }],
      categories: cats,
      now: new Date(2026, 0, 20),
    })
    expect(report.prevMonthYear).toBe(2025)
    expect(report.prevMonth).toBe(12)
    expect(report.totalSpending).toBe(100)
    expect(report.byCategory[0]).toMatchObject({ category: 'Food', total: -100 }) // rolled up to parent
    expect(report.cumulativeComparison.length).toBeGreaterThan(0)
  })
})
