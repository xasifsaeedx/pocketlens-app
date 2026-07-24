import { describe, it, expect } from 'vitest'
import { parseLocalDate, toISODate, monthBounds, dayKey, formatMonthLabel } from './dates'

describe('parseLocalDate', () => {
  it('parses a date-only string at LOCAL midnight (no UTC day shift)', () => {
    const d = parseLocalDate('2026-06-15')
    expect(d.getFullYear()).toBe(2026)
    expect(d.getMonth()).toBe(5) // June (0-indexed)
    expect(d.getDate()).toBe(15) // must not roll back to the 14th
    expect(d.getHours()).toBe(0)
  })

  it('round-trips through toISODate', () => {
    expect(toISODate(parseLocalDate('2026-01-01'))).toBe('2026-01-01')
    expect(toISODate(parseLocalDate('2026-12-31'))).toBe('2026-12-31')
  })

  it('parses full ISO timestamps too', () => {
    const d = parseLocalDate('2026-06-15T12:30:00Z')
    expect(d.getUTCFullYear()).toBe(2026)
  })
})

describe('monthBounds', () => {
  it('returns first and last day of the month', () => {
    expect(monthBounds(new Date(2026, 1, 10))).toEqual({
      start: '2026-02-01',
      end: '2026-02-28',
    })
  })

  it('handles a leap February', () => {
    expect(monthBounds(new Date(2028, 1, 5)).end).toBe('2028-02-29')
  })

  it('handles December (year does not roll)', () => {
    expect(monthBounds(new Date(2026, 11, 15))).toEqual({
      start: '2026-12-01',
      end: '2026-12-31',
    })
  })
})

describe('dayKey', () => {
  it('extracts yyyy-MM-dd from a date-only or timestamp string', () => {
    expect(dayKey('2026-06-15')).toBe('2026-06-15')
    expect(dayKey('2026-06-15T09:00:00Z')).toBe('2026-06-15')
  })
})

describe('formatMonthLabel', () => {
  it('formats a month + year', () => {
    expect(formatMonthLabel(new Date(2026, 6, 1))).toMatch(/July 2026/)
  })
})
