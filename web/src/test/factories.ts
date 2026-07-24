// Shared test factories for domain objects.

import type { Category, CategoryRule, Transaction } from '@/types/domain'

export function makeCategory(p: Partial<Category> = {}): Category {
  return {
    id: 'cat-1',
    name: 'Groceries',
    color: '#34C759',
    icon: 'cart.fill',
    parent_id: null,
    sort_order: 0,
    kind: 'spend',
    ...p,
  }
}

export function makeTxn(p: Partial<Transaction> = {}): Transaction {
  return {
    id: 't-1',
    plaid_transaction_id: 'p-1',
    account_id: 'a-1',
    date: '2026-06-15',
    authorized_date: null,
    effective_date: '2026-06-15',
    amount: 42.5,
    merchant_name: 'Whole Foods',
    description: null,
    plaid_category: null,
    plaid_category_detail: null,
    category_id: null,
    notes: null,
    pending: false,
    exclude_from_totals: false,
    transfer_group_id: null,
    transfer_kind: null,
    transfer_opt_out: false,
    hidden: false,
    is_reimbursement: false,
    merchant_city: null,
    merchant_region: null,
    merchant_country: null,
    merchant_postal_code: null,
    merchant_store_number: null,
    merchant_lat: null,
    merchant_lon: null,
    iso_currency_code: null,
    ...p,
  }
}

export function makeRule(p: Partial<CategoryRule> = {}): CategoryRule {
  return {
    id: 'rule-1',
    keyword: 'Whole Foods',
    category_id: 'cat-1',
    direction: null,
    min_amount: null,
    max_amount: null,
    set_reimbursement: false,
    ...p,
  }
}
