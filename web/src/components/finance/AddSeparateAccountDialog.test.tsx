import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AddSeparateAccountDialog } from './AddSeparateAccountDialog'

const createMutateAsync = vi.fn().mockResolvedValue({ id: 'sa-new' })

vi.mock('@/data/hooks', () => ({
  useCreateSeparateAccount: () => ({ mutateAsync: createMutateAsync, isPending: false }),
}))

describe('<AddSeparateAccountDialog>', () => {
  beforeEach(() => createMutateAsync.mockClear())

  it('creates an account with a starting balance', async () => {
    render(<AddSeparateAccountDialog open onOpenChange={() => {}} />)
    const dialog = await screen.findByRole('dialog')
    await userEvent.type(within(dialog).getByLabelText('Name'), 'Car loan')
    await userEvent.type(within(dialog).getByLabelText('Starting balance'), '12000')
    await userEvent.click(within(dialog).getByRole('button', { name: /save/i }))
    expect(createMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Car loan',
        type: 'investment',
        startingBalance: 12000,
        recurring: null,
      }),
    )
  })

  it('does not submit with a blank name', async () => {
    render(<AddSeparateAccountDialog open onOpenChange={() => {}} />)
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByRole('button', { name: /save/i })).toBeDisabled()
  })
})
