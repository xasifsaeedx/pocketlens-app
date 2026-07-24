// Demo landing page — the one runnable check behind the demo path.
//
// Unlike the other specs, this one needs NO backend: the whole point of the demo is
// that a logged-out visitor sees a furnished app without a single database call. The
// spec asserts exactly that (no PostgREST/RPC traffic), that every nav destination
// renders without an error state, and that the sign-up routes are reachable.

import { expect, test, type Page, type Request } from '@playwright/test'

/** Requests that would mean the demo leaked to the database. */
function isDatabaseRequest(request: Request): boolean {
  const url = request.url()
  return url.includes('/rest/v1/') || url.includes('/functions/v1/')
}

async function trackDatabaseRequests(page: Page): Promise<string[]> {
  const leaked: string[] = []
  page.on('request', (request) => {
    if (isDatabaseRequest(request)) leaked.push(request.url())
  })
  return leaked
}

// `money: true` = the page's whole job is showing figures, so an empty one is a
// seeding failure rather than a legitimately quiet screen (Settings, Activity).
const NAV = [
  { path: '/', heading: /recent activity/i, money: true },
  { path: '/accounts', heading: /balances/i, money: true },
  { path: '/transactions', heading: /transactions/i, money: true },
  { path: '/budgets', heading: /budget/i, money: true },
  // Explore stays blank until the user runs a search — same as the signed-in app.
  { path: '/explore', heading: /explore/i, money: false },
  { path: '/recurring', heading: /recurring charges/i, money: true },
  { path: '/activity', heading: /activity/i, money: false },
  // Settings leads with the profile card — "McLovin" is the seeded demo profile.
  { path: '/settings', heading: /mclovin|settings/i, money: false },
]

test.describe('demo landing page', () => {
  test('renders every page from fixtures without touching the database', async ({ page }) => {
    const leaked = await trackDatabaseRequests(page)

    for (const { path, heading, money } of NAV) {
      await page.goto(path)
      // The demo marker is in the sticky top bar on every in-app page.
      await expect(page.getByText('Demo', { exact: true })).toBeVisible()
      await expect(page.getByRole('heading', { name: heading }).first()).toBeVisible()
      // No page should land in an error state.
      await expect(page.getByText(/something went wrong|failed to load/i)).toHaveCount(0)
      if (money) {
        await expect(page.getByText(/\$[\d,]+/).first(), `no money shown on ${path}`).toBeVisible()
      }
    }

    expect(leaked, `demo hit the database: ${leaked.join(', ')}`).toEqual([])
  })

  test('Explore aggregates the fixtures without a database', async ({ page }) => {
    const leaked = await trackDatabaseRequests(page)
    await page.goto('/explore')
    await page.getByRole('button', { name: 'Search' }).click()
    await expect(page.getByText(/\$[\d,]+/).first()).toBeVisible()
    expect(leaked, `Explore hit the database: ${leaked.join(', ')}`).toEqual([])
  })

  test('a write opens the sign-up prompt instead of saving', async ({ page }) => {
    const leaked = await trackDatabaseRequests(page)
    await page.goto('/recurring')
    // "Ignore" on a detected series is a one-click mutation in the real app.
    await page.getByRole('button', { name: /ignore/i }).first().click()
    await expect(page.getByRole('dialog')).toContainText(/create an account/i)
    await page.getByRole('button', { name: /sign up free/i }).click()
    await expect(page).toHaveURL(/\/signup$/)
    expect(leaked, `a blocked write still reached the database: ${leaked.join(', ')}`).toEqual([])
  })

  test('shows fixture data, not an empty state', async ({ page }) => {
    await page.goto('/')
    // Merchants come from demoData.ts — an empty dashboard would pass a laxer check.
    await expect(page.getByText(/blank street|trader joe|sweetgreen|erewhon/i).first()).toBeVisible()
  })

  test('sign up and log in are one click from the demo', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('link', { name: 'Sign up' }).click()
    await expect(page).toHaveURL(/\/signup$/)
    await expect(page.getByRole('heading', { name: /create your account/i })).toBeVisible()

    await page.goto('/')
    await page.getByRole('link', { name: 'Log in' }).click()
    await expect(page).toHaveURL(/\/login$/)
    await expect(page.getByRole('heading', { name: /welcome back/i })).toBeVisible()
  })
})
