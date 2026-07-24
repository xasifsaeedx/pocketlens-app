import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useDebouncedValue } from './use-debounce'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

it('returns the initial value immediately, then trails changes by the delay', () => {
  const { result, rerender } = renderHook(({ v }) => useDebouncedValue(v, 250), {
    initialProps: { v: 'a' },
  })
  expect(result.current).toBe('a')

  rerender({ v: 'ab' })
  expect(result.current).toBe('a')
  act(() => vi.advanceTimersByTime(200))
  expect(result.current).toBe('a')

  // another change resets the timer
  rerender({ v: 'abc' })
  act(() => vi.advanceTimersByTime(200))
  expect(result.current).toBe('a')
  act(() => vi.advanceTimersByTime(50))
  expect(result.current).toBe('abc')
})
