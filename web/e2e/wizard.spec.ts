// Guided Plaid onboarding wizard (/onboard) + the /link dead-end, end to end:
// web Settings → Guided setup → backend-hosted wizard, with per-account state.
//
// NOT hermetic — excluded from CI (web-tests.yml runs only smoke/isolation/signup).
// This needs the Python sync-service on :8000 AND makes a real Plaid API call, so
// it can't run against just `supabase start`. Run it locally via e2e/run-local.sh.
// Standing it up in CI (backend + a mocked/real Plaid) is a separate follow-up.

import { test, expect } from '@playwright/test'
import {
  HAS_LOCAL_STACK,
  BACKEND_URL,
  RUN,
  FAKE_CLIENT_ID,
  createUser,
  seedPlaidCredentials,
  accessTokenFor,
  signInViaUI,
} from './local-helpers'

const NEWBIE = { email: `wizard-new-${RUN}@e2e.local`, password: 'wizard-pass-4!' }
const CONFIGURED = { email: `wizard-cfg-${RUN}@e2e.local`, password: 'wizard-pass-5!' }

test.describe('onboarding wizard', () => {
  test.skip(!HAS_LOCAL_STACK, 'local stack env not set — run via e2e/run-local.sh')
  test.describe.configure({ mode: 'serial' })

  test.beforeAll(async () => {
    await createUser(NEWBIE)
    const configuredId = await createUser(CONFIGURED)
    await seedPlaidCredentials(configuredId)
  })

  test('Guided setup opens the wizard on step 1 for a fresh user', async ({ page }) => {
    await signInViaUI(page, NEWBIE)
    await page.getByRole('link', { name: 'Settings' }).click()

    const [wizard] = await Promise.all([
      page.context().waitForEvent('page'),
      page.getByRole('button', { name: 'Guided setup' }).click(),
    ])
    await wizard.waitForLoadState()

    expect(wizard.url()).toContain('/onboard')
    await expect(wizard.getByRole('heading', { name: 'Connect your banks' })).toBeVisible()
    // Fresh user: step 1 expanded, no "already connected" banner.
    await expect(wizard.locator('#step1')).toHaveClass(/open/)
    await expect(wizard.locator('#banner')).toBeHidden()
    // Signup cheat-sheet matches the real dashboard flow.
    await expect(wizard.getByText('Personal use — I want to use Plaid')).toBeVisible()
    await expect(wizard.getByText('Personal finances')).toBeVisible()
  })

  test('paste box rejects garbage with a specific message', async ({ page }) => {
    await signInViaUI(page, NEWBIE)
    await page.getByRole('link', { name: 'Settings' }).click()
    const [wizard] = await Promise.all([
      page.context().waitForEvent('page'),
      page.getByRole('button', { name: 'Guided setup' }).click(),
    ])
    await wizard.waitForLoadState()

    await wizard.locator('#step3 .step-head').click()
    await wizard.locator('#rawKeys').fill('hello, no keys in here at all')
    await wizard.getByRole('button', { name: 'Verify & save' }).click()
    await expect(wizard.locator('#keysError')).toContainText("Couldn't find a client ID", {
      timeout: 15_000,
    })
  })

  test('well-formed but invalid keys surface a clean Plaid rejection', async ({ page }) => {
    await signInViaUI(page, NEWBIE)
    await page.getByRole('link', { name: 'Settings' }).click()
    const [wizard] = await Promise.all([
      page.context().waitForEvent('page'),
      page.getByRole('button', { name: 'Guided setup' }).click(),
    ])
    await wizard.waitForLoadState()

    await wizard.locator('#step3 .step-head').click()
    await wizard
      .locator('#rawKeys')
      .fill(`client_id ${'0'.repeat(24)} production secret ${'1'.repeat(30)}`)
    await wizard.getByRole('button', { name: 'Verify & save' }).click()
    // Real probe against Plaid with garbage creds → specific, actionable error.
    const err = wizard.locator('#keysError')
    await expect(err).toBeVisible({ timeout: 30_000 })
    await expect(err).toContainText(/did not recognize|rejected these credentials/)
  })

  test('configured user sees their account state, not a blank wizard', async ({ page }) => {
    // A configured user's Settings card shows status (no Guided-setup button),
    // so open the wizard directly — the same way iOS always reaches it.
    const token = await accessTokenFor(CONFIGURED)
    const wizard = page
    // Token rides in the URL fragment, not a query param — the shell's
    // JS reads it from location.hash and fetches /credentials for status.
    await wizard.goto(`${BACKEND_URL}/onboard#access_token=${encodeURIComponent(token)}`)

    // Banner reflects THIS account's credentials (masked client_id + slots).
    const banner = wizard.locator('#banner')
    await expect(banner).toBeVisible()
    await expect(banner).toContainText('Plaid account connected')
    await expect(banner).toContainText(`${FAKE_CLIENT_ID.slice(0, 4)}…${FAKE_CLIENT_ID.slice(-4)}`)
    await expect(banner).toContainText('0 of 10 banks linked')
    // Keys steps marked done; flow parked on the link step.
    await expect(wizard.locator('#step1')).toHaveClass(/done/)
    await expect(wizard.locator('#step2')).toHaveClass(/done/)
    await expect(wizard.locator('#step3')).toHaveClass(/done/)
  })

  test('/link without credentials dead-ends into the wizard, not a wall', async ({ page }) => {
    // /link is now a static shell: it reads the fragment token, POSTs to
    // /link/prepare, and — for a user with no Plaid creds — renders the
    // "start guided setup" prompt client-side. Drive it in the browser.
    const token = await accessTokenFor(NEWBIE)
    await page.goto(`${BACKEND_URL}/link#access_token=${encodeURIComponent(token)}`)

    const guided = page.getByRole('link', { name: 'Start guided setup' })
    await expect(guided).toBeVisible()
    // Onward link keeps the token in the fragment, never a query param.
    await expect(guided).toHaveAttribute('href', /\/onboard#access_token=/)
  })
})
