import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NotificationPreferencesCard } from './NotificationPreferencesCard'
import type { NotificationPref } from '@/types/domain'

const upsertMutate = vi.fn()
let prefs: NotificationPref[]

vi.mock('@/data/hooks', () => ({
  useNotificationPrefs: () => ({ data: prefs }),
  useUpsertNotificationPref: () => ({ mutate: upsertMutate, isPending: false }),
}))

beforeEach(() => {
  upsertMutate.mockClear()
  prefs = []
})

describe('NotificationPreferencesCard', () => {
  it('shows every alert type, enabled by default when no pref row exists', () => {
    render(<NotificationPreferencesCard />)
    expect(screen.getByText('Budget threshold')).toBeInTheDocument()
    expect(screen.getByText('Large charge')).toBeInTheDocument()
    // Default-on: the toggle is checked before any pref is stored.
    expect(screen.getByLabelText('Enable Large charge alerts')).toBeChecked()
  })

  it('persists the toggle with the type and default config on change', async () => {
    const user = userEvent.setup()
    render(<NotificationPreferencesCard />)
    await user.click(screen.getByLabelText('Enable Large charge alerts'))
    expect(upsertMutate).toHaveBeenCalledWith({
      type: 'large_charge',
      enabled: false,
      config: {},
    })
  })

  it('persists a changed threshold amount on blur', async () => {
    const user = userEvent.setup()
    render(<NotificationPreferencesCard />)
    const input = screen.getByLabelText('Large charge amount')
    await user.clear(input)
    await user.type(input, '350')
    await user.tab()
    expect(upsertMutate).toHaveBeenCalledWith({
      type: 'large_charge',
      enabled: true,
      config: { amount: 350 },
    })
  })

  it('reflects a stored disabled pref and hides its threshold control', () => {
    prefs = [
      {
        id: '00000000-0000-0000-0000-000000000001',
        type: 'large_charge',
        enabled: false,
        config: { amount: 500 },
      },
    ]
    render(<NotificationPreferencesCard />)
    expect(screen.getByLabelText('Enable Large charge alerts')).not.toBeChecked()
    // Threshold input is hidden while the type is disabled.
    expect(screen.queryByLabelText('Large charge amount')).not.toBeInTheDocument()
  })
})
