import { describe, expect, it } from 'vitest'
import {
  cumulativeNetCashflow,
  cumulativeSpend,
  incomeMTD,
  netCashflowMTD,
  netSpendMTD,
  pendingCharges,
  scheduledTotal,
} from './dashboard'
import { makeTxn } from '@/test/factories'

describe('dashboard derivations', () => {
  it('sums income as the magnitude of credit rows (amount < 0)', () => {
    const txns = [
      makeTxn({ id: 'a', amount: -2000 }), // paycheck
      makeTxn({ id: 'b', amount: -50 }), // refund
      makeTxn({ id: 'c', amount: 42 }), // spend, ignored
    ]
    expect(incomeMTD(txns)).toBe(2050)
  })

  it('excludes reimbursements from income and nets them out of spend', () => {
    const txns = [
      makeTxn({ id: 'rent', amount: 3000, category_id: 'rent' }),
      makeTxn({ id: 'zelle', amount: -1500, category_id: 'rent', is_reimbursement: true }),
      makeTxn({ id: 'pay', amount: -2000 }),
    ]
    expect(incomeMTD(txns)).toBe(2000) // the reimbursement is not income
    expect(netSpendMTD(txns)).toBe(1500) // 3000 spend − 1500 reimbursement
  })

  it('excludes exclude_from_totals rows from income', () => {
    const txns = [
      makeTxn({ id: 'a', amount: -1000 }),
      makeTxn({ id: 'b', amount: -500, exclude_from_totals: true }),
    ]
    expect(incomeMTD(txns)).toBe(1000)
  })

  it('scheduled = Σ pending outflows; pendingCharges lists them newest-first', () => {
    const txns = [
      makeTxn({ id: 'p1', amount: 30, pending: true, effective_date: '2026-07-01' }),
      makeTxn({ id: 'p2', amount: 70, pending: true, effective_date: '2026-07-03' }),
      makeTxn({ id: 'inflow', amount: -20, pending: true }), // pending credit, ignored
      makeTxn({ id: 'cleared', amount: 99, pending: false }), // not pending, ignored
    ]
    expect(scheduledTotal(txns)).toBe(100)
    expect(pendingCharges(txns).map((t) => t.id)).toEqual(['p2', 'p1'])
  })

  it('builds a running cumulative net-cashflow series, oldest first (income rises)', () => {
    const txns = [
      makeTxn({ id: 'd1', amount: 100, effective_date: '2026-07-01' }), // spend
      makeTxn({ id: 'd2a', amount: 40, effective_date: '2026-07-02' }), // spend
      makeTxn({ id: 'd2b', amount: -240, effective_date: '2026-07-02' }), // income same day
    ]
    // day1: running spend 100 -> value -100
    // day2: +40 spend -240 income => net -200; cumulative running -100 => value +100
    expect(cumulativeNetCashflow(txns)).toEqual([
      { date: '2026-07-01', value: -100 },
      { date: '2026-07-02', value: 100 },
    ])
  })

  it('produces no sparkline points from an empty month', () => {
    expect(cumulativeNetCashflow([])).toEqual([])
  })

  it('excludes an inter-account transfer deposit from net cashflow + sparkline', () => {
    // $6000 Chase→Wealthfront self-deposit (TRANSFER_IN) alongside a real paycheck.
    const txns = [
      makeTxn({ id: 'pay', amount: -2000, effective_date: '2026-07-01' }),
      makeTxn({
        id: 'xfer',
        amount: -6000,
        plaid_category: 'TRANSFER_IN',
        effective_date: '2026-07-02',
      }),
      makeTxn({ id: 'coffee', amount: 10, effective_date: '2026-07-03' }),
    ]
    expect(incomeMTD(txns)).toBe(2000) // paycheck only — the $6k transfer is not income
    expect(netCashflowMTD(txns)).toBe(1990) // 2000 income − 10 spend, no $6k lift
    // Sparkline never spikes on the transfer day; only the paycheck lifts it.
    expect(cumulativeNetCashflow(txns)).toEqual([
      { date: '2026-07-01', value: 2000 },
      { date: '2026-07-03', value: 1990 },
    ])
  })

  it('nets a same-day reimbursed charge out of net cashflow', () => {
    // Rent charged in full to a credit card, reimbursed by an auto-payment same day —
    // the charge should not read as $3,147.96 of real spend with no offset.
    const txns = [
      makeTxn({ id: 'rent', amount: 3147.96, category_id: 'rent', effective_date: '2026-07-02' }),
      makeTxn({
        id: 'rent-reimbursement',
        amount: -3147.96,
        category_id: 'rent',
        is_reimbursement: true,
        effective_date: '2026-07-03',
      }),
      makeTxn({ id: 'coffee', amount: 10, effective_date: '2026-07-04' }),
      makeTxn({ id: 'paycheck', amount: -2901.5, effective_date: '2026-07-01' }),
    ]
    expect(netSpendMTD(txns)).toBe(10) // rent nets to 0, only the coffee remains
    expect(netCashflowMTD(txns)).toBeCloseTo(2891.5) // income 2901.50 − net spend 10
  })

  it('nets a reimbursement into the cumulative spend line on the day it posts', () => {
    const txns = [
      makeTxn({ id: 'rent', amount: 3147.96, effective_date: '2026-07-02' }),
      makeTxn({
        id: 'rent-reimbursement',
        amount: -3147.96,
        is_reimbursement: true,
        effective_date: '2026-07-03',
      }),
      makeTxn({ id: 'coffee', amount: 10, effective_date: '2026-07-04' }),
    ]
    const points = cumulativeSpend(txns)
    expect(points).toEqual([
      { day: 2, total: 3147.96 },
      { day: 3, total: 0 },
      { day: 4, total: 10 },
    ])
  })
})
