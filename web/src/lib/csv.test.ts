import { describe, it, expect } from 'vitest'
import { parseCsv, parseAmount, parseDate, guessColumn } from './csv'

describe('parseCsv', () => {
  it('parses headers + rows', () => {
    const { headers, rows } = parseCsv('Date,Amount,Merchant\n2026-01-02,-4.50,Coffee')
    expect(headers).toEqual(['Date', 'Amount', 'Merchant'])
    expect(rows).toEqual([['2026-01-02', '-4.50', 'Coffee']])
  })

  it('handles quoted fields with embedded commas and quotes', () => {
    const { rows } = parseCsv('a,b\n"Smith, John","he said ""hi"""')
    expect(rows[0]).toEqual(['Smith, John', 'he said "hi"'])
  })

  it('handles embedded newlines inside quotes', () => {
    const { rows } = parseCsv('a,b\n"line1\nline2",x')
    expect(rows[0]).toEqual(['line1\nline2', 'x'])
  })

  it('handles CRLF and a trailing newline and a BOM', () => {
    const { headers, rows } = parseCsv('﻿Date,Amount\r\n2026-01-02,5\r\n')
    expect(headers).toEqual(['Date', 'Amount'])
    expect(rows).toEqual([['2026-01-02', '5']])
  })

  it('pads ragged rows to header width', () => {
    const { rows } = parseCsv('a,b,c\n1,2')
    expect(rows[0]).toEqual(['1', '2', ''])
  })

  it('returns empty for empty input', () => {
    expect(parseCsv('')).toEqual({ headers: [], rows: [] })
  })
})

describe('parseAmount', () => {
  it('parses plain and signed numbers', () => {
    expect(parseAmount('45.00')).toBe(45)
    expect(parseAmount('-45.00')).toBe(-45)
    expect(parseAmount('+45')).toBe(45)
  })
  it('strips currency symbols and thousands separators', () => {
    expect(parseAmount('$1,234.56')).toBe(1234.56)
    expect(parseAmount('  £2,000 ')).toBe(2000)
  })
  it('treats parentheses as negative', () => {
    expect(parseAmount('(12.34)')).toBe(-12.34)
  })
  it('returns NaN for non-numeric', () => {
    expect(parseAmount('')).toBeNaN()
    expect(parseAmount('abc')).toBeNaN()
    expect(parseAmount('--5')).toBeNaN()
  })
})

describe('parseDate', () => {
  it('accepts ISO', () => {
    expect(parseDate('2026-01-02')).toBe('2026-01-02')
    expect(parseDate('2026/1/2')).toBe('2026-01-02')
  })
  it('accepts US M/d/yyyy and 2-digit years', () => {
    expect(parseDate('1/2/2026')).toBe('2026-01-02')
    expect(parseDate('01/02/26')).toBe('2026-01-02')
  })
  it('resolves d/m when the first part cannot be a month', () => {
    expect(parseDate('31/01/2026')).toBe('2026-01-31')
  })
  it('rejects garbage and out-of-range', () => {
    expect(parseDate('')).toBeNull()
    expect(parseDate('not a date')).toBeNull()
    expect(parseDate('13/45/2026')).toBeNull()
  })
})

describe('guessColumn', () => {
  it('matches common header names', () => {
    const headers = ['Transaction Date', 'Description', 'Amount']
    expect(guessColumn(headers, 'date')).toBe('Transaction Date')
    expect(guessColumn(headers, 'amount')).toBe('Amount')
    expect(guessColumn(headers, 'merchant')).toBe('Description')
  })
  it('returns empty when nothing matches', () => {
    expect(guessColumn(['x', 'y'], 'date')).toBe('')
  })
})
