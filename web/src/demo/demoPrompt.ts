// Tiny pub/sub so non-React code (the mutation gate) can open the demo's
// "create an account" dialog. One listener: the DemoProvider that renders it.

type Listener = (reason: string | null) => void

let listener: Listener | null = null

export function setDemoPromptListener(next: Listener | null): void {
  listener = next
}

/** Ask the demo shell to show the sign-up prompt. No-op outside the demo tree. */
export function promptDemoSignup(reason: string | null = null): void {
  listener?.(reason)
}

/** Message shown when a write is blocked — also the rejection reason, so a caller
 *  that surfaces mutation errors in a toast says the same thing as the dialog. */
export const DEMO_BLOCKED_MESSAGE = 'Create a free account to save changes.'
