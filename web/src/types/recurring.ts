export type RecurringOccurrenceOut = {
  transaction_id: number
  date: string
  amount: number
  merchant: string
  category_id: number | null
  category_name: string | null
  subcategory_id: number | null
  subcategory_name: string | null
}

export type RecurringSeriesActionIn = {
  merchant_norm: string
  amount_anchor_cents: number
}

