// Sign-in fallback for the scheduled sync (useAutoSyncOnLogin / isSyncStale).
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PlaidItem } from '@/types/domain'

const triggerSync = vi.fn<() => Promise<void>>()
const fetchPlaidItems = vi.fn<() => Promise<PlaidItem[]>>()

vi.mock('./sync', () => ({
  triggerSync: () => triggerSync(),
  backfillAll: vi.fn(),
}))
vi.mock('./plaidItems', () => ({
  fetchPlaidItems: () => fetchPlaidItems(),
  deleteItem: vi.fn(),
}))

const { AUTO_SYNC_STALE_MS, isSyncStale, useAutoSyncOnLogin } = await import('./hooks')

const NOW = Date.parse('2026-09-19T12:00:00Z')

function item(over: Partial<PlaidItem>): PlaidItem {
  return {
    id: 'item-1',
    plaid_item_id: 'p-1',
    institution_id: null,
    institution_name: 'Bank',
    institution_logo: null,
    last_synced_at: new Date(NOW - 5 * 60 * 1000).toISOString(),
    is_active: true,
    is_syncing: false,
    sync_started_at: null,
    last_backfill_at: null,
    ...over,
  }
}

describe('isSyncStale', () => {
  it('is false when every bank synced within the hour', () => {
    expect(isSyncStale([item({})], NOW)).toBe(false)
  })
  it('is true for a bank that never synced, or synced over an hour ago', () => {
    expect(isSyncStale([item({ last_synced_at: null })], NOW)).toBe(true)
    const old = new Date(NOW - AUTO_SYNC_STALE_MS - 1000).toISOString()
    expect(isSyncStale([item({ last_synced_at: old })], NOW)).toBe(true)
  })
  it('ignores a bank that is already mid-sync', () => {
    expect(isSyncStale([item({ last_synced_at: null, is_syncing: true })], NOW)).toBe(false)
  })
  it('is false with no linked banks', () => {
    expect(isSyncStale([], NOW)).toBe(false)
  })
})

describe('useAutoSyncOnLogin', () => {
  let qc: QueryClient
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    triggerSync.mockReset().mockResolvedValue()
    fetchPlaidItems.mockReset()
  })
  afterEach(() => {
    vi.useRealTimers()
    qc.clear()
  })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  )

  it('kicks one sync when a bank is stale, and only once per user', async () => {
    fetchPlaidItems.mockResolvedValue([item({ last_synced_at: null })])
    const { rerender } = renderHook(({ uid }) => useAutoSyncOnLogin(uid), {
      wrapper,
      initialProps: { uid: 'user-1' },
    })
    await waitFor(() => expect(triggerSync).toHaveBeenCalledTimes(1))
    rerender({ uid: 'user-1' })
    expect(triggerSync).toHaveBeenCalledTimes(1)
  })

  it('does nothing when every bank is fresh', async () => {
    fetchPlaidItems.mockResolvedValue([item({})])
    renderHook(() => useAutoSyncOnLogin('user-1'), { wrapper })
    await waitFor(() => expect(fetchPlaidItems).toHaveBeenCalled())
    await waitFor(() => expect(qc.getQueryData(['sb', 'plaidItems'])).toBeDefined())
    expect(triggerSync).not.toHaveBeenCalled()
  })

  it('does nothing while signed out', async () => {
    fetchPlaidItems.mockResolvedValue([item({ last_synced_at: null })])
    renderHook(() => useAutoSyncOnLogin(null), { wrapper })
    await waitFor(() => expect(qc.getQueryData(['sb', 'plaidItems'])).toBeDefined())
    expect(triggerSync).not.toHaveBeenCalled()
  })
})
