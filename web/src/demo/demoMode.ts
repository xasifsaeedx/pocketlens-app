// Demo mode flag — the logged-out landing page renders the real app against
// hard-coded fixtures (see demoData.ts) instead of a login wall.
//
// A module-level flag rather than React context because two non-React seams need it:
// the Supabase client guard (lib/supabase.ts) and the mutation gate (demo/demoGate.tsx).
// It is set once, before the demo tree renders, and only when there is no session — a
// signed-in user never enters demo mode, so the real client is never shadowed.

let demoMode = false

export function setDemoMode(on: boolean): void {
  demoMode = on
}

export function isDemoMode(): boolean {
  return demoMode
}
