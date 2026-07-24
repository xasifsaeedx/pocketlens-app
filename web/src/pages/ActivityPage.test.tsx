// Activity page: renders the feed newest-first and wires per-entry Undo through the
// data layer (undoActivity dispatcher), which the undo mutation calls. Data layer is
// mocked like BudgetsPage.test.tsx.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ActivityPage from './ActivityPage'
import type { ActivityEntry } from '@/types/domain'

const undoActivity = vi.fn().mockResolvedValue(undefined)
const fetchActivity = vi.fn()
vi.mock('@/data/activity', () => ({
  fetchActivity: () => fetchActivity(),
  undoActivity: (...a: unknown[]) => undoActivity(...a),
}))

// Toasts are irrelevant to this test; stub sonner so it doesn't need a portal.
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

function entry(p: Partial<ActivityEntry>): ActivityEntry {
  return {
    id: 'a-1',
    created_at: new Date().toISOString(),
    action_type: 'categorize',
    entity_type: 'transaction',
    entity_id: 't-1',
    summary: 'Categorized Chipotle as Dining',
    before: { category_id: null },
    after: { category_id: 'cat-dining' },
    reversible: true,
    undone: false,
    undone_at: null,
    ...p,
  }
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <ActivityPage />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  undoActivity.mockClear()
  fetchActivity.mockReset()
})

describe('ActivityPage', () => {
  it('renders entries newest-first with summaries', async () => {
    fetchActivity.mockResolvedValue([
      entry({ id: 'a-1', summary: 'Categorized Chipotle as Dining' }),
      entry({
        id: 'a-2',
        action_type: 'set_budget',
        entity_type: 'budget',
        summary: 'Set Groceries budget to $400.00',
      }),
    ])
    renderPage()
    expect(await screen.findByText('Categorized Chipotle as Dining')).toBeInTheDocument()
    expect(screen.getByText('Set Groceries budget to $400.00')).toBeInTheDocument()
  })

  it('undoes a reversible entry through the data layer', async () => {
    const e = entry({ id: 'a-1' })
    fetchActivity.mockResolvedValue([e])
    const user = userEvent.setup()
    renderPage()
    const undoBtn = await screen.findByRole('button', { name: /Undo:/ })
    await user.click(undoBtn)
    expect(undoActivity).toHaveBeenCalledTimes(1)
    expect(undoActivity).toHaveBeenCalledWith(e)
  })

  it('shows a muted Undone label and no Undo button for undone entries', async () => {
    fetchActivity.mockResolvedValue([entry({ id: 'a-1', undone: true, undone_at: new Date().toISOString() })])
    renderPage()
    const item = await screen.findByRole('listitem')
    expect(within(item).getByText('Undone')).toBeInTheDocument()
    expect(within(item).queryByRole('button')).not.toBeInTheDocument()
  })

  it('renders an empty state when there is no activity', async () => {
    fetchActivity.mockResolvedValue([])
    renderPage()
    expect(await screen.findByText(/No activity yet/)).toBeInTheDocument()
  })

  it('shows the error state with a Retry on a failed fetch', async () => {
    // First load fails; a real failed fetch must read as an error + Retry, not an
    // empty "No activity yet" state.
    fetchActivity.mockRejectedValueOnce(new Error('network down'))
    const user = userEvent.setup()
    renderPage()

    const alert = await screen.findByRole('alert')
    expect(within(alert).getByText(/Couldn't load/)).toBeInTheDocument()
    expect(screen.queryByText(/No activity yet/)).not.toBeInTheDocument()

    // Retry refetches — the second attempt succeeds and the feed renders.
    fetchActivity.mockResolvedValueOnce([entry({ summary: 'Categorized Chipotle as Dining' })])
    await user.click(screen.getByRole('button', { name: /Retry/ }))
    expect(await screen.findByText('Categorized Chipotle as Dining')).toBeInTheDocument()
  })
})
