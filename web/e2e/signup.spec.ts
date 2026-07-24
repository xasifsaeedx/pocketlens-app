// Signup through the real UI (local stack has email confirmations OFF, so a
// session is returned immediately — the prod confirm-email flow is config,
// not code).

import { test, expect } from '@playwright/test'
import { HAS_LOCAL_STACK, RUN } from './local-helpers'

test.describe('signup', () => {
  test.skip(!HAS_LOCAL_STACK, 'local stack env not set — run via e2e/run-local.sh')

  test('new user signs up, lands on Settings with the setup wizard spotlighted', async ({
    page,
  }) => {
    const email = `signup-${RUN}@e2e.local`

    // `/` is the demo landing page when logged out; sign-up lives at /signup.
    await page.goto('/signup')
    // First/last name are required — the Create account button stays disabled until filled.
    await page.getByLabel('First name').fill('E2e')
    await page.getByLabel('Last name').fill('Tester')
    await page.getByLabel('Email').fill(email)
    await page.getByLabel('Password', { exact: true }).fill('Signup-pass-3!')
    await page.getByLabel('Confirm password').fill('Signup-pass-3!')
    await page.getByRole('button', { name: 'Create account' }).click()

    // Fresh signups skip the empty dashboard: straight to Settings with the
    // bank-connection card highlighted and the wizard one click away.
    await page.waitForURL(/\/settings\?setup=1/, { timeout: 20_000 })
    await expect(page.getByText('Start here — connect your banks')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Guided setup' })).toBeVisible()

    // Signed in as the account just created.
    await expect(page.getByText(email)).toBeVisible()
  })
})
