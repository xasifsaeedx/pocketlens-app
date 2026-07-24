import { defineConfig, devices } from '@playwright/test'

// E2E runs the real Vite dev server against a LOCAL Supabase stack (`supabase
// start`), seeding its own users/data via the service role — never prod. The
// stack's keys are injected through env (VITE_* for the dev server, E2E_* for
// the seeding helpers); see e2e/run-local.sh for the local recipe. Specs
// self-skip when the stack env is absent.
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:5173',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
})
