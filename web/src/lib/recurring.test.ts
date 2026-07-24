import { describe, expect, it } from 'vitest'
import { detectRecurringSeries } from './recurring'
import { makeTxn } from '@/test/factories'

// Build a series of `n` charges for `merchant`, `amount`, starting `startISO`, every `gap` days.
function seriesOf(merchant: string, amount: number, startISO: string, gap: number, n: number) {
  const out = []
  const start = new Date(startISO + 'T00:00:00')
  for (let i = 0; i < n; i++) {
    const d = new Date(start)
    d.setDate(d.getDate() + i * gap)
    const iso = d.toISOString().slice(0, 10)
    out.push(makeTxn({ id: `${merchant}-${i}`, merchant_name: merchant, amount, effective_date: iso }))
  }
  return out
}

describe('detectRecurringSeries', () => {
  it('detects a monthly subscription', () => {
    const s = detectRecurringSeries(seriesOf('Netflix', 15.99, '2026-01-05', 30, 4))
    expect(s).toHaveLength(1)
    expect(s[0].cadence).toBe('monthly')
    expect(s[0].count).toBe(4)
    expect(s[0].displayName).toBe('Netflix')
    // next expected = last date + 30 days
    expect(s[0].nextExpected > s[0].lastDate).toBe(true)
  })

  it('detects weekly and yearly cadences', () => {
    expect(detectRecurringSeries(seriesOf('Gym', 20, '2026-01-01', 7, 5))[0].cadence).toBe('weekly')
    expect(detectRecurringSeries(seriesOf('Domain', 12, '2020-01-01', 365, 3))[0].cadence).toBe('yearly')
  })

  it('ignores fewer than 3 occurrences', () => {
    expect(detectRecurringSeries(seriesOf('Once', 9.99, '2026-01-01', 30, 2))).toHaveLength(0)
  })

  it('ignores irregular cadence', () => {
    const t = [
      makeTxn({ id: 'a', merchant_name: 'Random', amount: 10, effective_date: '2026-01-01' }),
      makeTxn({ id: 'b', merchant_name: 'Random', amount: 10, effective_date: '2026-01-04' }),
      makeTxn({ id: 'c', merchant_name: 'Random', amount: 10, effective_date: '2026-03-20' }),
    ]
    expect(detectRecurringSeries(t)).toHaveLength(0)
  })

  it('ignores inconsistent amounts (variable spend, not a subscription)', () => {
    const t = [
      makeTxn({ id: 'a', merchant_name: 'Grocer', amount: 20, effective_date: '2026-01-01' }),
      makeTxn({ id: 'b', merchant_name: 'Grocer', amount: 85, effective_date: '2026-01-31' }),
      makeTxn({ id: 'c', merchant_name: 'Grocer', amount: 140, effective_date: '2026-03-02' }),
    ]
    expect(detectRecurringSeries(t)).toHaveLength(0)
  })

  it('ignores income/inflows (amount < 0)', () => {
    expect(detectRecurringSeries(seriesOf('Payroll', -2000, '2026-01-01', 14, 4))).toHaveLength(0)
  })

  it('sorts multiple series by soonest next-expected', () => {
    const a = seriesOf('App', 5, '2026-01-01', 30, 3) // last ~2026-03-02
    const b = seriesOf('Bpp', 5, '2026-02-01', 7, 4) // last ~2026-02-22, next sooner
    const s = detectRecurringSeries([...a, ...b])
    expect(s.map((x) => x.displayName)).toEqual(['Bpp', 'App'])
  })
})
