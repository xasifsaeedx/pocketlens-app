import { describe, it, expect } from 'vitest'
import {
  displayName,
  merchantKey,
  merchantLocation,
  isForeignCurrency,
  isLiabilityType,
  isReimbursement,
  sumIncome,
  sumNetSpend,
  txnTags,
  hasSplits,
  type Transaction,
} from './domain'

function txn(partial: Partial<Transaction>): Transaction {
  return {
    id: 'x',
    plaid_transaction_id: 'p',
    account_id: 'a',
    date: '2026-06-15',
    authorized_date: null,
    effective_date: '2026-06-15',
    amount: 10,
    merchant_name: null,
    description: null,
    plaid_category: null,
    plaid_category_detail: null,
    category_id: null,
    notes: null,
    pending: false,
    exclude_from_totals: false,
    transfer_group_id: null,
    transfer_kind: null,
    transfer_opt_out: false,
    hidden: false,
    is_reimbursement: false,
    merchant_city: null,
    merchant_region: null,
    merchant_country: null,
    merchant_postal_code: null,
    merchant_store_number: null,
    merchant_lat: null,
    merchant_lon: null,
    iso_currency_code: null,
    ...partial,
  }
}

// Spend-per-category now lives in the `category_spend` Postgres view (netting rules
// tested in finance-backend .../test_integration.py::test_category_spend_*), not a
// client function — so only the split-detection predicate is unit-tested here.
describe('hasSplits', () => {
  it('detects a transaction with splits', () => {
    const split = txn({
      amount: 30,
      category_id: null,
      transaction_splits: [
        { id: 's1', transaction_id: 'x', category_id: 'groceries', amount: 20 },
        { id: 's2', transaction_id: 'x', category_id: 'household', amount: 10 },
      ],
    })
    expect(hasSplits(split)).toBe(true)
    expect(hasSplits(txn({ amount: 30, category_id: 'groceries' }))).toBe(false)
  })
})

describe('reimbursements — contra-expense totals', () => {
  // Rent $3000 (spend), roommate Zelle -$1500 flagged as a reimbursement for Rent,
  // plus a $2000 paycheck. Matches the contract's worked example.
  const rent = txn({ id: 'rent', amount: 3000, category_id: 'rent' })
  const zelle = txn({ id: 'zelle', amount: -1500, category_id: 'rent', is_reimbursement: true })
  const paycheck = txn({ id: 'pay', amount: -2000, category_id: 'inc' })

  it('isReimbursement flags the reimbursement row only', () => {
    expect(isReimbursement(zelle)).toBe(true)
    expect(isReimbursement(rent)).toBe(false)
    expect(isReimbursement(paycheck)).toBe(false)
  })

  it('income excludes reimbursements (the Zelle is NOT income)', () => {
    expect(sumIncome([rent, zelle, paycheck])).toBe(2000) // only the paycheck
  })

  it('net spend = positive spend − reimbursements (Rent nets to 1500)', () => {
    expect(sumNetSpend([rent, zelle, paycheck])).toBe(1500) // 3000 − 1500
  })

  it('net spend can go negative when over-reimbursed (do not clamp)', () => {
    const overpay = txn({ id: 'over', amount: -500, category_id: 'rent', is_reimbursement: true })
    expect(sumNetSpend([txn({ amount: 100 }), overpay])).toBe(-400)
  })
})

describe('income excludes inter-account transfer legs', () => {
  // A $6000 Chase→Wealthfront self-deposit lands as a TRANSFER_IN credit — your own
  // money moving, not earnings. It must not count as income.
  const paycheck = txn({ id: 'pay', amount: -3928.6, plaid_category: 'INCOME' })
  const selfDeposit = txn({ id: 'xfer', amount: -6000, plaid_category: 'TRANSFER_IN' })

  it('drops TRANSFER_IN / TRANSFER_OUT / LOAN_PAYMENTS credits from income', () => {
    expect(sumIncome([paycheck, selfDeposit])).toBe(3928.6) // paycheck only, not the $6k
    expect(sumIncome([txn({ amount: -500, plaid_category: 'TRANSFER_OUT' })])).toBe(0)
    expect(sumIncome([txn({ amount: -800, plaid_category: 'LOAN_PAYMENTS' })])).toBe(0)
  })

  it('keeps legacy null-category credits as income (pre-migration paychecks)', () => {
    expect(sumIncome([txn({ amount: -2650, plaid_category: null })])).toBe(2650)
  })

  it('a transfer-tagged debit is still spend (only the income side is filtered)', () => {
    // Venmo/ATM-as-spend policy: TRANSFER_OUT with amount > 0 stays in net spend.
    expect(sumNetSpend([txn({ amount: 28, plaid_category: 'TRANSFER_OUT' })])).toBe(28)
  })
})

describe('displayName', () => {
  it('prefers merchant_name, then description, then Unknown', () => {
    expect(displayName(txn({ merchant_name: 'Whole Foods' }))).toBe('Whole Foods')
    expect(displayName(txn({ description: 'ACH DEBIT' }))).toBe('ACH DEBIT')
    expect(displayName(txn({}))).toBe('Unknown')
  })
})

describe('txnTags', () => {
  const tag = { id: 't1', name: 'Work', color: '#007AFF' }
  it('flattens embedded transaction_tags into Tag[]', () => {
    expect(txnTags(txn({ transaction_tags: [{ tag_id: 't1', tags: tag }] }))).toEqual([tag])
  })
  it('drops null joins and handles missing relation', () => {
    expect(txnTags(txn({ transaction_tags: [{ tag_id: 't1', tags: null }] }))).toEqual([])
    expect(txnTags(txn({}))).toEqual([])
  })
})

describe('merchantKey', () => {
  it('lowercases and trims (must match iOS/backend key)', () => {
    expect(merchantKey(txn({ merchant_name: '  Whole Foods  ' }))).toBe('whole foods')
  })
  it('falls back to description', () => {
    expect(merchantKey(txn({ merchant_name: null, description: 'VENMO' }))).toBe('venmo')
  })
  it('is empty when nothing identifies the merchant', () => {
    expect(merchantKey(txn({}))).toBe('')
  })
})

describe('merchantLocation', () => {
  it('joins city + region when present', () => {
    expect(merchantLocation(txn({ merchant_city: 'Paris', merchant_region: 'IDF' }))).toBe('Paris, IDF')
  })
  it('uses whichever part resolved', () => {
    expect(merchantLocation(txn({ merchant_city: 'Paris', merchant_region: null }))).toBe('Paris')
    expect(merchantLocation(txn({ merchant_city: null, merchant_region: 'CA' }))).toBe('CA')
  })
  it('is null when Plaid resolved no location', () => {
    expect(merchantLocation(txn({}))).toBeNull()
  })
})

describe('isForeignCurrency', () => {
  it('is false for USD or missing currency', () => {
    expect(isForeignCurrency(txn({ iso_currency_code: 'USD' }))).toBe(false)
    expect(isForeignCurrency(txn({ iso_currency_code: null }))).toBe(false)
  })
  it('is true for a non-USD settled currency', () => {
    expect(isForeignCurrency(txn({ iso_currency_code: 'EUR' }))).toBe(true)
  })
})

describe('isLiabilityType', () => {
  it('treats credit and loan as liabilities', () => {
    expect(isLiabilityType('credit')).toBe(true)
    expect(isLiabilityType('loan')).toBe(true)
    expect(isLiabilityType('depository')).toBe(false)
    expect(isLiabilityType('investment')).toBe(false)
  })
})
