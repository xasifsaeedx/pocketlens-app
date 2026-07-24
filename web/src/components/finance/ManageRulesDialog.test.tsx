import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ManageRulesDialog } from './ManageRulesDialog'
import { makeCategory, makeRule } from '@/test/factories'

const addMutate = vi.fn()
const deleteMutate = vi.fn()
// Auto-categorize mutate(undefined, { onSuccess }) — resolve a canned count so the toast fires.
let autoCount = 3
const autoMutate = vi.fn((_vars: unknown, opts?: { onSuccess?: (n: number) => void }) =>
  opts?.onSuccess?.(autoCount),
)
const toastSuccess = vi.fn()

// Tag-rule hooks.
const addTagRuleMutate = vi.fn()
const deleteTagRuleMutate = vi.fn()
let applyAllCount = 5
const applyAllMutate = vi.fn((_vars: unknown, opts?: { onSuccess?: (n: number) => void }) =>
  opts?.onSuccess?.(applyAllCount),
)

vi.mock('sonner', () => ({ toast: { success: (m: string) => toastSuccess(m), error: vi.fn() } }))

// countTxnsWithTag is called on Add in the tag tab; resolve 0 so no window.confirm fires.
const countTxnsWithTag = vi.fn().mockResolvedValue(0)
vi.mock('@/data/tagRules', () => ({ countTxnsWithTag: (id: string) => countTxnsWithTag(id) }))

vi.mock('@/data/hooks', () => ({
  useRules: () => ({
    data: [makeRule({ id: 'rule-g', keyword: 'Whole Foods', category_id: 'cat-g' })],
  }),
  useCategories: () => ({
    data: [
      makeCategory({ id: 'cat-g', name: 'Groceries', icon: 'cart.fill' }),
      makeCategory({ id: 'cat-d', name: 'Dining', icon: 'fork.knife' }),
    ],
  }),
  useAddRule: () => ({ mutate: addMutate }),
  useDeleteRule: () => ({ mutate: deleteMutate }),
  useAutoCategorizeUncategorized: () => ({ mutate: autoMutate, isPending: false }),
  useTags: () => ({ data: [{ id: 'tag-1', name: 'Travel', color: '#0a84ff' }] }),
  useTagRules: () => ({ data: [{ id: 'tr-1', tag_id: 'tag-1', category_id: 'cat-d' }] }),
  useAddTagRule: () => ({ mutate: addTagRuleMutate, isPending: false }),
  useDeleteTagRule: () => ({ mutate: deleteTagRuleMutate }),
  useApplyAllTagRules: () => ({ mutate: applyAllMutate, isPending: false }),
}))

describe('<ManageRulesDialog>', () => {
  beforeEach(() => {
    addMutate.mockClear()
    deleteMutate.mockClear()
    autoMutate.mockClear()
    toastSuccess.mockClear()
    addTagRuleMutate.mockClear()
    deleteTagRuleMutate.mockClear()
    applyAllMutate.mockClear()
    countTxnsWithTag.mockClear()
    autoCount = 3
    applyAllCount = 5
  })

  it('titles the dialog "Auto Classify"', () => {
    render(<ManageRulesDialog open onOpenChange={() => {}} />)
    expect(screen.getByText('Auto Classify')).toBeInTheDocument()
  })

  it('lists existing rules human-readably (describeRule)', () => {
    render(<ManageRulesDialog open onOpenChange={() => {}} />)
    // A plain legacy rule renders as `"<keyword>" → <Category>`.
    expect(screen.getByText('"Whole Foods" → Groceries')).toBeInTheDocument()
    expect(screen.getByLabelText('Delete rule for Whole Foods')).toBeInTheDocument()
  })

  it('adds a plain keyword→category rule (conditions default to any/none)', async () => {
    render(<ManageRulesDialog open onOpenChange={() => {}} />)
    await userEvent.type(screen.getByLabelText('Rule keyword'), 'Uber')
    await userEvent.selectOptions(screen.getByLabelText('Rule category'), 'cat-d')
    await userEvent.click(screen.getByText('Add rule'))
    expect(addMutate).toHaveBeenCalledWith(
      {
        keyword: 'Uber',
        categoryId: 'cat-d',
        direction: null,
        minAmount: null,
        maxAmount: null,
        setReimbursement: false,
      },
      expect.anything(),
    )
  })

  it('builds a conditional rule: direction + amount + reimbursement', async () => {
    render(<ManageRulesDialog open onOpenChange={() => {}} />)
    await userEvent.type(screen.getByLabelText('Rule keyword'), 'Ved Rao')
    await userEvent.selectOptions(screen.getByLabelText('Money direction'), 'in')
    await userEvent.selectOptions(screen.getByLabelText('Amount condition'), 'over')
    await userEvent.type(screen.getByLabelText('Minimum amount'), '1500')
    await userEvent.selectOptions(screen.getByLabelText('Rule category'), 'cat-g')
    await userEvent.click(screen.getByLabelText('Mark as reimbursement'))
    await userEvent.click(screen.getByText('Add rule'))
    expect(addMutate).toHaveBeenCalledWith(
      {
        keyword: 'Ved Rao',
        categoryId: 'cat-g',
        direction: 'in',
        minAmount: 1500,
        maxAmount: null,
        setReimbursement: true,
      },
      expect.anything(),
    )
  })

  it('does not add without a keyword and at least one action', async () => {
    render(<ManageRulesDialog open onOpenChange={() => {}} />)
    await userEvent.type(screen.getByLabelText('Rule keyword'), 'Uber')
    // no category and reimbursement unchecked → Add stays disabled
    await userEvent.click(screen.getByText('Add rule'))
    expect(addMutate).not.toHaveBeenCalled()
  })

  it('deletes a rule', async () => {
    render(<ManageRulesDialog open onOpenChange={() => {}} />)
    await userEvent.click(screen.getByLabelText('Delete rule for Whole Foods'))
    expect(deleteMutate).toHaveBeenCalledWith('rule-g')
  })

  it('runs auto-categorize and reports the count', async () => {
    render(<ManageRulesDialog open onOpenChange={() => {}} />)
    await userEvent.click(screen.getByText('Auto-categorize uncategorized'))
    expect(autoMutate).toHaveBeenCalled()
    expect(toastSuccess).toHaveBeenCalledWith('Categorized 3 transactions.')
  })

  it('auto-categorize reports the empty case gracefully', async () => {
    autoCount = 0
    render(<ManageRulesDialog open onOpenChange={() => {}} />)
    await userEvent.click(screen.getByText('Auto-categorize uncategorized'))
    expect(toastSuccess).toHaveBeenCalledWith(expect.stringContaining('Nothing to categorize'))
  })

  it('switches to the By tag tab and lists existing tag rules', async () => {
    render(<ManageRulesDialog open onOpenChange={() => {}} />)
    await userEvent.click(screen.getByText('By tag'))
    // Rule renders as <tag chip> → <category>; the per-row delete carries the tag name.
    // (Tag/category names also appear in the builder's <select> options, so assert on the
    // unique delete label rather than the ambiguous text.)
    expect(screen.getByLabelText('Delete tag rule for Travel')).toBeInTheDocument()
  })

  it('adds a tag rule (no backfill when no txns carry the tag)', async () => {
    render(<ManageRulesDialog open onOpenChange={() => {}} />)
    await userEvent.click(screen.getByText('By tag'))
    await userEvent.selectOptions(screen.getByLabelText('Rule tag'), 'tag-1')
    await userEvent.selectOptions(screen.getByLabelText('Tag rule category'), 'cat-d')
    await userEvent.click(screen.getByText('Add tag rule'))
    expect(countTxnsWithTag).toHaveBeenCalledWith('tag-1')
    expect(addTagRuleMutate).toHaveBeenCalledWith(
      { tagId: 'tag-1', categoryId: 'cat-d', backfill: false },
      expect.anything(),
    )
  })

  it('deletes a tag rule', async () => {
    render(<ManageRulesDialog open onOpenChange={() => {}} />)
    await userEvent.click(screen.getByText('By tag'))
    await userEvent.click(screen.getByLabelText('Delete tag rule for Travel'))
    expect(deleteTagRuleMutate).toHaveBeenCalledWith('tr-1')
  })

  it('applies all tag rules and reports the count', async () => {
    render(<ManageRulesDialog open onOpenChange={() => {}} />)
    await userEvent.click(screen.getByText('By tag'))
    await userEvent.click(screen.getByText('Apply now'))
    expect(applyAllMutate).toHaveBeenCalled()
    expect(toastSuccess).toHaveBeenCalledWith('Updated 5 transactions.')
  })
})
