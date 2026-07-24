// Per-user data isolation — the "fresh account must never see another user's
// data" guarantee, exercised through the real UI against a clean local stack
// (all migrations applied by `supabase start`).

import { test, expect } from '@playwright/test'
import {
  HAS_LOCAL_STACK,
  OWNER,
  FRIEND,
  OWNER_TXN,
  OWNER_ACCOUNT,
  createUser,
  seedOwnerData,
  signInViaUI,
} from './local-helpers'

test.describe('data isolation', () => {
  test.skip(!HAS_LOCAL_STACK, 'local stack env not set — run via e2e/run-local.sh')
  test.describe.configure({ mode: 'serial' })

  test.beforeAll(async () => {
    const ownerId = await createUser(OWNER)
    await createUser(FRIEND)
    await seedOwnerData(ownerId)
  })

  test('owner signs in and sees their own data', async ({ page }) => {
    await signInViaUI(page, OWNER)

    await page.getByRole('link', { name: 'Settings' }).click()
    await expect(page.getByText(OWNER.email)).toBeVisible()

    await page.getByRole('link', { name: 'Transactions' }).click()
    await expect(page.getByText(OWNER_TXN).first()).toBeVisible({ timeout: 15_000 })
  })

  test('fresh user sees the right account and NONE of the owner data', async ({ page }) => {
    await signInViaUI(page, FRIEND)

    // Right account shown.
    await page.getByRole('link', { name: 'Settings' }).click()
    await expect(page.getByText(FRIEND.email)).toBeVisible()
    await expect(page.getByText(OWNER.email)).toHaveCount(0)

    // No owner transactions.
    await page.getByRole('link', { name: 'Transactions' }).click()
    await expect(page.getByText('Spent')).toBeVisible({ timeout: 15_000 })
    await expect(page.getByText(OWNER_TXN)).toHaveCount(0)

    // No owner accounts.
    await page.getByRole('link', { name: 'Balances' }).click()
    await expect(page.getByRole('main').getByText('Total Net Worth')).toBeVisible({ timeout: 15_000 })
    await expect(page.getByText(OWNER_ACCOUNT)).toHaveCount(0)
  })

  test('same-tab account switch leaves no cached residue', async ({ page }) => {
    // Populate the query cache as the owner…
    await signInViaUI(page, OWNER)
    await page.getByRole('link', { name: 'Transactions' }).click()
    await expect(page.getByText(OWNER_TXN).first()).toBeVisible({ timeout: 15_000 })

    // …switch to the friend in the SAME tab…
    await page.getByRole('link', { name: 'Settings' }).click()
    await page.getByRole('button', { name: 'Sign out' }).click()
    // Signing out lands on the demo landing page, not a bare login form.
    await expect(page.getByRole('link', { name: 'Log in' })).toBeVisible()
    await signInViaUI(page, FRIEND)

    // …and the owner's rows must be gone everywhere.
    await page.getByRole('link', { name: 'Transactions' }).click()
    await expect(page.getByText('Spent')).toBeVisible({ timeout: 15_000 })
    await expect(page.getByText(OWNER_TXN)).toHaveCount(0)

    await page.getByRole('link', { name: 'Settings' }).click()
    await expect(page.getByText(FRIEND.email)).toBeVisible()
  })
})
