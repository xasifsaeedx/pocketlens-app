import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { CategoryPickerDialog } from './CategoryPickerDialog'
import { makeCategory, makeTxn } from '@/test/factories'

const setHiddenMutate = vi.fn()
const setReimbursementMutate = vi.fn()
const upsertCategoryAsync = vi.fn()

vi.mock('@/data/hooks', () => ({
  useCategories: () => ({
    data: [
      makeCategory({ id: 'cat-g', name: 'Groceries' }),
      makeCategory({ id: 'cat-d', name: 'Dining' }),
    ],
  }),
  useSetHidden: () => ({ mutate: setHiddenMutate }),
  useSetReimbursement: () => ({ mutate: setReimbursementMutate }),
  useUpsertCategory: () => ({ mutateAsync: upsertCategoryAsync, isPending: false }),
  // The dialog also reads these (transfer route + account map).
  useAccountsWithBalance: () => ({ data: [] }),
  useTransferGroupLegs: () => ({ data: null }),
  // TxnTagEditor (embedded in the dialog) reads these.
  useTags: () => ({ data: [] }),
  useToggleTransactionTag: () => ({ mutate: vi.fn() }),
  useUpsertTag: () => ({ mutateAsync: vi.fn() }),
  useTagRules: () => ({ data: [] }),
  useApplyTagRuleToTransaction: () => ({ mutate: vi.fn() }),
}))

describe('<CategoryPickerDialog>', () => {
  it('renders the category grid + None and fires onPick', async () => {
    const onPick = vi.fn()
    render(
      <CategoryPickerDialog
        txn={makeTxn({ merchant_name: 'Chipotle' })}
        open
        onOpenChange={() => {}}
        onPick={onPick}
      />,
    )

    expect(screen.getByText('Chipotle')).toBeInTheDocument()
    expect(screen.getByText('Groceries')).toBeInTheDocument()

    await userEvent.click(screen.getByText('Dining'))
    expect(onPick).toHaveBeenCalledWith('cat-d')
  })

  it('picks null for "None"', async () => {
    const onPick = vi.fn()
    render(
      <CategoryPickerDialog txn={makeTxn()} open onOpenChange={() => {}} onPick={onPick} />,
    )
    await userEvent.click(screen.getByText('None'))
    expect(onPick).toHaveBeenCalledWith(null)
  })

  it('"Hidden" tile hides the txn, closes, and notifies without onPick', async () => {
    setHiddenMutate.mockClear()
    const onPick = vi.fn()
    const onOpenChange = vi.fn()
    const onToggleHidden = vi.fn()
    const txn = makeTxn()
    render(
      <CategoryPickerDialog
        txn={txn}
        open
        onOpenChange={onOpenChange}
        onPick={onPick}
        onToggleHidden={onToggleHidden}
      />,
    )
    await userEvent.click(screen.getByText('Hidden'))
    expect(setHiddenMutate).toHaveBeenCalledWith({ txn, hidden: true })
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(onToggleHidden).toHaveBeenCalled()
    expect(onPick).not.toHaveBeenCalled()
  })

  it('"New" tile creates a category and picks it', async () => {
    upsertCategoryAsync.mockResolvedValue(makeCategory({ id: 'cat-new', name: 'Pets' }))
    const onPick = vi.fn()
    render(
      <CategoryPickerDialog txn={makeTxn()} open onOpenChange={() => {}} onPick={onPick} />,
    )
    await userEvent.click(screen.getByText('New'))
    await userEvent.type(screen.getByPlaceholderText('Category name…'), 'Pets{Enter}')
    expect(upsertCategoryAsync).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Pets', icon: 'tag.fill' }),
    )
    expect(onPick).toHaveBeenCalledWith('cat-new')
  })

  it('shows "Unhide" for a hidden txn and unhides', async () => {
    setHiddenMutate.mockClear()
    const txn = makeTxn({ hidden: true })
    render(
      <CategoryPickerDialog txn={txn} open onOpenChange={() => {}} onPick={() => {}} />,
    )
    await userEvent.click(screen.getByText('Unhide'))
    expect(setHiddenMutate).toHaveBeenCalledWith({ txn, hidden: false })
  })

  it('hides the Reimbursement control for a debit (amount > 0)', () => {
    render(
      <CategoryPickerDialog txn={makeTxn({ amount: 42 })} open onOpenChange={() => {}} onPick={() => {}} />,
    )
    expect(screen.queryByLabelText('Reimbursement')).not.toBeInTheDocument()
  })

  it('shows the Reimbursement control for a credit (amount < 0)', () => {
    render(
      <CategoryPickerDialog txn={makeTxn({ amount: -1500 })} open onOpenChange={() => {}} onPick={() => {}} />,
    )
    expect(screen.getByLabelText('Reimbursement')).toBeInTheDocument()
  })

  it('marking a credit as a reimbursement fires setReimbursement with the offset category, not onPick', async () => {
    setReimbursementMutate.mockClear()
    const onPick = vi.fn()
    const onOpenChange = vi.fn()
    const txn = makeTxn({ id: 'zelle', amount: -1500 })
    render(
      <CategoryPickerDialog
        txn={txn}
        open
        onOpenChange={onOpenChange}
        onPick={onPick}
      />,
    )
    await userEvent.click(screen.getByLabelText('Reimbursement'))
    await userEvent.click(screen.getByText('Groceries'))
    expect(setReimbursementMutate).toHaveBeenCalledWith({
      transactionId: 'zelle',
      isReimbursement: true,
      categoryId: 'cat-g',
    })
    expect(onPick).not.toHaveBeenCalled()
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('toggling Reimbursement off clears the category (parity with iOS)', async () => {
    setReimbursementMutate.mockClear()
    const txn = makeTxn({ id: 'zelle', amount: -1500, is_reimbursement: true, category_id: 'cat-g' })
    render(
      <CategoryPickerDialog txn={txn} open onOpenChange={() => {}} onPick={() => {}} />,
    )
    // starts on (flagged); click turns it off → reverts to a plain uncategorized credit
    await userEvent.click(screen.getByLabelText('Reimbursement'))
    expect(setReimbursementMutate).toHaveBeenCalledWith({
      transactionId: 'zelle',
      isReimbursement: false,
      categoryId: null,
    })
  })

  it('hides Split while reimbursing (mutually exclusive)', async () => {
    render(
      <CategoryPickerDialog txn={makeTxn({ amount: -1500 })} open onOpenChange={() => {}} onPick={() => {}} />,
    )
    expect(screen.getByText('Split transaction')).toBeInTheDocument()
    await userEvent.click(screen.getByLabelText('Reimbursement'))
    expect(screen.queryByText('Split transaction')).not.toBeInTheDocument()
  })
})
