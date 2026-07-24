// Port of PocketLens/Services/CategorySuggester.swift — keep in lockstep with iOS so the
// swipe-review suggestions match. Precedence (specificity wins):
//   learned merchant memory -> keyword rule (longest match) -> income by sign
//   -> Plaid PFC detailed map -> Plaid PFC primary map -> (suggest) fallback "Other".

import type { Category, CategoryRule, Transaction, UUID } from '@/types/domain'
import { merchantKey } from '@/types/domain'

// Plaid PFC detailed -> our category name (finer than primary; checked first).
const detailMap: Record<string, string> = {
  FOOD_AND_DRINK_GROCERIES: 'Groceries',
  FOOD_AND_DRINK_RESTAURANT: 'Dining',
  FOOD_AND_DRINK_FAST_FOOD: 'Dining',
  FOOD_AND_DRINK_COFFEE: 'Dining',
  FOOD_AND_DRINK_BEER_WINE_AND_LIQUOR: 'Dining',
  TRANSPORTATION_TAXIS_AND_RIDE_SHARES: 'Transport',
  TRANSPORTATION_PUBLIC_TRANSIT: 'Transport',
  TRANSPORTATION_GAS: 'Transport',
  RENT_AND_UTILITIES_RENT: 'Rent',
}

// Plaid PFC primary -> our category name.
const plaidMap: Record<string, string> = {
  INCOME: 'Income',
  TRANSFER_IN: 'Income',
  FOOD_AND_DRINK: 'Dining',
  TRANSPORTATION: 'Transport',
  TRAVEL: 'Transport',
  RENT_AND_UTILITIES: 'Utilities',
}

/** Does a conditional rule fire on this txn? ALL present conditions must pass:
 *  keyword substring (required), then optionally money direction and amount
 *  magnitude. Sign convention: amount POSITIVE = spend/outflow, NEGATIVE =
 *  money-in/inflow, so 'in' ⇔ amount < 0 and 'out' ⇔ amount > 0; the min/max
 *  bounds compare against ABS(amount), inclusive. Mirrors Swift
 *  CategorySuggester.ruleMatches + backend categorizer._rule_matches. */
export function ruleMatches(rule: CategoryRule, txn: Transaction): boolean {
  if (!rule.keyword) return false
  const hay = `${txn.merchant_name ?? ''} ${txn.description ?? ''}`.toLowerCase()
  if (!hay.includes(rule.keyword.toLowerCase())) return false

  if (rule.direction === 'in' && !(txn.amount < 0)) return false
  if (rule.direction === 'out' && !(txn.amount > 0)) return false

  const mag = Math.abs(txn.amount)
  if (rule.min_amount != null && mag < rule.min_amount) return false
  if (rule.max_amount != null && mag > rule.max_amount) return false
  return true
}

/** The most specific (longest-keyword) rule whose conditions all pass, or null.
 *  This single winner drives both actions (category + reimbursement) so the two
 *  can never disagree about which rule fired. */
export function matchRule(txn: Transaction, rules: CategoryRule[]): CategoryRule | null {
  const sorted = [...rules].sort((a, b) => b.keyword.length - a.keyword.length)
  return sorted.find((r) => ruleMatches(r, txn)) ?? null
}

/** Resolved actions for the apply flows (auto-categorize on sync / bulk): the
 *  category from the standard precedence ladder, plus the reimbursement flag from
 *  the winning rule (an orthogonal action). Mirrors backend apply_learned. */
export interface Categorization {
  categoryId: UUID | null
  setReimbursement: boolean
}

export function resolveCategorization(
  txn: Transaction,
  memory: Record<string, UUID>,
  rules: CategoryRule[],
  categories: Category[],
): Categorization {
  return {
    categoryId: autoMatch(txn, memory, rules, categories),
    setReimbursement: matchRule(txn, rules)?.set_reimbursement ?? false,
  }
}

/** Best confident auto-guess for the category, or null. */
export function autoMatch(
  txn: Transaction,
  memory: Record<string, UUID>,
  rules: CategoryRule[],
  categories: Category[],
): UUID | null {
  const key = merchantKey(txn)
  if (key && memory[key]) return memory[key]

  // The longest-keyword rule whose conditions pass; take its category if it sets one.
  const winner = matchRule(txn, rules)
  if (winner?.category_id) return winner.category_id

  const byName = (n: string) => categories.find((c) => c.name === n)
  if (txn.amount < 0) {
    const inc = byName('Income')
    if (inc) return inc.id
  }
  const d = txn.plaid_category_detail?.toUpperCase()
  if (d && detailMap[d]) {
    const c = byName(detailMap[d])
    if (c) return c.id
  }
  const p = txn.plaid_category?.toUpperCase()
  if (p && plaidMap[p]) {
    const c = byName(plaidMap[p])
    if (c) return c.id
  }
  return null
}

/** A short money label without forced cents: "$1,500", "$1,500.50". USD (the app's
 *  single currency; matches formatCurrency's default). */
function money(n: number): string {
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`
}

/** Human-readable one-line summary of a rule for the rules list, e.g.
 *  `"Ved Rao" · money in · > $1,500 → Rent + reimbursement`. Pure; exported for
 *  testing. `categoryName` is resolved by the caller (null for a reimbursement-only
 *  rule). Mirrors Swift CategoryRule.summary. */
export function describeRule(rule: CategoryRule, categoryName: string | null): string {
  const conditions: string[] = [`"${rule.keyword}"`]
  if (rule.direction === 'in') conditions.push('money in')
  else if (rule.direction === 'out') conditions.push('money out')

  const { min_amount: lo, max_amount: hi } = rule
  if (lo != null && hi != null) conditions.push(`${money(lo)}–${money(hi)}`)
  else if (lo != null) conditions.push(`> ${money(lo)}`)
  else if (hi != null) conditions.push(`< ${money(hi)}`)

  const actions: string[] = []
  if (categoryName) actions.push(categoryName)
  if (rule.set_reimbursement) actions.push('reimbursement')

  const left = conditions.join(' · ')
  return actions.length ? `${left} → ${actions.join(' + ')}` : left
}

/** Review-flow suggestion: auto-guess, else fall back to "Other"/first so a card always
 *  shows something the user can confirm or change. */
export function suggest(
  txn: Transaction,
  memory: Record<string, UUID>,
  rules: CategoryRule[],
  categories: Category[],
): Category | null {
  const cid = autoMatch(txn, memory, rules, categories)
  if (cid) {
    const cat = categories.find((c) => c.id === cid)
    if (cat) return cat
  }
  return categories.find((c) => c.name === 'Other') ?? categories[0] ?? null
}
