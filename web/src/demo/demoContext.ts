// Demo context, split from DemoApp.tsx so shared chrome (TopAppBar) can read it without
// importing a module that also exports components (react-refresh/only-export-components).

import { createContext, useContext } from 'react'

export interface DemoContextValue {
  /** True inside the demo tree — lets shared chrome swap its account controls for
   *  Log in / Sign up. */
  demo: true
  showSignup: () => void
}

export const DemoContext = createContext<DemoContextValue | null>(null)

/** Null outside the demo tree, so the signed-in app is unaffected. */
export function useDemo(): DemoContextValue | null {
  return useContext(DemoContext)
}
