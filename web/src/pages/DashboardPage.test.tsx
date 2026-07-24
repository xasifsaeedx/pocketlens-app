// Dashboard parity: the Home screen must show the monthly spending hero, net worth
// and net cashflow stat cards, spending donut, and recent activity section.
// Redesigned Jul 2026 — no assets/liabilities subline, no recurring-charges link.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import DashboardPage from './DashboardPage'
import { makeTxn } from '@/test/factories'

vi.mock('@/data/hooks', () => ({
  useCurrentNetWorth: () => ({
    data: { net_worth: 45000, total_assets: 50000, total_liabilities: 5000, as_of: '2026-07-07' },
    isLoading: false,
    isError: false,
  }),
  useTransactionsMonth: () => ({
    data: [
      makeTxn({ id: 'spend', amount: 200, merchant_name: 'Rent', effective_date: '2026-07-01' }),
      makeTxn({ id: 'pay', amount: -3000, merchant_name: 'Payroll', effective_date: '2026-07-02' }),
    ],
    isLoading: false,
  }),
  useRecent: () => ({
    data: [makeTxn({ id: 'r1', merchant_name: 'Blue Bottle', amount: 5.5 })],
    isLoading: false,
    isError: false,
  }),
  useSetCategory: () => ({ mutate: vi.fn() }),
  useAccounts: () => ({ data: [] }),
  // Pulled in by the always-mounted CategoryPickerDialog + TxnTagEditor.
  useCategories: () => ({ data: [] }),
  useSetHidden: () => ({ mutate: vi.fn() }),
  useSetReimbursement: () => ({ mutate: vi.fn() }),
  useUpsertCategory: () => ({ mutate: vi.fn() }),
  useAccountsWithBalance: () => ({ data: [] }),
  useTransferGroupLegs: () => ({ data: null }),
  useTags: () => ({ data: [] }),
  useToggleTransactionTag: () => ({ mutate: vi.fn() }),
  useUpsertTag: () => ({ mutateAsync: vi.fn() }),
  // InlineNetWorthTrend uses useNetWorth
  useNetWorth: () => ({ data: [], isLoading: false }),
  // New hooks added in Jul 2026 redesign
  useMyProfile: () => ({ data: { first_name: 'Test', last_name: 'User' } }),
  useSpendByCategory: () => ({ data: [], isLoading: false }),
  useCategoryGroups: () => ({ data: [], isLoading: false }),
}))

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <DashboardPage />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('DashboardPage — spending-led home (Jul 2026 redesign)', () => {
  it('shows Monthly Spending hero label and net spend amount', () => {
    renderPage()
    expect(screen.getByText('Monthly Spending')).toBeInTheDocument()
    // net spend = 200 (Rent only; Payroll is income, no reimbursements in this fixture).
    // $200.00 appears in both the hero number and the Rent row in Recent Activity.
    expect(screen.getAllByText('$200.00').length).toBeGreaterThanOrEqual(1)
  })

  it('shows Net Worth stat card with formatted value from useCurrentNetWorth', () => {
    renderPage()
    expect(screen.getByText('Net Worth')).toBeInTheDocument()
    expect(screen.getByText('$45,000.00')).toBeInTheDocument()
  })

  it('shows Monthly Net Cashflow stat card (income $3000 − spending $200 = $2800)', () => {
    renderPage()
    expect(screen.getByText('Monthly Net Cashflow')).toBeInTheDocument()
    // net cashflow = income (3000) - gross spend (200) = 2800
    expect(screen.getByText('$2,800.00')).toBeInTheDocument()
  })

  it('shows Recent Activity section with See All link to /transactions', () => {
    renderPage()
    expect(screen.getByText('Recent Activity')).toBeInTheDocument()
    const seeAll = screen.getByRole('link', { name: /see all/i })
    expect(seeAll).toHaveAttribute('href', '/transactions')
  })

  it('renders recent transaction rows', () => {
    renderPage()
    expect(screen.getByText('Blue Bottle')).toBeInTheDocument()
  })

  it('always renders the cumulative spend chart (never shows empty state text)', () => {
    renderPage()
    // The chart should always be present, identified by its aria-label
    expect(screen.getByRole('img', { name: 'Cumulative monthly spending' })).toBeInTheDocument()
    // The old empty-state messages should not appear
    expect(screen.queryByText('No spending this month')).not.toBeInTheDocument()
    expect(screen.queryByText('Not enough data yet')).not.toBeInTheDocument()
  })
})
