import { applyMoveMoney, canAssign, computeChain, computeMonthOverview, rolloverFor } from './zbb'
import type { ComputeInput, MonthInput } from './zbb'

// Base: two spend categories, $1000 income, nothing rolled in.
function base(over: Partial<ComputeInput> = {}): ComputeInput {
  return {
    income: 1000,
    categoryIds: ['food', 'rent'],
    assignments: {},
    activity: {},
    prevAvailable: {},
    mode: 'strict',
    ...over,
  }
}

describe('rolloverFor', () => {
  it('strict carries the full previous available (incl. negatives)', () => {
    expect(rolloverFor(50, 'strict')).toBe(50)
    expect(rolloverFor(-30, 'strict')).toBe(-30)
  })
  it('flexible carries only positive available', () => {
    expect(rolloverFor(50, 'flexible')).toBe(50)
    expect(rolloverFor(-30, 'flexible')).toBe(0)
  })
})

describe('computeMonthOverview — single month', () => {
  it('assigning all income drives Ready-to-Assign to 0', () => {
    const o = computeMonthOverview(base({ assignments: { food: 600, rent: 400 } }))
    expect(o.total_assigned).toBe(1000)
    expect(o.ready_to_assign).toBe(0)
  })

  it('partial assignment leaves the remainder in RTA', () => {
    const o = computeMonthOverview(base({ assignments: { food: 600 } }))
    expect(o.ready_to_assign).toBe(400)
  })

  it('activity reduces a category available; RTA is unaffected by spending', () => {
    const o = computeMonthOverview(base({ assignments: { food: 300 }, activity: { food: 120 } }))
    const food = o.rows.find((r) => r.category_id === 'food')!
    expect(food.available).toBe(180)
    expect(o.ready_to_assign).toBe(700) // 1000 - 300
  })
})

describe('computeMonthOverview — rollover', () => {
  it('strict: positive prev available rolls into the category', () => {
    const o = computeMonthOverview(base({ prevAvailable: { food: 50 }, assignments: { food: 100 } }))
    const food = o.rows.find((r) => r.category_id === 'food')!
    expect(food.rollover).toBe(50)
    expect(food.available).toBe(150) // 50 + 100 - 0
    expect(o.ready_to_assign).toBe(900) // negatives/positives in categories don't touch RTA in strict
  })

  it('strict: negative prev available is carried inside the category, not against RTA', () => {
    const o = computeMonthOverview(base({ prevAvailable: { food: -30 }, assignments: { food: 100 } }))
    const food = o.rows.find((r) => r.category_id === 'food')!
    expect(food.rollover).toBe(-30)
    expect(food.available).toBe(70) // -30 + 100
    expect(o.ready_to_assign).toBe(900) // 1000 - 100, no deficit in strict
  })

  it('flexible: negative prev available zeroes the category rollover and subtracts from RTA', () => {
    const o = computeMonthOverview(
      base({ mode: 'flexible', prevAvailable: { food: -30 }, assignments: { food: 100 } }),
    )
    const food = o.rows.find((r) => r.category_id === 'food')!
    expect(food.rollover).toBe(0)
    expect(food.available).toBe(100)
    expect(o.ready_to_assign).toBe(870) // 1000 - 100 assigned - 30 flexible deficit
  })

  it('flexible: positive prev available behaves like strict', () => {
    const o = computeMonthOverview(base({ mode: 'flexible', prevAvailable: { food: 50 } }))
    const food = o.rows.find((r) => r.category_id === 'food')!
    expect(food.rollover).toBe(50)
    expect(o.ready_to_assign).toBe(1000)
  })
})

describe('computeMonthOverview — before budget start', () => {
  it('zeroes assigned, activity, rollover, available and RTA', () => {
    const o = computeMonthOverview(
      base({ isBeforeStart: true, assignments: { food: 600 }, activity: { food: 100 }, prevAvailable: { food: 50 } }),
    )
    expect(o.ready_to_assign).toBe(0)
    expect(o.total_assigned).toBe(0)
    expect(o.rows.every((r) => r.assigned === 0 && r.activity === 0 && r.rollover === 0 && r.available === 0)).toBe(true)
  })
})

describe('canAssign', () => {
  it('allows assigning exactly up to income (RTA == 0)', () => {
    expect(canAssign(base({ assignments: { food: 400 } }), 'rent', 600)).toBe(true)
  })
  it('rejects assigning more than available (RTA would go negative)', () => {
    expect(canAssign(base({ assignments: { food: 400 } }), 'rent', 601)).toBe(false)
  })
  it('flexible deficit shrinks how much can be assigned', () => {
    // 1000 income, 30 deficit → only 970 assignable
    const input = base({ mode: 'flexible', prevAvailable: { food: -30 } })
    expect(canAssign(input, 'rent', 970)).toBe(true)
    expect(canAssign(input, 'rent', 971)).toBe(false)
  })
})

describe('computeChain — multi-month rollover', () => {
  const cats = ['food', 'rent']
  function m(year: number, month: number, over: Partial<MonthInput> = {}): MonthInput {
    return { year, month, income: 1000, assignments: {}, activity: {}, ...over }
  }

  it('returns the overview for the last month in the chain', () => {
    const o = computeChain([m(2026, 6), m(2026, 7, { assignments: { food: 200 } })], cats, 'strict')
    expect(o.ready_to_assign).toBe(800) // last month: 1000 - 200
  })

  it('strict: an unspent balance parked two months ago still rolls into today', () => {
    // Jun: assign 300 to food, spend 100 → available 200 carries forward.
    // Jul: assign/spend nothing → food available stays 200.
    const o = computeChain(
      [m(2026, 6, { assignments: { food: 300 }, activity: { food: 100 } }), m(2026, 7)],
      cats,
      'strict',
    )
    expect(o.rows.find((r) => r.category_id === 'food')!.rollover).toBe(200)
    expect(o.rows.find((r) => r.category_id === 'food')!.available).toBe(200)
  })

  it('flexible: a prior overspend surfaces as a deficit against the later RTA', () => {
    // Jun: assign 100 to food, spend 130 → available -30. Flexible zeroes the category rollover
    // and charges the 30 against Jul RTA.
    const o = computeChain(
      [m(2026, 6, { assignments: { food: 100 }, activity: { food: 130 } }), m(2026, 7)],
      cats,
      'flexible',
    )
    expect(o.rows.find((r) => r.category_id === 'food')!.rollover).toBe(0)
    expect(o.ready_to_assign).toBe(970) // 1000 - 0 assigned - 30 deficit
  })

  it('empty chain yields a zeroed overview', () => {
    const o = computeChain([], cats, 'strict')
    expect(o.ready_to_assign).toBe(0)
    expect(o.rows).toEqual([])
  })
})

describe('applyMoveMoney', () => {
  it('conserves total assigned (dollars move between categories)', () => {
    const next = applyMoveMoney({ food: 100, rent: 50 }, 'food', 'rent', 40)
    expect(next.food).toBe(60)
    expect(next.rent).toBe(90)
    expect(next.food + next.rent).toBe(150)
  })
  it('creates the destination if it had no assignment yet', () => {
    const next = applyMoveMoney({ food: 100 }, 'food', 'rent', 40)
    expect(next.rent).toBe(40)
  })
  it('rejects same-category and non-positive amounts', () => {
    expect(() => applyMoveMoney({ food: 100 }, 'food', 'food', 10)).toThrow()
    expect(() => applyMoveMoney({ food: 100 }, 'food', 'rent', 0)).toThrow()
    expect(() => applyMoveMoney({ food: 100 }, 'food', 'rent', -5)).toThrow()
  })
})
