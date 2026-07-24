// Single source of truth for budget-pace status, so the pace WORD (label + text color)
// and the progress BAR color always agree. Uses only existing semantic tokens — sage
// (secondary/success) for on-track, amber (warning) approaching the limit, red
// (destructive) once over — never a new hue.

export interface BudgetPace {
  status: 'under' | 'warning' | 'over'
  /** Tailwind text-color class for the pace label / number. */
  textClass: string
  /** Tailwind background-color class for the progress-bar fill. */
  barClass: string
  /** Human-readable pace word. */
  label: string
}

/**
 * Classify spend against a budget on a tiered ramp:
 *   - `over`    — spent exceeds budget (> 100%)
 *   - `warning` — 85%–100% of budget (approaching the limit)
 *   - `under`   — below 85%, comfortably on track
 *
 * A non-positive budget is treated as "over" whenever anything has been spent (there is
 * no headroom), otherwise "under".
 */
export function budgetPaceStatus(spent: number, budget: number): BudgetPace {
  const ratio = budget > 0 ? spent / budget : spent > 0 ? Infinity : 0

  if (ratio > 1) {
    return {
      status: 'over',
      textClass: 'text-destructive',
      barClass: 'bg-destructive',
      label: 'Over budget',
    }
  }
  if (ratio >= 0.85) {
    return {
      status: 'warning',
      textClass: 'text-warning',
      barClass: 'bg-warning',
      label: 'Nearing limit',
    }
  }
  return {
    status: 'under',
    textClass: 'text-secondary',
    barClass: 'bg-secondary',
    label: 'On track',
  }
}
