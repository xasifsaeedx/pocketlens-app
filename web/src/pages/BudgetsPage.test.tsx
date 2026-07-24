// Flat-budget regression: the monthly-limits view must stay intact (and default) now that
// BudgetsPage also hosts the opt-in zero-sum mode behind ?mode=zbb.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import BudgetsPage from './BudgetsPage'
import { makeCategory } from '@/test/factories'

const saveBudget = vi.fn().mockResolvedValue(undefined)
const deleteBudget = vi.fn().mockResolvedValue(undefined)
const upsertCategory = vi.fn()
// Spy on the write fns but keep the real resolveLimits (pure as-of resolver) so the page maps
// budget_limits rows to per-category limits exactly as in prod.
vi.mock('@/data/budgets', async () => {
  const actual = await vi.importActual<typeof import('@/data/budgets')>('@/data/budgets')
  return {
    ...actual,
    saveBudget: (...a: unknown[]) => saveBudget(...a),
    deleteBudget: (...a: unknown[]) => deleteBudget(...a),
  }
})

// Current first-of-month — the effective_month the page resolves for the default (current) view.
const thisMonthISO = (() => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`
})()

// Keep the page test focused on the flat view + mode switch; the ZBB view has its own tests.
vi.mock('@/features/budgets/ZbbBudgetView', () => ({
  default: () => <div data-testid="zbb-view" />,
}))

let zbbEnabled = false
vi.mock('@/data/hooks', () => ({
  sbKeys: { budgetLimits: ['sb', 'budgetLimits'] },
  useZbbSettings: () => ({ data: { enabled: zbbEnabled } }),
  useCategories: () => ({
    data: [
      makeCategory({ id: 'cat-food', name: 'Food' }),
      makeCategory({ id: 'cat-rent', name: 'Rent' }),
      makeCategory({ id: 'cat-pay', name: 'Paycheck', kind: 'income' }),
    ],
  }),
  useBudgetLimits: () => ({
    data: [{ id: 'b-1', category_id: 'cat-food', effective_month: thisMonthISO, monthly_limit: 500 }],
  }),
  // Spend-per-category now comes from the category_spend view (useSpendByCategory),
  // not a client re-sum of month txns. Food = 120 + 480 = 600, as before.
  useSpendByCategory: () => ({
    data: [{ category: makeCategory({ id: 'cat-food', name: 'Food' }), total: 600 }],
  }),
  // Hero health-check: uncategorized spend surfaced separately (ghost spending fix).
  useUncategorizedSpend: () => ({ data: 0 }),
  useCategoryGroups: () => ({ data: [] }),
  // Monthly report — powers the savings-rate stat + spend-by donuts (moved from Reports).
  useReport: () => ({ data: undefined }),
  // Group budget hooks — present but not exercised in these tests.
  useGroupBudgetLimits: () => ({ data: [] }),
  useSaveGroupBudget: () => ({ mutate: vi.fn() }),
  useDeleteGroupBudget: () => ({ mutate: vi.fn() }),
  useUpsertCategory: () => ({ mutate: upsertCategory }),
  // ManageCategoriesDialog hooks — not exercised by these tests but must be present.
  useDeleteCategory: () => ({ mutate: vi.fn() }),
  useReorderCategories: () => ({ mutate: vi.fn() }),
  // ManageCategoryGroupsDialog hooks — not exercised by these tests but must be present.
  useUpsertCategoryGroup: () => ({ mutate: vi.fn() }),
  useDeleteCategoryGroup: () => ({ mutate: vi.fn() }),
  useReorderCategoryGroups: () => ({ mutate: vi.fn() }),
  useSetCategoryGroup: () => ({ mutate: vi.fn() }),
  // CategoryPickerDialog embeds TxnTagEditor — not exercised here but must be present.
  useTags: () => ({ data: [] }),
  useUpsertTag: () => ({ mutateAsync: vi.fn() }),
  useToggleTransactionTag: () => ({ mutate: vi.fn() }),
  useTagRules: () => ({ data: [] }),
  useApplyTagRuleToTransaction: () => ({ mutate: vi.fn() }),
}))

function renderPage(initialPath = '/budgets') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[initialPath]}>
        <BudgetsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  zbbEnabled = false
  saveBudget.mockClear()
  deleteBudget.mockClear()
  upsertCategory.mockClear()
})

describe('BudgetsPage — hero health check', () => {
  it('shows Total Cash Outflow and Budget Progress labels', () => {
    renderPage()
    expect(screen.getByText('Total Cash Outflow')).toBeInTheDocument()
    expect(screen.getByText('Budget Progress')).toBeInTheDocument()
  })

  it('outflow figure equals total categorized spend (no uncategorized in this fixture)', () => {
    renderPage()
    // Food spend is 600; uncategorized is 0 → outflow = $600
    // getAllByText because $600 also appears in the left-column category card.
    expect(screen.getAllByText('$600').length).toBeGreaterThanOrEqual(1)
  })

  it('shows the budgeted segment legend when limits exist', () => {
    renderPage()
    expect(screen.getByText('Budgeted')).toBeInTheDocument()
  })
})

describe('BudgetsPage — flat mode (regression)', () => {
  it('renders monthly budgets with spent-of-limit for budgeted spend categories', () => {
    renderPage()
    expect(screen.getByRole('heading', { name: 'Spending by Category' })).toBeInTheDocument()
    expect(screen.getByText('Food')).toBeInTheDocument()
    // $600.00 appears in the category row and also in the right-column group breakdown.
    expect(screen.getAllByText('$600.00').length).toBeGreaterThanOrEqual(1)
    // The category card shows the limit as a separate formatted value ($500.00).
    expect(screen.getByText('$500.00')).toBeInTheDocument()
    // 120% = Math.round(600/500 * 100) shown in the card's bottom row.
    expect(screen.getByText('120%')).toBeInTheDocument()
  })

  it('marks an over-limit category and prompts to set missing budgets', () => {
    renderPage()
    expect(screen.getByText('Over budget')).toHaveClass('text-destructive')
    // Rent has no budget row yet
    expect(screen.getByRole('button', { name: 'Set budget goal for Rent' })).toBeInTheDocument()
  })

  it('hides income categories', () => {
    renderPage()
    expect(screen.queryByText('Paycheck')).not.toBeInTheDocument()
  })

  it('saves an edited limit at the viewed (current) month through the flat budgets data layer', async () => {
    const user = userEvent.setup()
    renderPage()
    await user.click(screen.getByRole('button', { name: 'Set budget goal for Rent' }))
    await user.type(screen.getByPlaceholderText('Monthly limit'), '900')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    // Editor opens on the viewed (current) month; the limit is written there.
    expect(saveBudget).toHaveBeenCalledWith('cat-rent', 900, { month: expect.any(Date) })
    const [, , opts] = saveBudget.mock.calls[0]
    const now = new Date()
    expect((opts.month as Date).getFullYear()).toBe(now.getFullYear())
    expect((opts.month as Date).getMonth()).toBe(now.getMonth())
  })

  it('sets a limit for a past month via the in-modal month navigator', async () => {
    const user = userEvent.setup()
    renderPage()
    await user.click(screen.getByRole('button', { name: 'Edit Food budget' }))
    // Step the editor back one month, then save a limit for that month.
    await user.click(screen.getByRole('button', { name: 'Previous budget month' }))
    const limitField = screen.getByPlaceholderText('Monthly limit')
    await user.clear(limitField)
    await user.type(limitField, '250')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(saveBudget).toHaveBeenCalledWith('cat-food', 250, { month: expect.any(Date) })
    const [, , opts] = saveBudget.mock.calls[0]
    const prev = new Date()
    prev.setMonth(prev.getMonth() - 1)
    expect((opts.month as Date).getFullYear()).toBe(prev.getFullYear())
    expect((opts.month as Date).getMonth()).toBe(prev.getMonth())
  })

  it('renames the category through the category data layer on Save', async () => {
    const user = userEvent.setup()
    renderPage()
    await user.click(screen.getByRole('button', { name: 'Edit Food budget' }))
    const nameField = screen.getByLabelText('Category name')
    await user.clear(nameField)
    await user.type(nameField, 'Groceries')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(upsertCategory).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'cat-food', name: 'Groceries' }),
    )
  })

  it('changes the category icon immediately from the picker', async () => {
    const user = userEvent.setup()
    renderPage()
    await user.click(screen.getByRole('button', { name: 'Edit Food budget' }))
    await user.click(screen.getByRole('button', { name: 'Change Food icon' }))
    await user.click(screen.getByRole('button', { name: 'car' }))
    expect(upsertCategory).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'cat-food', icon: 'car.fill' }),
    )
  })

  it('shows no mode tabs while zero-sum is disabled', () => {
    renderPage()
    expect(screen.queryByText('Zero-sum')).not.toBeInTheDocument()
    expect(screen.queryByTestId('zbb-view')).not.toBeInTheDocument()
  })
})

describe('BudgetsPage — zero-sum mode switch', () => {
  it('still defaults to the flat view when zero-sum is enabled', () => {
    zbbEnabled = true
    renderPage()
    expect(screen.getByRole('heading', { name: 'Spending by Category' })).toBeInTheDocument()
    expect(screen.getByText('Zero-sum')).toBeInTheDocument()
    expect(screen.queryByTestId('zbb-view')).not.toBeInTheDocument()
  })

  it('renders the zero-sum view at ?mode=zbb and drops the flat list', () => {
    zbbEnabled = true
    renderPage('/budgets?mode=zbb')
    expect(screen.getByTestId('zbb-view')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Spending by Category' })).not.toBeInTheDocument()
  })

  it('ignores ?mode=zbb while zero-sum is disabled', () => {
    renderPage('/budgets?mode=zbb')
    expect(screen.getByRole('heading', { name: 'Spending by Category' })).toBeInTheDocument()
    expect(screen.queryByTestId('zbb-view')).not.toBeInTheDocument()
  })
})
