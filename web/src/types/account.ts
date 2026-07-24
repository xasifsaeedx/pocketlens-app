export interface AccountOut {
  id: number
  name: string
  type: string
  currency: string
  created_at?: string | null
  is_linked?: boolean
  provider?: string | null
  external_id?: string | null
  institution_name?: string | null
  last_synced_at?: string | null
  reported_balance?: number | null
  reported_balance_at?: string | null
  /** Display balance (matches account detail / summary). */
  balance: number
  /** Sub-account is Robinhood crypto (positions-only; no cash in totals). */
  is_robinhood_crypto?: boolean
  /** Included in zero-based budgeting liquid pool. */
  is_budget_account?: boolean
}

/** Response from GET /api/accounts/{id}/summary */
export interface AccountSummaryOut {
  account_id: number
  balance: number
  ledger_balance: number
}

