import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import LoginPage from './LoginPage'

const signIn = vi.fn().mockResolvedValue(undefined)
const signUp = vi.fn().mockResolvedValue({ needsConfirmation: false })
const resetPassword = vi.fn().mockResolvedValue(undefined)

vi.mock('@/lib/auth', () => ({
  useAuth: () => ({
    signIn,
    signUp,
    resetPassword,
    signOut: vi.fn(),
    session: null,
    user: null,
    loading: false,
  }),
}))

beforeEach(() => {
  signIn.mockClear()
  signUp.mockClear()
  resetPassword.mockClear()
})

// A password that satisfies the policy (10+ chars, upper/lower/digit/symbol).
const VALID_PW = 'Demofinance123!'

describe('<LoginPage>', () => {
  it('disables submit until email and password are entered (sign in accepts any password)', async () => {
    render(<LoginPage />)
    const submit = screen.getByRole('button', { name: /sign in/i })
    expect(submit).toBeDisabled()

    await userEvent.type(screen.getByLabelText('Email'), 'demo@pocketlens.app')
    expect(submit).toBeDisabled()

    // Existing accounts may have a pre-policy password, so sign in must not enforce length.
    await userEvent.type(screen.getByLabelText('Password'), 'old')
    expect(submit).toBeEnabled()
  })

  it('calls signIn with the entered credentials', async () => {
    render(<LoginPage />)
    await userEvent.type(screen.getByLabelText('Email'), 'demo@pocketlens.app')
    await userEvent.type(screen.getByLabelText('Password'), 'demofinance123')
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }))
    expect(signIn).toHaveBeenCalledWith('demo@pocketlens.app', 'demofinance123')
  })

  it('requires first + last name and a policy password on sign up, passing names as metadata', async () => {
    render(<LoginPage />)
    await userEvent.click(screen.getByRole('tab', { name: /sign up/i }))

    const submit = screen.getByRole('button', { name: /create account/i })
    await userEvent.type(screen.getByLabelText('Email'), 'new@pocketlens.app')

    // A weak password (no uppercase/symbol) keeps submit disabled even with names filled.
    await userEvent.type(screen.getByLabelText('Password'), 'weakpassword1')
    await userEvent.type(screen.getByLabelText('First name'), 'Jane')
    await userEvent.type(screen.getByLabelText('Last name'), 'Doe')
    await userEvent.type(screen.getByLabelText('Confirm password'), 'weakpassword1')
    expect(submit).toBeDisabled()

    // Upgrade to a policy-compliant password in both fields.
    await userEvent.clear(screen.getByLabelText('Password'))
    await userEvent.type(screen.getByLabelText('Password'), VALID_PW)
    await userEvent.clear(screen.getByLabelText('Confirm password'))
    await userEvent.type(screen.getByLabelText('Confirm password'), VALID_PW)
    expect(submit).toBeEnabled()

    await userEvent.click(submit)
    expect(signUp).toHaveBeenCalledWith('new@pocketlens.app', VALID_PW, {
      firstName: 'Jane',
      lastName: 'Doe',
    })
  })

  it('sends a reset link from the forgot-password view with only an email', async () => {
    render(<LoginPage />)
    await userEvent.click(screen.getByRole('button', { name: /forgot password/i }))

    // No password field in forgot mode.
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument()

    const submit = screen.getByRole('button', { name: /send reset link/i })
    expect(submit).toBeDisabled()

    await userEvent.type(screen.getByLabelText('Email'), 'lockedout@pocketlens.app')
    expect(submit).toBeEnabled()

    await userEvent.click(submit)
    expect(resetPassword).toHaveBeenCalledWith('lockedout@pocketlens.app')
    expect(await screen.findByText(/reset link is on its way/i)).toBeInTheDocument()
  })
})
