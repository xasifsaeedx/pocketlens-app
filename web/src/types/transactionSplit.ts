export interface TransactionSplitOut {
  id: number
  category_id: number
  category_name: string | null
  subcategory_id: number
  subcategory_name: string | null
  amount: number
  notes: string | null
}

export interface TransactionSplitIn {
  category_id: number
  subcategory_id: number
  amount: number
  notes: string | null
}

