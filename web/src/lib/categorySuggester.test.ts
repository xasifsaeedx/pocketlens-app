import { describe, it, expect } from 'vitest'
import {
  autoMatch,
  describeRule,
  matchRule,
  resolveCategorization,
  ruleMatches,
  suggest,
} from './categorySuggester'
import type { Category, Transaction } from '@/types/domain'
import { makeRule } from '@/test/factories'

const names = ['Groceries', 'Dining', 'Rent', 'Utilities', 'Transport', 'Other', 'Income']
const categories: Category[] = names.map((name, i) => ({
  id: `cat-${name}`,
  name,
  color: '#000',
  icon: 'tag.fill',
  parent_id: null,
  sort_order: i,
  kind: name === 'Income' ? 'income' : 'spend',
}))
const cat = (n: string) => `cat-${n}`

function txn(p: Partial<Transaction>): Transaction {
  return {
    id: 'x', plaid_transaction_id: 'p', account_id: 'a',
    date: '2026-06-15', authorized_date: null, effective_date: '2026-06-15',
    amount: 10, merchant_name: null, description: null,
    plaid_category: null, plaid_category_detail: null, category_id: null,
    notes: null, pending: false, exclude_from_totals: false, ...p,
  }
}

describe('autoMatch precedence', () => {
  it('1. learned merchant memory wins over everything', () => {
    const t = txn({
      merchant_name: 'Starbucks',
      amount: -100, // would otherwise be Income by sign
      plaid_category_detail: 'FOOD_AND_DRINK_GROCERIES', // would otherwise be Groceries
    })
    const memory = { starbucks: cat('Dining') }
    expect(autoMatch(t, memory, [], categories)).toBe(cat('Dining'))
  })

  it('2. keyword rule matches, longest keyword first', () => {
    const t = txn({ merchant_name: 'Shell Gas Station' })
    const rules = [
      makeRule({ id: '1', keyword: 'gas', category_id: cat('Utilities') }),
      makeRule({ id: '2', keyword: 'shell gas', category_id: cat('Transport') }),
    ]
    expect(autoMatch(t, {}, rules, categories)).toBe(cat('Transport'))
  })

  it('3. income by sign when amount < 0', () => {
    const t = txn({ merchant_name: 'Acme Payroll', amount: -2650 })
    expect(autoMatch(t, {}, [], categories)).toBe(cat('Income'))
  })

  it('4. Plaid detailed PFC map', () => {
    const t = txn({ merchant_name: 'X', plaid_category_detail: 'TRANSPORTATION_GAS' })
    expect(autoMatch(t, {}, [], categories)).toBe(cat('Transport'))
  })

  it('5. Plaid primary PFC map (when no detail match)', () => {
    const t = txn({ merchant_name: 'X', plaid_category: 'RENT_AND_UTILITIES' })
    expect(autoMatch(t, {}, [], categories)).toBe(cat('Utilities'))
  })

  it('returns null when nothing matches', () => {
    const t = txn({ merchant_name: 'Mystery', amount: 20 })
    expect(autoMatch(t, {}, [], categories)).toBeNull()
  })
})

describe('suggest', () => {
  it('falls back to Other when no confident guess', () => {
    const t = txn({ merchant_name: 'Mystery', amount: 20 })
    expect(suggest(t, {}, [], categories)?.name).toBe('Other')
  })

  it('returns the matched category otherwise', () => {
    const t = txn({ merchant_name: 'X', plaid_category_detail: 'FOOD_AND_DRINK_COFFEE' })
    expect(suggest(t, {}, [], categories)?.name).toBe('Dining')
  })
})

// Conditional rules: direction + amount gating and the reimbursement action.
describe('ruleMatches conditions', () => {
  // The motivating rule: money IN + "Ved Rao" + amount > $1500 -> Rent + reimbursement.
  const vedRule = makeRule({
    keyword: 'Ved Rao',
    category_id: cat('Rent'),
    direction: 'in',
    min_amount: 1500,
    set_reimbursement: true,
  })

  it('legacy rule (all conditions null) matches on keyword alone — backward compatible', () => {
    const legacy = makeRule({ keyword: 'gas', category_id: cat('Transport') })
    expect(ruleMatches(legacy, txn({ merchant_name: 'Shell Gas', amount: 40 }))).toBe(true)
    expect(ruleMatches(legacy, txn({ merchant_name: 'Grocery', amount: 40 }))).toBe(false)
  })

  it('fires on money in above the threshold (rent share, amount < 0)', () => {
    expect(ruleMatches(vedRule, txn({ merchant_name: 'Ved Rao', amount: -1800 }))).toBe(true)
  })

  it('ignores a small money-in below the threshold', () => {
    expect(ruleMatches(vedRule, txn({ merchant_name: 'Ved Rao', amount: -22 }))).toBe(false)
  })

  it('respects direction: an outgoing payment of the same size does not match', () => {
    // amount > 0 is money out; direction is "in".
    expect(ruleMatches(vedRule, txn({ merchant_name: 'Ved Rao', amount: 1800 }))).toBe(false)
  })

  it('thresholds compare ABS(amount), not the signed value', () => {
    // |−1600| = 1600 ≥ 1500, even though the signed amount is well below 1500.
    expect(ruleMatches(vedRule, txn({ merchant_name: 'Ved Rao', amount: -1600 }))).toBe(true)
  })

  it('honors direction "out" (spend) and a max bound (between)', () => {
    const r = makeRule({ keyword: 'coffee', category_id: cat('Dining'), direction: 'out', min_amount: 5, max_amount: 10 })
    expect(ruleMatches(r, txn({ merchant_name: 'Coffee', amount: 7 }))).toBe(true)
    expect(ruleMatches(r, txn({ merchant_name: 'Coffee', amount: 12 }))).toBe(false) // over max
    expect(ruleMatches(r, txn({ merchant_name: 'Coffee', amount: -7 }))).toBe(false) // money in, not out
  })
})

describe('matchRule + resolveCategorization', () => {
  const vedRule = makeRule({
    keyword: 'Ved Rao',
    category_id: cat('Rent'),
    direction: 'in',
    min_amount: 1500,
    set_reimbursement: true,
  })

  it('resolves category + reimbursement for the motivating rent-share credit', () => {
    const t = txn({ merchant_name: 'Ved Rao', description: 'Zelle', amount: -1800 })
    expect(resolveCategorization(t, {}, [vedRule], categories)).toEqual({
      categoryId: cat('Rent'),
      setReimbursement: true,
    })
  })

  it('below the threshold: rule skipped, money-in falls back to Income, no reimbursement', () => {
    const t = txn({ merchant_name: 'Ved Rao', amount: -22 })
    expect(resolveCategorization(t, {}, [vedRule], categories)).toEqual({
      categoryId: cat('Income'),
      setReimbursement: false,
    })
  })

  it('longest-keyword still wins among condition-matching rules', () => {
    const t = txn({ merchant_name: 'Shell Gas Station', amount: 40 })
    const rules = [
      makeRule({ id: '1', keyword: 'gas', category_id: cat('Utilities') }),
      makeRule({ id: '2', keyword: 'shell gas', category_id: cat('Transport') }),
    ]
    expect(matchRule(t, rules)?.category_id).toBe(cat('Transport'))
  })

  it('a reimbursement-only rule (no category) flags without setting a category', () => {
    const r = makeRule({ keyword: 'refund', category_id: null, set_reimbursement: true })
    const t = txn({ merchant_name: 'Store Refund', amount: -50 })
    expect(resolveCategorization(t, {}, [r], categories)).toEqual({
      categoryId: cat('Income'), // no rule category → money-in ladder still applies
      setReimbursement: true,
    })
  })
})

describe('describeRule', () => {
  it('renders the full conditional rule human-readably', () => {
    const r = makeRule({
      keyword: 'Ved Rao',
      category_id: cat('Rent'),
      direction: 'in',
      min_amount: 1500,
      set_reimbursement: true,
    })
    expect(describeRule(r, 'Rent')).toBe('"Ved Rao" · money in · > $1,500 → Rent + reimbursement')
  })

  it('renders a plain legacy keyword rule', () => {
    const r = makeRule({ keyword: 'Whole Foods', category_id: cat('Groceries') })
    expect(describeRule(r, 'Groceries')).toBe('"Whole Foods" → Groceries')
  })

  it('renders a between-amount, reimbursement-only rule with no category', () => {
    const r = makeRule({
      keyword: 'refund',
      category_id: null,
      min_amount: 10,
      max_amount: 50,
      set_reimbursement: true,
    })
    expect(describeRule(r, null)).toBe('"refund" · $10–$50 → reimbursement')
  })
})
