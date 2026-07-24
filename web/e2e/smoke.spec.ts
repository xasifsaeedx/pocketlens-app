// Core happy-path smoke, run hermetically against a clean local stack (all
// migrations applied by `supabase start`). Seeds its OWN user + account + txns
// via the service role (distinct from the isolation suite's OWNER — see SMOKE
// in local-helpers), then asserts on the SEEDED fixtures — never prod data.

import { test, expect } from '@playwright/test'
import {
  HAS_LOCAL_STACK,
  SMOKE,
  SMOKE_TXN,
  SMOKE_ACCOUNT,
  createUser,
  seedOwnerData,
  signInViaUI,
} from './local-helpers'

test.describe('smoke', () => {
  test.skip(!HAS_LOCAL_STACK, 'local stack env not set — run via e2e/run-local.sh')

  test.beforeAll(async () => {
    const smokeId = await createUser(SMOKE)
    await seedOwnerData(smokeId, {
      keySuffix: 'smoke',
      accountName: SMOKE_ACCOUNT,
      txnMarker: SMOKE_TXN,
    })
  })

  test('sign in shows the dashboard with seeded data', async ({ page }) => {
    await signInViaUI(page, SMOKE)
    // A currency figure should render in the safe-to-spend card.
    await expect(page.getByText(/\$[\d,]+\.\d{2}/).first()).toBeVisible()
  })

  test('transactions page shows month totals and seeded rows', async ({ page }) => {
    await signInViaUI(page, SMOKE)
    await page.getByRole('link', { name: 'Transactions' }).click()
    // Scope to the month-summary aside — "Income" (and "Spent") also appear as
    // category labels on transaction rows, which would make a bare getByText ambiguous.
    const summary = page.getByRole('complementary')
    await expect(summary.getByText('Spent')).toBeVisible()
    await expect(summary.getByText('Income')).toBeVisible()
    await expect(page.getByText(SMOKE_TXN).first()).toBeVisible({ timeout: 15_000 })
  })

  test('accounts page shows grouped balances and net worth', async ({ page }) => {
    await signInViaUI(page, SMOKE)
    await page.getByRole('link', { name: 'Balances' }).click()
    await expect(page.getByRole('main').getByText('Total Net Worth')).toBeVisible({ timeout: 20_000 })
    await expect(page.getByText(SMOKE_ACCOUNT)).toBeVisible({ timeout: 20_000 })
  })

  test('net worth trend renders on the Balances page', async ({ page }) => {
    await signInViaUI(page, SMOKE)
    // The standalone /net-worth route was removed; the trend chart and its range
    // selector now live on the Balances page (primaryNav "Balances" → /accounts).
    await page.getByRole('link', { name: 'Balances' }).click()
    await expect(page).toHaveURL(/\/accounts$/)
    // The range-selector buttons always render regardless of snapshot history.
    await expect(page.getByRole('button', { name: '1Y' })).toBeVisible({ timeout: 20_000 })
  })

  test('sign out returns to the demo landing page', async ({ page }) => {
    await signInViaUI(page, SMOKE)
    await page.getByRole('link', { name: 'Settings' }).click()
    await page.getByRole('button', { name: 'Sign out' }).click()
    // Signing out lands on the demo landing page, not a bare login form.
    await expect(page.getByRole('link', { name: 'Log in' })).toBeVisible()
    // "Recent Activity" only renders in the authenticated dashboard — confirms the app
    // is back on the login screen with no dashboard content visible.
    await expect(page.getByText('Recent Activity')).toBeHidden()
  })
})
