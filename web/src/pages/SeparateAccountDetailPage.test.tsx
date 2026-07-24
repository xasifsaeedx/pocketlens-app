import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import SeparateAccountDetailPage from './SeparateAccountDetailPage'

const addValueMutate = vi.fn().mockResolvedValue(undefined)
const addContributionMutate = vi.fn().mockResolvedValue(undefined)
const deleteContributionMutate = vi.fn()

vi.mock('@/data/hooks', () => ({
  useSeparateAccounts: () => ({
    data: [{ id: 'sa-1', name: '401(k)', type: 'investment', currency: 'USD', is_active: true, display_order: 0 }],
    isLoading: false,
  }),
  useSeparateAccountValues: () => ({
    data: [
      { id: 'v-1', separate_account_id: 'sa-1', date: '2026-06-01', amount: 12000, note: 'Starting balance' },
      { id: 'v-2', separate_account_id: 'sa-1', date: '2026-06-15', amount: -500, note: null },
    ],
  }),
  useSeparateAccountContributions: () => ({
    data: [
      { id: 'c-1', separate_account_id: 'sa-1', delta_balance: 500, frequency_in_days: 14, anchor_date: '2026-06-01', last_applied_date: null, is_active: true },
    ],
  }),
  useDeleteSeparateAccount: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useAddSeparateAccountValue: () => ({ mutateAsync: addValueMutate, isPending: false }),
  useAddContribution: () => ({ mutateAsync: addContributionMutate, isPending: false }),
  useDeleteContribution: () => ({ mutate: deleteContributionMutate, isPending: false }),
}))

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/accounts/separate/sa-1']}>
      <Routes>
        <Route path="/accounts/separate/:id" element={<SeparateAccountDetailPage />} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('<SeparateAccountDetailPage>', () => {
  beforeEach(() => {
    addValueMutate.mockClear()
    addContributionMutate.mockClear()
    deleteContributionMutate.mockClear()
  })

  it('shows the account name and the balance = sum of the value ledger', () => {
    renderPage()
    expect(screen.getByRole('heading', { name: '401(k)' })).toBeInTheDocument()
    // 12000 + (-500) = 11500
    expect(screen.getByText('$11,500.00')).toBeInTheDocument()
  })

  it('lists recurring contributions with their cadence', () => {
    renderPage()
    expect(screen.getByText('every 14 days')).toBeInTheDocument()
  })

  it('adds a value entry (subtract flips the sign)', async () => {
    renderPage()
    await userEvent.click(screen.getByRole('button', { name: /add entry/i }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.type(within(dialog).getByLabelText('Amount'), '250')
    await userEvent.click(within(dialog).getByRole('button', { name: /save/i }))
    expect(addValueMutate).toHaveBeenCalledWith(
      expect.objectContaining({ separate_account_id: 'sa-1', amount: 250 }),
    )
  })

  it('deletes a contribution', async () => {
    renderPage()
    await userEvent.click(screen.getByLabelText('Delete contribution'))
    expect(deleteContributionMutate).toHaveBeenCalledWith('c-1')
  })
})
