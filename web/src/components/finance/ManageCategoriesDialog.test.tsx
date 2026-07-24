import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ManageCategoriesDialog } from './ManageCategoriesDialog'
import { makeCategory } from '@/test/factories'

const upsertMutate = vi.fn()
const upsertTagMutate = vi.fn()
const deleteMutate = vi.fn()
const reorderMutate = vi.fn()
const categoryHasSplits = vi.fn()
const toastError = vi.fn()

vi.mock('@/data/hooks', () => ({
  useCategories: () => ({
    data: [
      makeCategory({ id: 'cat-g', name: 'Groceries', icon: 'cart.fill' }),
      makeCategory({ id: 'cat-d', name: 'Dining', icon: 'fork.knife' }),
    ],
  }),
  useUpsertCategory: () => ({ mutate: upsertMutate }),
  useUpsertTag: () => ({ mutate: upsertTagMutate }),
  useDeleteCategory: () => ({ mutate: deleteMutate }),
  useReorderCategories: () => ({ mutate: reorderMutate }),
}))

vi.mock('@/data/categories', () => ({ categoryHasSplits: (id: string) => categoryHasSplits(id) }))
vi.mock('sonner', () => ({ toast: { error: (msg: string) => toastError(msg) } }))

describe('<ManageCategoriesDialog>', () => {
  beforeEach(() => {
    upsertMutate.mockClear()
    upsertTagMutate.mockClear()
    deleteMutate.mockClear()
    reorderMutate.mockClear()
    toastError.mockClear()
    categoryHasSplits.mockReset()
    categoryHasSplits.mockResolvedValue(false)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('creates a category from the new-name row', async () => {
    render(<ManageCategoriesDialog open onOpenChange={() => {}} />)
    await userEvent.type(screen.getByPlaceholderText('New category…'), 'Pets')
    await userEvent.click(screen.getByText('Add'))
    expect(upsertMutate).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Pets', icon: 'tag.fill' }),
    )
  })

  it('creates a tag (name + color only) when the add-row is in Tag mode', async () => {
    render(<ManageCategoriesDialog open onOpenChange={() => {}} />)
    await userEvent.click(screen.getByRole('button', { name: 'tag' }))
    await userEvent.type(screen.getByPlaceholderText('New tag…'), 'Vacation')
    await userEvent.click(screen.getByText('Add'))
    expect(upsertTagMutate).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Vacation', color: expect.any(String) }),
      expect.anything(),
    )
    // Tag mode never touches the categories table.
    expect(upsertMutate).not.toHaveBeenCalled()
  })

  it('renames on blur', async () => {
    render(<ManageCategoriesDialog open onOpenChange={() => {}} />)
    const input = screen.getByDisplayValue('Groceries')
    await userEvent.clear(input)
    await userEvent.type(input, 'Food')
    await userEvent.tab()
    expect(upsertMutate).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'cat-g', name: 'Food' }),
    )
  })

  it('changes the icon via the per-row icon grid', async () => {
    render(<ManageCategoriesDialog open onOpenChange={() => {}} />)
    await userEvent.click(screen.getByLabelText('Change Dining icon'))
    await userEvent.click(screen.getByLabelText('airplane'))
    expect(upsertMutate).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'cat-d', icon: 'airplane' }),
    )
  })

  it('reorders via the keyboard-accessible drag handle', async () => {
    render(<ManageCategoriesDialog open onOpenChange={() => {}} />)
    // Move "Groceries" (first) down one — it should swap with "Dining".
    const handle = screen.getByLabelText(/Reorder Groceries/i)
    handle.focus()
    await userEvent.keyboard('{ArrowDown}')
    expect(reorderMutate).toHaveBeenCalledWith([
      expect.objectContaining({ id: 'cat-d' }),
      expect.objectContaining({ id: 'cat-g' }),
    ])
  })

  it('deletes only after confirm', async () => {
    const confirm = vi.spyOn(window, 'confirm')
    render(<ManageCategoriesDialog open onOpenChange={() => {}} />)

    confirm.mockReturnValue(false)
    await userEvent.click(screen.getByLabelText('Delete Groceries'))
    await waitFor(() => expect(confirm).toHaveBeenCalled())
    expect(deleteMutate).not.toHaveBeenCalled()

    confirm.mockReturnValue(true)
    await userEvent.click(screen.getByLabelText('Delete Groceries'))
    await waitFor(() =>
      expect(deleteMutate).toHaveBeenCalledWith(
        'cat-g',
        expect.objectContaining({ onError: expect.any(Function) }),
      ),
    )
    confirm.mockRestore()
  })

  it('blocks deleting a category used in split transactions, with no confirm', async () => {
    categoryHasSplits.mockResolvedValue(true)
    const confirm = vi.spyOn(window, 'confirm')
    render(<ManageCategoriesDialog open onOpenChange={() => {}} />)

    await userEvent.click(screen.getByLabelText('Delete Groceries'))
    await waitFor(() => expect(toastError).toHaveBeenCalled())
    expect(confirm).not.toHaveBeenCalled()
    expect(deleteMutate).not.toHaveBeenCalled()
    confirm.mockRestore()
  })
})
