import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ZbbSettingsCard } from './ZbbSettingsCard'
import type { ZbbSettings } from '@/types/domain'

const saveMutate = vi.fn()
let settings: Partial<ZbbSettings>

vi.mock('@/data/hooks', () => ({
  useZbbSettings: () => ({ data: settings }),
  useSaveZbbSettings: () => ({ mutate: saveMutate }),
}))

beforeEach(() => {
  saveMutate.mockClear()
  settings = {
    enabled: false,
    rollover_mode: 'strict',
    monthly_income: 0,
    budget_start_year: null,
    budget_start_month: null,
  }
})

describe('ZbbSettingsCard', () => {
  it('first enable anchors budget_start to the current month (rollover chain needs it)', async () => {
    const user = userEvent.setup()
    render(<ZbbSettingsCard />)
    await user.click(screen.getByRole('switch'))
    const now = new Date()
    expect(saveMutate).toHaveBeenCalledWith({
      enabled: true,
      budget_start_year: now.getFullYear(),
      budget_start_month: now.getMonth() + 1,
    })
  })

  it('re-enable keeps the existing budget_start anchor', async () => {
    settings = { ...settings, budget_start_year: 2026, budget_start_month: 3 }
    const user = userEvent.setup()
    render(<ZbbSettingsCard />)
    await user.click(screen.getByRole('switch'))
    expect(saveMutate).toHaveBeenCalledWith({ enabled: true })
  })

  it('disable only flips the flag (assignments and anchor preserved)', async () => {
    settings = { ...settings, enabled: true, budget_start_year: 2026, budget_start_month: 3 }
    const user = userEvent.setup()
    render(<ZbbSettingsCard />)
    await user.click(screen.getByRole('switch'))
    expect(saveMutate).toHaveBeenCalledWith({ enabled: false })
  })

  it('hides income and rollover controls while disabled', () => {
    render(<ZbbSettingsCard />)
    expect(screen.queryByLabelText('Monthly income')).not.toBeInTheDocument()
  })

  it('saves monthly income on blur', async () => {
    settings = { ...settings, enabled: true }
    const user = userEvent.setup()
    render(<ZbbSettingsCard />)
    const input = screen.getByLabelText('Monthly income')
    await user.clear(input)
    await user.type(input, '5200')
    await user.tab()
    expect(saveMutate).toHaveBeenCalledWith({ monthly_income: 5200 })
  })
})
