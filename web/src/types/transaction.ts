export interface TransactionOut {
  id: number
  date: string
  amount: number
  merchant: string
  notes: string | null

  account_id: number | null
  account_name: string | null

  category_id: number | null
  category_name: string | null

  subcategory_id: number | null
  subcategory_name: string | null

  tag_ids: number[]
  tag_names: string[]

  is_transfer: boolean
  has_splits: boolean
  transfer_group_id: number | null
}

