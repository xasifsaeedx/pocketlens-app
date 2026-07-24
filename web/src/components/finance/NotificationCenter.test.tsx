import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import NotificationCenter from './NotificationCenter'
import type { AppNotification } from '@/types/domain'

// ── Helpers ──────────────────────────────────────────────────────────────────

const markReadMutate = vi.fn()
const markAllMutate = vi.fn()
const deleteMutate = vi.fn()
const deleteAllMutate = vi.fn()

let notifications: AppNotification[]

vi.mock('@/data/hooks', () => ({
  useNotifications: () => ({ data: notifications, isLoading: false }),
  useUnreadNotificationCount: () => notifications.filter((n) => n.read_at == null).length,
  useMarkNotificationRead: () => ({ mutate: markReadMutate, isPending: false }),
  useMarkAllNotificationsRead: () => ({ mutate: markAllMutate, isPending: false }),
  useDeleteNotification: () => ({ mutate: deleteMutate, isPending: false }),
  useDeleteAllNotifications: () => ({ mutate: deleteAllMutate, isPending: false }),
}))

function makeNotification(overrides: Partial<AppNotification> = {}): AppNotification {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    type: 'large_charge',
    title: 'Large charge detected',
    body: '$250 at Amazon',
    payload: {},
    dedup_key: null,
    read_at: null,
    created_at: new Date().toISOString(),
    ...overrides,
  }
}

function renderCenter() {
  return render(
    <MemoryRouter>
      <NotificationCenter />
    </MemoryRouter>,
  )
}

async function openPopover() {
  const trigger = screen.getByRole('button', { name: /notifications/i })
  await userEvent.click(trigger)
}

// ── Tests ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  notifications = []
  markReadMutate.mockClear()
  markAllMutate.mockClear()
  deleteMutate.mockClear()
  deleteAllMutate.mockClear()
})

describe('NotificationCenter — delete all', () => {
  it('does not show "Delete all" when the inbox is empty', async () => {
    renderCenter()
    await openPopover()
    expect(screen.queryByRole('button', { name: /delete all/i })).not.toBeInTheDocument()
  })

  it('shows "Delete all" when there is at least one notification', async () => {
    notifications = [makeNotification()]
    renderCenter()
    await openPopover()
    expect(screen.getByRole('button', { name: /delete all/i })).toBeInTheDocument()
  })

  it('calls deleteAll mutate when the button is clicked', async () => {
    notifications = [makeNotification()]
    const user = userEvent.setup()
    renderCenter()
    await openPopover()
    await user.click(screen.getByRole('button', { name: /delete all/i }))
    expect(deleteAllMutate).toHaveBeenCalledTimes(1)
  })

  it('shows "Delete all" alongside "Mark all read" when there are unread notifications', async () => {
    notifications = [makeNotification({ read_at: null })]
    renderCenter()
    await openPopover()
    expect(screen.getByRole('button', { name: /mark all read/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /delete all/i })).toBeInTheDocument()
  })

  it('shows "Delete all" without "Mark all read" when all notifications are read', async () => {
    notifications = [makeNotification({ read_at: new Date().toISOString() })]
    renderCenter()
    await openPopover()
    expect(screen.queryByRole('button', { name: /mark all read/i })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /delete all/i })).toBeInTheDocument()
  })
})
