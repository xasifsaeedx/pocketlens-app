// Password policy — mirrors the Supabase Auth requirement (min length + character
// complexity) enabled in the dashboard.
// Kept in one place so signup and password-reset validate identically; the server is
// still the source of truth and its error surfaces if this ever drifts.

export const PASSWORD_MIN_LENGTH = 10

// Human-readable rule, shown as a hint next to password fields.
export const PASSWORD_RULE =
  'At least 10 characters, including uppercase, lowercase, a number, and a symbol.'

/**
 * Returns an error message if the password fails policy, or null if it passes.
 */
export function validatePassword(pw: string): string | null {
  if (pw.length < PASSWORD_MIN_LENGTH) {
    return `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`
  }
  if (!/[a-z]/.test(pw)) return 'Password needs a lowercase letter.'
  if (!/[A-Z]/.test(pw)) return 'Password needs an uppercase letter.'
  if (!/[0-9]/.test(pw)) return 'Password needs a number.'
  if (!/[^A-Za-z0-9]/.test(pw)) return 'Password needs a symbol.'
  return null
}

export function isValidPassword(pw: string): boolean {
  return validatePassword(pw) === null
}
