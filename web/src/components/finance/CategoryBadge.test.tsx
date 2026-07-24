import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { CategoryBadge } from './CategoryBadge'
import { makeCategory } from '@/test/factories'

describe('<CategoryBadge>', () => {
  it('renders the category name', () => {
    render(<CategoryBadge category={makeCategory({ name: 'Dining' })} />)
    expect(screen.getByText('Dining')).toBeInTheDocument()
  })

  it('shows "Uncategorized" when no category', () => {
    render(<CategoryBadge category={null} />)
    expect(screen.getByText('Uncategorized')).toBeInTheDocument()
  })
})
