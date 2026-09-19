import { describe, it, expect } from 'vitest'
import { formatCurrency, formatAmount, isDebit, amountColorClass } from './money'

describe('money helpers', () => {
  it('formatCurrency keeps the sign', () => {
    expect(formatCurrency(1234.5)).toBe('$1,234.50')
    expect(formatCurrency(-42)).toBe('-$42.00')
  })

  it('formatCurrency shows a bare "$" for CAD and USD, never a locale prefix', () => {
    expect(formatCurrency(12.34, 'CAD')).toBe('$12.34')
    expect(formatCurrency(12.34, 'USD')).toBe('$12.34')
    expect(formatCurrency(-5, 'CAD')).toBe('-$5.00')
  })

  it('formatCurrency falls back to "n CODE" for an unknown code', () => {
    expect(formatCurrency(12.34, 'NOTREAL')).toBe('12.34 NOTREAL')
  })

  it('formatAmount shows magnitude only', () => {
    expect(formatAmount(65)).toBe('$65.00')
    expect(formatAmount(-65)).toBe('$65.00')
  })

  it('isDebit follows positive=spend convention', () => {
    expect(isDebit(2450)).toBe(true) // rent = money out
    expect(isDebit(-2650)).toBe(false) // payroll = money in
    expect(isDebit(0)).toBe(false)
  })

  it('amountColorClass maps spend->expense, income->income', () => {
    expect(amountColorClass(10)).toBe('text-money-expense')
    expect(amountColorClass(-10)).toBe('text-money-income')
  })
})
