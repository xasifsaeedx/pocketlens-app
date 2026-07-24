// Search on the Transactions page: an active query swaps the day-grouped month list
// for server-side results (useTransactionSearch), hides the month nav, and clears back.
// The matching SQL itself is covered by the backend integration tests (section 11).

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { expect, it, vi } from 'vitest'
import AllTransactionsPage from './AllTransactionsPage'
import { makeTxn } from '@/test/factories'

vi.mock('@/data/transactions', () => ({
  uncategorizedSameMerchant: vi.fn().mockResolvedValue([]),
  SEARCH_LIMIT: 200,
}))

const monthTxn = makeTxn({ id: 'txn-month', merchant_name: 'Month Coffee' })
const hitTxn = makeTxn({ id: 'txn-hit', merchant_name: 'Search Hit' })

vi.mock('@/data/hooks', () => ({
  useTransactionsMonthAll: () => ({ data: [monthTxn], isLoading: false }),
  useSpendByCategory: () => ({ data: [] }),
  useUncategorized: () => ({ data: [] }),
  useCategories: () => ({ data: [] }),
  useAccounts: () => ({ data: [] }),
  useTags: () => ({ data: [] }),
  // Pulled in by the CategoryPickerDialog + TxnTagEditor it renders.
  useAccountsWithBalance: () => ({ data: [] }),
  useTransferGroupLegs: () => ({ data: null }),
  useToggleTransactionTag: () => ({ mutate: vi.fn() }),
  useUpsertTag: () => ({ mutateAsync: vi.fn() }),
  useSetCategory: () => ({ mutateAsync: vi.fn() }),
  useSetHidden: () => ({ mutateAsync: vi.fn() }),
  useSetReimbursement: () => ({ mutate: vi.fn() }),
  useUpsertCategory: () => ({ mutate: vi.fn(), mutateAsync: vi.fn() }),
  useDeleteCategory: () => ({ mutate: vi.fn(), mutateAsync: vi.fn() }),
  useBulkCategorizeMerchant: () => ({ mutate: vi.fn() }),
  useSavedViews: () => ({ data: [] }),
  useCreateSavedView: () => ({ mutateAsync: vi.fn() }),
  useDeleteSavedView: () => ({ mutate: vi.fn() }),
  // Deterministic fake: empty results for "zzz", one hit for anything else.
  useTransactionSearch: (q: string) =>
    q.trim()
      ? { data: q.trim() === 'zzz' ? [] : [hitTxn], isPending: false }
      : { data: undefined, isPending: true },
  useRecurringSeries: () => ({ data: [], isLoading: false }),
}))

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <AllTransactionsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

it('an active query swaps the list to search results, and clearing restores the month', async () => {
  renderPage()
  expect(screen.getByText('Month Coffee')).toBeInTheDocument()

  await userEvent.type(screen.getByLabelText('Search transactions'), 'hit')
  // results appear once the 250ms debounce fires
  expect(await screen.findByText('Search Hit')).toBeInTheDocument()
  expect(screen.queryByText('Month Coffee')).not.toBeInTheDocument()

  await userEvent.click(screen.getByLabelText('Clear search'))
  expect(screen.getByText('Month Coffee')).toBeInTheDocument()
  expect(screen.queryByText('Search Hit')).not.toBeInTheDocument()
})

it('shows a designed no-matches state', async () => {
  renderPage()
  await userEvent.type(screen.getByLabelText('Search transactions'), 'zzz')
  expect(await screen.findByText('No matches for “zzz”.')).toBeInTheDocument()
})
