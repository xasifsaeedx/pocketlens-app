import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { BulkCategorizePrompt, type BulkPrompt } from './BulkCategorizePrompt'

const prompt: BulkPrompt = {
  merchantName: 'Chipotle',
  merchantKey: 'chipotle',
  categoryId: 'cat-d',
  count: 3,
}

describe('<BulkCategorizePrompt>', () => {
  it('renders nothing when prompt is null', () => {
    render(<BulkCategorizePrompt prompt={null} onApply={() => {}} onDismiss={() => {}} />)
    expect(screen.queryByText('Categorize similar?')).not.toBeInTheDocument()
  })

  it('shows count + merchant and fires onApply with the prompt', async () => {
    const onApply = vi.fn()
    render(<BulkCategorizePrompt prompt={prompt} onApply={onApply} onDismiss={() => {}} />)

    expect(screen.getByText('Categorize similar?')).toBeInTheDocument()
    expect(
      screen.getByText(/3 other uncategorized “Chipotle” transactions/),
    ).toBeInTheDocument()

    await userEvent.click(screen.getByText('Categorize 3 more'))
    expect(onApply).toHaveBeenCalledWith(prompt)
  })

  it('fires onDismiss for "Just this one"', async () => {
    const onDismiss = vi.fn()
    render(<BulkCategorizePrompt prompt={prompt} onApply={() => {}} onDismiss={onDismiss} />)
    await userEvent.click(screen.getByText('Just this one'))
    expect(onDismiss).toHaveBeenCalled()
  })
})
