// Reaching the Render backend (pocketlens-api) through its cold start. On the free
// tier the service spins down after ~15 min idle and cold-starts on the next hit,
// which can take ~30-50s or bounce a 502/503/504 — so the *first* action after a
// lull "bugs out" and the retry works. Two tactics kill that first-hit failure
// without keeping the dyno warm 24/7 (which would blow the free instance-hour cap):
//   • prewarm() — fire once on app boot so the server is usually up by the time the
//     user actually clicks something.
//   • warmFetch() / openWarmTab() — ride out the cold-start window at the call site.

const BACKEND = import.meta.env.VITE_BACKEND_URL as string

/** Origin of the backend, for validating postMessage events from backend-hosted
 *  pages (e.g. the Plaid Link /link tab, which postMessages PLAID_LINK_SUCCESS).
 *  Empty string if VITE_BACKEND_URL is unset/malformed — an empty origin never
 *  matches a real event.origin, so messages are rejected rather than trusted. */
export const BACKEND_ORIGIN = (() => {
  try {
    return new URL(BACKEND).origin
  } catch {
    return ''
  }
})()

/** True only for postMessage events whose origin we trust: the backend-hosted
 *  pages (BACKEND_ORIGIN) or our own origin. A blank origin is never trusted,
 *  so an unset/malformed VITE_BACKEND_URL cannot accidentally allow one. */
export function isTrustedMessageOrigin(origin: string): boolean {
  return origin !== '' && (origin === BACKEND_ORIGIN || origin === window.location.origin)
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// Only these signal "server still spinning up" — a real 4xx/app-5xx returns at once.
const COLD_START_STATUS = new Set([502, 503, 504])

/** fetch with backoff retry across the cold-start window. Retries only on a network
 *  throw or a 502/503/504; any other response (including a real 4xx/5xx) returns
 *  immediately. Safe only for idempotent or fire-and-kick calls (e.g. /sync/trigger,
 *  /health) — do not wrap non-idempotent mutations. */
export async function warmFetch(
  input: string,
  init?: RequestInit,
  tries = 4,
): Promise<Response> {
  let lastErr: unknown
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(input, init)
      if (!COLD_START_STATUS.has(res.status)) return res
      lastErr = new Error(`HTTP ${res.status}`)
    } catch (e) {
      lastErr = e // network error / timeout — server likely still cold
    }
    if (i < tries - 1) await sleep(2000 * (i + 1)) // 2s, 4s, 6s
  }
  throw lastErr ?? new Error('Backend unreachable')
}

/** Wake the backend and resolve once /health answers. Safe to call repeatedly. */
export async function warm(): Promise<void> {
  await warmFetch(`${BACKEND}/health`)
}

/** Fire-and-forget wake on app boot — hides the cold start behind the user's
 *  browsing time so their first real backend action lands warm. */
export function prewarm(): void {
  warm().catch(() => {})
}

/** Popup-blocker-safe open of a backend-hosted page (/link, /onboard) through the
 *  cold-start window. The tab must open inside the click gesture, but the server may
 *  be ~30s from ready — so open a placeholder tab synchronously, warm the server,
 *  then navigate the tab to the resolved URL. */
export async function openWarmTab(resolveUrl: () => Promise<string>): Promise<void> {
  const tab = window.open('', '_blank')
  if (tab) {
    tab.document.write(
      '<!doctype html><title>Connecting…</title>' +
        '<body style="font:16px system-ui,sans-serif;padding:2rem;color:#444">Waking server…</body>',
    )
  }
  try {
    await warm()
    const url = await resolveUrl()
    if (tab) tab.location.replace(url)
    else window.open(url, '_blank', 'noopener,noreferrer') // popup blocked — best effort
  } catch (e) {
    tab?.close()
    throw e
  }
}
