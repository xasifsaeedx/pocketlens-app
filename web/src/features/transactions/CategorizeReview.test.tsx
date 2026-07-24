import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { CategorizeReview } from './CategorizeReview'
import { makeCategory, makeTxn } from '@/test/factories'

const mutate = vi.fn()

const categories = [
  makeCategory({ id: 'cat-g', name: 'Groceries' }),
  makeCategory({ id: 'cat-o', name: 'Other' }),
]

vi.mock('@/data/hooks', () => ({
  useCategories: () => ({ data: categories }),
  useMerchantMemory: () => ({ data: {} }),
  useRules: () => ({ data: [] }),
  useSetCategory: () => ({ mutate }),
  useSetHidden: () => ({ mutate: vi.fn() }),
  useSetReimbursement: () => ({ mutate: vi.fn() }),
  useUpsertCategory: () => ({ mutateAsync: vi.fn(), isPending: false }),
  // Pulled in by the CategoryPickerDialog + TxnTagEditor it renders.
  useAccountsWithBalance: () => ({ data: [] }),
  useTransferGroupLegs: () => ({ data: null }),
  useTags: () => ({ data: [] }),
  useToggleTransactionTag: () => ({ mutate: vi.fn() }),
  useUpsertTag: () => ({ mutateAsync: vi.fn() }),
}))

beforeEach(() => mutate.mockClear())

const queue = [
  makeTxn({ id: 't1', merchant_name: 'Whole Foods', plaid_category_detail: 'FOOD_AND_DRINK_GROCERIES' }),
  makeTxn({ id: 't2', merchant_name: 'Mystery Shop', amount: 20 }),
]

describe('<CategorizeReview>', () => {
  it('shows progress and the suggested category', () => {
    render(<CategorizeReview queue={queue} open onOpenChange={() => {}} />)
    expect(screen.getByText('1 of 2')).toBeInTheDocument()
    // first txn maps to Groceries via Plaid detail
    expect(screen.getByText('Groceries')).toBeInTheDocument()
  })

  it('confirm learns the guess and advances', async () => {
    render(<CategorizeReview queue={queue} open onOpenChange={() => {}} />)
    await userEvent.click(screen.getByRole('button', { name: 'Confirm' }))
    expect(mutate).toHaveBeenCalledWith({ txn: queue[0], categoryId: 'cat-g' })
    expect(await screen.findByText('2 of 2')).toBeInTheDocument()
    // second txn has no confident guess -> falls back to Other
    expect(screen.getByText('Other')).toBeInTheDocument()
  })

  it('skip advances without learning', async () => {
    render(<CategorizeReview queue={queue} open onOpenChange={() => {}} />)
    await userEvent.click(screen.getByRole('button', { name: 'Skip' }))
    expect(mutate).not.toHaveBeenCalled()
    // Advancing now flies the card off with a short animation, so the next card
    // appears asynchronously.
    expect(await screen.findByText('2 of 2')).toBeInTheDocument()
  })

  it('reaches an all-caught-up state after the last card', async () => {
    render(<CategorizeReview queue={[queue[0]]} open onOpenChange={() => {}} />)
    await userEvent.click(screen.getByRole('button', { name: 'Confirm' }))
    expect(await screen.findByText('All caught up')).toBeInTheDocument()
  })
})
