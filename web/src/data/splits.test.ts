import { describe, expect, it } from 'vitest'
import { evaluateSplit, type SplitLeg } from './splits'
import type { UUID } from '@/types/domain'

const A = 'cat-a' as UUID
const B = 'cat-b' as UUID
const C = 'cat-c' as UUID

const leg = (category_id: UUID | '', amount: number): SplitLeg => ({ category_id, amount })

describe('evaluateSplit', () => {
  it('accepts distinct same-sign legs that sum to the txn amount', () => {
    const r = evaluateSplit(100, [leg(A, 70), leg(B, 30)])
    expect(r.canSave).toBe(true)
    expect(r.remainder).toBeCloseTo(0)
    expect(r.error).toBeNull()
  })

  it('rejects an opposite-sign leg even when the sum balances (the category_spend overcount bug)', () => {
    // {+120, -20} sums to +100 but the -20 leg is dropped by category_spend (amount > 0),
    // so spend would be counted as 120. Must not be savable.
    const r = evaluateSplit(100, [leg(A, 120), leg(B, -20)])
    expect(r.canSave).toBe(false)
    expect(r.error).toMatch(/same sign/i)
  })

  it('handles income (negative) txns: all legs must be negative', () => {
    expect(evaluateSplit(-100, [leg(A, -60), leg(B, -40)]).canSave).toBe(true)
    expect(evaluateSplit(-100, [leg(A, -140), leg(B, 40)]).canSave).toBe(false)
  })

  it('rejects duplicate categories', () => {
    const r = evaluateSplit(100, [leg(A, 50), leg(A, 50)])
    expect(r.canSave).toBe(false)
    expect(r.error).toMatch(/different category/i)
  })

  it('is not savable until the remainder is within a cent', () => {
    expect(evaluateSplit(100, [leg(A, 70), leg(B, 20)]).canSave).toBe(false) // remainder 10
    expect(evaluateSplit(100, [leg(A, 70), leg(B, 29.999)]).canSave).toBe(true) // within EPS
  })

  it('requires at least two complete legs (no empty category / zero amount)', () => {
    expect(evaluateSplit(100, [leg(A, 100)]).canSave).toBe(false)
    expect(evaluateSplit(100, [leg(A, 100), leg('', 0)]).canSave).toBe(false)
    expect(evaluateSplit(100, [leg(A, 100), leg(B, 0)]).canSave).toBe(false)
  })

  it('reports the running remainder regardless of validity', () => {
    expect(evaluateSplit(100, [leg(A, 70), leg(B, 10)]).remainder).toBeCloseTo(20)
  })

  it('supports three-way distinct splits', () => {
    expect(evaluateSplit(90, [leg(A, 30), leg(B, 30), leg(C, 30)]).canSave).toBe(true)
  })
})
