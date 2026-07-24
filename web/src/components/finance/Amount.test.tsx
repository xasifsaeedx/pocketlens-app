import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Amount } from './Amount'

describe('<Amount>', () => {
  it('shows a signed magnitude and neutral color for spend', () => {
    render(<Amount value={65} />)
    const el = screen.getByText('-$65.00')
    expect(el).toHaveClass('text-money-expense')
  })

  it('shows a signed magnitude and sage color for income', () => {
    render(<Amount value={-2650} />)
    const el = screen.getByText('+$2,650.00')
    expect(el).toHaveClass('text-money-income')
  })
})
