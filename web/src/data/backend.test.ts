import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { warmFetch, isTrustedMessageOrigin } from './backend'

const URL = 'https://api.test/health'

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function mockFetch(...responses: Array<Response | Error>) {
  let i = 0
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    const r = responses[Math.min(i++, responses.length - 1)]
    if (r instanceof Error) throw r
    return r
  })
}

const ok = () => new Response('{}', { status: 200 })
const status = (code: number) => new Response('', { status: code })

describe('warmFetch', () => {
  it('retries through a cold-start 502 and returns the eventual 200', async () => {
    const fetchMock = mockFetch(status(502), status(503), ok())
    const p = warmFetch(URL)
    await vi.runAllTimersAsync()
    const res = await p
    expect(res.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('retries through a network throw (server still cold)', async () => {
    const fetchMock = mockFetch(new TypeError('Failed to fetch'), ok())
    const p = warmFetch(URL)
    await vi.runAllTimersAsync()
    await expect(p).resolves.toHaveProperty('status', 200)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('returns a real 4xx immediately without retrying', async () => {
    const fetchMock = mockFetch(status(401), ok())
    const p = warmFetch(URL)
    await vi.runAllTimersAsync()
    const res = await p
    expect(res.status).toBe(401)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('throws after exhausting all tries', async () => {
    const fetchMock = mockFetch(status(502))
    const p = warmFetch(URL, undefined, 3)
    const assertion = expect(p).rejects.toThrow('HTTP 502')
    await vi.runAllTimersAsync()
    await assertion
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })
})

describe('isTrustedMessageOrigin', () => {
  // Vitest env sets VITE_BACKEND_URL=http://localhost:8000 → BACKEND_ORIGIN.
  it('accepts the backend origin (backend-hosted Plaid /link page)', () => {
    expect(isTrustedMessageOrigin('http://localhost:8000')).toBe(true)
  })

  it('accepts our own origin (same-origin messages)', () => {
    expect(isTrustedMessageOrigin(window.location.origin)).toBe(true)
  })

  it('rejects an arbitrary/foreign origin', () => {
    expect(isTrustedMessageOrigin('https://evil.example.com')).toBe(false)
  })

  it('rejects a blank origin', () => {
    expect(isTrustedMessageOrigin('')).toBe(false)
  })
})
