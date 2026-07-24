import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ZbbBudgetView from './ZbbBudgetView'
import { makeCategory } from '@/test/factories'

const assignMutate = vi.fn()
const moveMutate = vi.fn()
const toastError = vi.fn()

vi.mock('sonner', () => ({ toast: { error: (m: string) => toastError(m) } }))

// Overview: RTA = 200, Food already assigned 300 (activity 100 → available 200).
// Tests that need an overspent category swap in `overspentOverview` via the mutable holder.
const baseOverview = {
  ready_to_assign: 200,
  total_assigned: 300,
  rows: [
    { category_id: 'cat-food', assigned: 300, activity: 100, rollover: 0, available: 200 },
    { category_id: 'cat-rent', assigned: 0, activity: 0, rollover: 0, available: 0 },
  ],
}
// Rent overspent by 70 (assigned 50, spent 120).
const overspentOverview = {
  ready_to_assign: 150,
  total_assigned: 350,
  rows: [
    { category_id: 'cat-food', assigned: 300, activity: 100, rollover: 0, available: 200 },
    { category_id: 'cat-rent', assigned: 50, activity: 120, rollover: 0, available: -70 },
  ],
}
let overview = baseOverview

vi.mock('@/data/hooks', () => ({
  useCategories: () => ({
    data: [
      makeCategory({ id: 'cat-food', name: 'Food' }),
      makeCategory({ id: 'cat-rent', name: 'Rent' }),
    ],
  }),
  useZbbMonth: () => ({ data: { settings: {}, overview, assignments: { 'cat-food': 300 } } }),
  useSetZbbAssignment: () => ({ mutate: assignMutate }),
  useZbbMoveMoney: () => ({ mutate: moveMutate, isPending: false }),
}))

beforeEach(() => {
  overview = baseOverview
  assignMutate.mockClear()
  moveMutate.mockClear()
  toastError.mockClear()
})

describe('ZbbBudgetView', () => {
  it('renders Ready to Assign', () => {
    render(<ZbbBudgetView />)
    expect(screen.getByText('Ready to Assign')).toBeInTheDocument()
    expect(screen.getByText('$200.00')).toBeInTheDocument()
  })

  it('shows each spend category with its available balance', () => {
    render(<ZbbBudgetView />)
    expect(screen.getByText('Food')).toBeInTheDocument()
    expect(screen.getByText('Rent')).toBeInTheDocument()
    expect(screen.getByText(/\$200\.00 available/)).toBeInTheDocument()
  })

  it('commits an assignment that keeps Ready-to-Assign non-negative', async () => {
    const user = userEvent.setup()
    render(<ZbbBudgetView />)
    const input = screen.getByLabelText('Assign to Food')
    await user.clear(input)
    await user.type(input, '400') // +100 vs 300 → RTA 100, allowed
    await user.tab()
    expect(assignMutate).toHaveBeenCalledWith(
      expect.objectContaining({ categoryId: 'cat-food', assigned: 400 }),
    )
    expect(toastError).not.toHaveBeenCalled()
  })

  it('blocks an assignment that would overdraw Ready-to-Assign', async () => {
    const user = userEvent.setup()
    render(<ZbbBudgetView />)
    const input = screen.getByLabelText('Assign to Food')
    await user.clear(input)
    await user.type(input, '600') // +300 vs 300 → RTA -100, blocked
    await user.tab()
    expect(assignMutate).not.toHaveBeenCalled()
    expect(toastError).toHaveBeenCalled()
  })
})

// BACKLOG WEB-15: going over in a category must PROMPT the user to account for it by
// moving funds from another category — not just tint the number red.
describe('ZbbBudgetView — overspend prompt', () => {
  it('shows no prompt when nothing is overspent', () => {
    render(<ZbbBudgetView />)
    expect(screen.queryByText(/overspent/i)).not.toBeInTheDocument()
  })

  it('lists each overspent category with the amount to cover', () => {
    overview = overspentOverview
    render(<ZbbBudgetView />)
    expect(screen.getByText(/overspent/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /cover rent/i })).toBeInTheDocument()
    expect(screen.getByText('$70.00')).toBeInTheDocument() // the deficit, exact
  })

  it('Cover opens the move dialog prefilled with the overspent category and deficit', async () => {
    overview = overspentOverview
    const user = userEvent.setup()
    render(<ZbbBudgetView />)
    await user.click(screen.getByRole('button', { name: /cover rent/i }))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('Amount')).toHaveValue(70)
  })
})
