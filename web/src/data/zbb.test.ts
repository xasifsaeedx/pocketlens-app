import { describe, expect, it } from 'vitest'
import { monthRange } from './zbb'

// monthRange bounds the rollover-chain walk (and thus how many months of transactions
// fetchZbbMonth pulls). A wrong clamp silently produces wrong rollovers.
describe('monthRange', () => {
  it('spans start through end inclusive, ascending', () => {
    expect(monthRange(2026, 5, 2026, 7)).toEqual([
      { year: 2026, month: 5 },
      { year: 2026, month: 6 },
      { year: 2026, month: 7 },
    ])
  })

  it('crosses year boundaries', () => {
    expect(monthRange(2025, 11, 2026, 2)).toEqual([
      { year: 2025, month: 11 },
      { year: 2025, month: 12 },
      { year: 2026, month: 1 },
      { year: 2026, month: 2 },
    ])
  })

  it('collapses to just the viewed month when start is after end (blank/bad settings)', () => {
    expect(monthRange(2026, 9, 2026, 7)).toEqual([{ year: 2026, month: 7 }])
  })

  it('single month when start equals end', () => {
    expect(monthRange(2026, 7, 2026, 7)).toEqual([{ year: 2026, month: 7 }])
  })

  it('clamps a runaway span to the most recent 60 months ending at the viewed month', () => {
    const out = monthRange(2010, 1, 2026, 7)
    expect(out).toHaveLength(60)
    expect(out[0]).toEqual({ year: 2021, month: 8 })
    expect(out[out.length - 1]).toEqual({ year: 2026, month: 7 })
  })
})
