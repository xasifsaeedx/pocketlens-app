// Drop-in replacement for React Query's `useMutation` that is inert in demo mode.
//
// The demo is read-only: every write (categorize, tag, split, transfer, budget edit,
// bank connect, settings change) opens the sign-up dialog instead of running. Swapping
// this in at the import site of `data/hooks.ts` (and the two pages that declare their
// own mutations) gates all of them at once — no per-mutation opt-in to forget.

import {
  useMutation as useReactQueryMutation,
  type DefaultError,
  type UseMutationOptions,
  type UseMutationResult,
} from '@tanstack/react-query'
import { isDemoMode } from './demoMode'
import { DEMO_BLOCKED_MESSAGE, promptDemoSignup } from './demoPrompt'

export function useMutation<TData = unknown, TError = DefaultError, TVariables = void, TContext = unknown>(
  options: UseMutationOptions<TData, TError, TVariables, TContext>,
): UseMutationResult<TData, TError, TVariables, TContext> {
  const gated: UseMutationOptions<TData, TError, TVariables, TContext> = isDemoMode()
    ? {
        mutationKey: options.mutationKey,
        // Reject rather than hang: a never-settling mutation would leave the calling
        // button stuck in its pending state behind the dialog.
        mutationFn: () => {
          promptDemoSignup()
          return Promise.reject(new Error(DEMO_BLOCKED_MESSAGE))
        },
        // Drop the real callbacks — onSuccess would invalidate seeded cache entries
        // and refetch them (against the stubbed client) into empty pages.
        retry: false,
      }
    : options

  return useReactQueryMutation(gated)
}
