import { describe, it, expect } from 'vitest'
import { escapeCsvField, rowsToCsv, transactionsToCsv } from './exportCsv'
import type { Transaction, UUID } from '@/types/domain'

describe('escapeCsvField', () => {
  it('passes plain values through unchanged', () => {
    expect(escapeCsvField('Coffee')).toBe('Coffee')
  })
  it('quotes and doubles quotes when the value has a comma, quote, or newline', () => {
    expect(escapeCsvField('Smith, John')).toBe('"Smith, John"')
    expect(escapeCsvField('he said "hi"')).toBe('"he said ""hi"""')
    expect(escapeCsvField('line1\nline2')).toBe('"line1\nline2"')
    expect(escapeCsvField('a\r\nb')).toBe('"a\r\nb"')
  })
})

describe('rowsToCsv', () => {
  it('joins header + rows with CRLF and escapes each cell', () => {
    const csv = rowsToCsv(['A', 'B'], [['x', 'y,z'], [1, 2]])
    expect(csv).toBe('A,B\r\nx,"y,z"\r\n1,2')
  })
})

function txn(over: Partial<Transaction>): Transaction {
  return {
    id: 'id' as UUID,
    account_id: 'acc1' as UUID,
    effective_date: '2026-07-01',
    amount: 0,
    merchant_name: null,
    description: null,
    categories: null,
    notes: null,
    ...over,
  } as Transaction
}

describe('transactionsToCsv', () => {
  const accounts = new Map<UUID, { name: string }>([['acc1' as UUID, { name: 'Checking' }]])

  it('writes a header row + one line per txn with spend-negative amounts', () => {
    const rows = [
      txn({
        effective_date: '2026-07-01',
        amount: 45, // DB spend -> file shows -45.00
        merchant_name: 'Coffee',
        categories: { name: 'Dining' } as Transaction['categories'],
      }),
      txn({
        effective_date: '2026-07-02',
        amount: -1200, // DB income -> file shows +1200.00
        merchant_name: 'Paycheck',
      }),
    ]
    const csv = transactionsToCsv(rows, accounts)
    expect(csv).toBe(
      [
        'Date,Merchant,Category,Amount,Account,Notes',
        '2026-07-01,Coffee,Dining,-45.00,Checking,',
        '2026-07-02,Paycheck,,1200.00,Checking,',
      ].join('\r\n'),
    )
  })

  it('escapes merchant/notes with commas or quotes and falls back to description', () => {
    const csv = transactionsToCsv([
      txn({
        amount: 10,
        merchant_name: null,
        description: 'Amazon, Inc',
        notes: 'said "ok"',
      }),
    ])
    expect(csv).toBe(
      'Date,Merchant,Category,Amount,Account,Notes\r\n2026-07-01,"Amazon, Inc",,-10.00,,"said ""ok"""',
    )
  })
})
