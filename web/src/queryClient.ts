import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query'

// Keep server-ish state fresh long enough to avoid “refetch on every click”
// while still updating after mutations via query invalidation.
// Query/mutation failures are handled per-component (toasts); log them here too,
// since caught errors never reach the boundary.
const queryClient = new QueryClient({
  queryCache: new QueryCache({
    onError: (error, query) => {
      console.error('query error', query.queryKey, error)
    },
  }),
  mutationCache: new MutationCache({
    onError: (error, _variables, _context, mutation) => {
      console.error('mutation error', mutation.options.mutationKey, error)
    },
  }),
  defaultOptions: {
    queries: {
      staleTime: 60_000,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
})

export default queryClient

