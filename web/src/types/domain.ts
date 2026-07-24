// Domain types for OUR Supabase schema (UUID ids), mirroring PocketLens/Models/*.swift.
// These are distinct from Keep's original int-id `types/*` (which still back Keep's
// unported pages). New Supabase-backed code imports from here.

export type UUID = string

/** category_groups row — a named container for categories (0 or 1 group per category). */
export interface CategoryGroup {
  id: UUID
  name: string
  color?: string // hex, e.g. "#0055D5"
  sort_order: number
  created_at?: string | null
}

/** categories row. `icon` is an SF Symbol name (mapped to lucide in lib/iconMap). */
export interface Category {
  id: UUID
  name: string
  color: string // hex, e.g. "#34C759"
  icon: string // SF Symbol name, e.g. "cart.fill"
  parent_id: UUID | null
  group_id: UUID | null // optional membership in a category_group
  sort_order: number
  kind: 'spend' | 'income'
}

/** tags row. `color` is hex, rendered inline like category colors. */
export interface Tag {
  id: UUID
  name: string
  color: string // hex, e.g. "#8E8E93"
  created_at?: string | null
}

/** transaction_tags join row embedded via select("..., transaction_tags(tag_id, tags(*))"). */
export interface TransactionTag {
  tag_id: UUID
  tags: Tag | null
}

/** transaction_splits row, with the embedded category. Same sign convention as the txn. */
export interface TransactionSplit {
  id: UUID
  transaction_id: UUID
  category_id: UUID
  amount: number
  categories?: Category | null // embedded relation
}

/** transactions row, with the embedded category from select("*, categories(*)"). */
export interface Transaction {
  id: UUID
  plaid_transaction_id: string
  account_id: UUID
  date: string // yyyy-MM-dd
  authorized_date: string | null
  effective_date: string // generated = coalesce(authorized_date, date)
  amount: number // POSITIVE = spend, NEGATIVE = income
  merchant_name: string | null
  description: string | null
  plaid_category: string | null
  plaid_category_detail: string | null
  category_id: UUID | null
  notes: string | null
  pending: boolean
  exclude_from_totals: boolean
  transfer_group_id: UUID | null // non-null = one leg of a linked transfer
  transfer_kind: 'auto' | 'manual' | 'one_sided' | null // provenance; set iff grouped
  transfer_opt_out: boolean // user said "not a transfer" — auto-detection skips it
  hidden: boolean // user-hidden: kept but not counted (exclude_from_totals follows it)
  is_reimbursement: boolean // contra-expense: a credit that nets down its category's spend
  // Plaid-owned merchant location + settlement currency. All nullable —
  // Plaid omits them for many txns, and rows predating the feature stay null until a
  // re-sync. Forward-only groundwork for trip tagging (region) + foreign-txn detection.
  merchant_city: string | null
  merchant_region: string | null
  merchant_country: string | null
  merchant_postal_code: string | null
  merchant_store_number: string | null
  merchant_lat: number | null
  merchant_lon: number | null
  iso_currency_code: string | null // e.g. "USD", "EUR"; non-USD ⇒ foreign transaction
  categories?: Category | null // embedded relation
  transaction_tags?: TransactionTag[] | null // embedded relation
  transaction_splits?: TransactionSplit[] | null // embedded relation
}

/** Flatten embedded transaction_tags into a Tag[] (drops any null joins). */
export function txnTags(t: Transaction): Tag[] {
  return (t.transaction_tags ?? []).map((tt) => tt.tags).filter((x): x is Tag => x != null)
}

export function txnSplits(t: Transaction): TransactionSplit[] {
  return t.transaction_splits ?? []
}

export function hasSplits(t: Transaction): boolean {
  return (t.transaction_splits?.length ?? 0) > 0
}

/** True when the txn is linked into a transfer group (excluded from totals). */
export function isTransfer(t: Transaction): boolean {
  return t.transfer_group_id != null
}

/** True when the txn is a reimbursement (contra-expense): an incoming credit flagged to
 *  offset a category's spend rather than count as income. */
export function isReimbursement(t: Transaction): boolean {
  return t.is_reimbursement
}

/** "City, Region" from Plaid's merchant location (whichever parts resolved), else null.
 *  Mirrors iOS Transaction.merchantLocationText. */
export function merchantLocation(t: Transaction): string | null {
  const parts = [t.merchant_city, t.merchant_region].filter(
    (p): p is string => p != null && p !== '',
  )
  return parts.length > 0 ? parts.join(', ') : null
}

/** True when the settled currency is present and not USD — marks a foreign transaction.
 *  Mirrors iOS Transaction.isForeignCurrency. */
export function isForeignCurrency(t: Transaction): boolean {
  const code = t.iso_currency_code
  return code != null && code !== '' && code.toUpperCase() !== 'USD'
}

/** Plaid PFC primary categories that mean "money moving between accounts", not
 *  earned income — a credit tagged one of these is a transfer leg (e.g. a
 *  self-deposit from another bank), never income. Mirrors sync-service
 *  transfers.py `PFC_TRANSFER`. A one-sided transfer whose counterpart isn't
 *  linked stays visible in the list but must not inflate the income figure. */
const PFC_TRANSFER = new Set(['TRANSFER_IN', 'TRANSFER_OUT', 'LOAN_PAYMENTS'])

/** True when this credit is a transfer leg by Plaid's category, not real income.
 *  Blacklist (not an INCOME whitelist) on purpose: legacy rows ingested before the
 *  plaid_category migration have a null category and are real income we must keep. */
export function isTransferCategory(t: Transaction): boolean {
  return t.plaid_category != null && PFC_TRANSFER.has(t.plaid_category)
}

/** Month income = Σ|amount| of credit rows (amount < 0), EXCLUDING reimbursements (a
 *  reimbursement is a contra-expense, not income) and inter-account transfer legs (a
 *  self-deposit is your own money moving, not earnings — Plaid tags it TRANSFER_IN).
 *  Pass already-counted (non-excluded) rows.
 *  The single source of truth for the reimbursements totals contract. */
export function sumIncome(txns: Transaction[]): number {
  return txns
    .filter((t) => t.amount < 0 && !t.is_reimbursement && !isTransferCategory(t))
    .reduce((s, t) => s + Math.abs(t.amount), 0)
}

/** Month net spend = Σ positive spend (non-reimbursement) − Σ reimbursement credit
 *  magnitudes. A reimbursement nets its category's spend down instead of counting as income.
 *  Pass already-counted (non-excluded) rows. Mirrors the
 *  `category_spend` view's netting, at the whole-month grain. */
export function sumNetSpend(txns: Transaction[]): number {
  return txns.reduce((s, t) => {
    if (t.is_reimbursement) return s - Math.abs(t.amount)
    return t.amount > 0 ? s + t.amount : s
  }, 0)
}

// Spend-per-category lives ONLY in the `category_spend` Postgres view now (the
// cross-client source of truth, tested in test_integration.py). Clients read it via
// data/transactions.fetchSpendByCategory / hooks.useSpendByCategory instead of
// re-summing txns client-side, so the splits+reimbursement netting rule can't drift.

export interface Account {
  id: UUID
  plaid_account_id: string
  plaid_item_id: UUID | null
  name: string
  official_name: string | null
  type: string // depository | credit | investment | loan
  subtype: string | null
  mask: string | null
  currency: string
  is_active: boolean
  display_order: number
  // client-only, filled from account_balance_history
  currentBalance?: number | null
}

/** budget_limits row — an effective-dated monthly limit. `monthly_limit` of 0 means the
 *  category is explicitly unbudgeted from `effective_month` onward. The limit in effect for a
 *  category at month M is the row with the greatest effective_month ≤ M (see data/budgets.ts). */
export interface BudgetLimit {
  id: UUID
  user_id?: UUID
  category_id: UUID
  effective_month: string // "yyyy-MM-dd", first of month
  monthly_limit: number
}

/** group_budget_limits row — same effective-dating contract as BudgetLimit but keyed on
 *  group_id. The limit for a group at month M = row with greatest effective_month ≤ M;
 *  monthly_limit 0 = explicitly unbudgeted sentinel. See data/groupBudgets.ts. */
export interface GroupBudgetLimit {
  id: UUID
  user_id?: UUID
  group_id: UUID
  effective_month: string // "yyyy-MM-dd", first of month
  monthly_limit: number
}

// ── Zero-sum (zero-based) budgeting — Supabase row shapes. Math lives in lib/zbb.ts. ──
export interface ZbbSettings {
  id?: UUID
  enabled: boolean
  rollover_mode: 'strict' | 'flexible'
  monthly_income: number
  budget_start_year: number | null
  budget_start_month: number | null
}

export interface NetWorthSnapshot {
  id: UUID
  date: string // yyyy-MM-dd
  total_assets: number
  total_liabilities: number
  net_worth: number
}

/** From the current_net_worth view (live, not a snapshot). */
export interface CurrentNetWorth {
  net_worth: number
  total_assets: number
  total_liabilities: number
  as_of: string | null // yyyy-MM-dd, newest active-account balance date
}

export interface PlaidItem {
  id: UUID
  plaid_item_id: string
  institution_id: string | null
  institution_name: string | null
  institution_logo: string | null // base64 PNG from Plaid institutions/get_by_id
  last_synced_at: string | null
  is_active: boolean
  is_syncing: boolean // per-item sync lock — true while a sync is in flight
  sync_started_at: string | null // when the current/last sync acquired the lock
  last_backfill_at: string | null // last full (730d) sync; gates the cooldown
}

/** Money-flow filter on a rule. Sign convention (see Transaction.amount): amount
 *  POSITIVE = spend/outflow, NEGATIVE = money-in/inflow. So 'in' ⇔ amount < 0,
 *  'out' ⇔ amount > 0, null ⇔ either. */
export type RuleDirection = 'in' | 'out'

export interface CategoryRule {
  id: UUID
  keyword: string
  category_id: UUID | null
  // Conditional matching. All null/false on legacy rows, which then behave
  // exactly like the old keyword→category rules. A rule fires when ALL present
  // conditions pass; on a match it sets the category (if category_id) and/or flags
  // the row as a reimbursement (if set_reimbursement).
  direction: RuleDirection | null // null = any direction
  min_amount: number | null // inclusive lower bound on ABS(amount)
  max_amount: number | null // inclusive upper bound on ABS(amount)
  set_reimbursement: boolean
}

/** tag_category_rules row. Attaching `tag_id` to a txn sets its category to
 *  `category_id`. Unique per (user, tag), so re-adding a tag's rule replaces its category. */
export interface TagCategoryRule {
  id: UUID
  tag_id: UUID
  category_id: UUID
}

export interface SeparateAccount {
  id: UUID
  name: string
  type: string // depository | investment | other = asset; credit | loan = liability
  currency: string
  is_active: boolean
  display_order: number
  currentBalance?: number // client-only (sum of values)
}

export interface SeparateAccountValue {
  id: UUID
  separate_account_id: UUID
  date: string
  amount: number // signed delta
  note: string | null
}

export interface RecurringContribution {
  id: UUID
  separate_account_id: UUID
  delta_balance: number
  frequency_in_days: number
  anchor_date: string
  last_applied_date: string | null
  is_active: boolean
}

/** A saved transactions-list filter set. `params` is client-owned (see data/savedViews.ts). */
export interface SavedView {
  id: UUID
  name: string
  params: SavedViewParams
  created_at?: string | null
}

/** Filter state captured by a saved view. Mirrors AllTransactionsPage filters. */
export interface SavedViewParams {
  categoryIds: UUID[]
  tagIds: UUID[]
}

// ── Activity log + Undo — shared cross-client contract (iOS + web write the same
//    rows; `before`/`after` JSON shapes are identical on both clients). See
//    ACTIVITY_SPEC.md / migration 20260704012616_activity_log.sql. ─────────────
export type ActivityActionType =
  | 'categorize'
  | 'hide'
  | 'unhide'
  | 'set_budget'
  | 'delete_budget'
  | 'add_rule'
  | 'delete_rule'

export type ActivityEntityType = 'transaction' | 'budget' | 'category_rule'

/** One activity_log row. `before`/`after` carry the minimal JSON needed to display
 *  and reverse the action; their exact shapes per action_type are the cross-client
 *  contract in ACTIVITY_SPEC.md. */
export interface ActivityEntry {
  id: UUID
  created_at: string // ISO timestamp
  action_type: ActivityActionType
  entity_type: ActivityEntityType
  entity_id: UUID | null
  summary: string
  before: Record<string, unknown> | null
  after: Record<string, unknown> | null
  reversible: boolean
  undone: boolean
  undone_at: string | null
}

/** New-row payload — the DB defaults id/created_at/undone/undone_at. */
export type ActivityInsert = Pick<
  ActivityEntry,
  'action_type' | 'entity_type' | 'entity_id' | 'summary' | 'before' | 'after'
> & { reversible?: boolean }

// ── Alerts & push notifications — shared cross-client schema. Web ships
//    the data layer first (Phase A); iOS push, backend evaluation, and the Bell
//    inbox UI follow in later phases. See migration 20260725000000_alerts.sql. ──

/** notification_prefs row — one per (user, type). `type` is an open enum
 *  (budget_threshold, large_charge, low_balance, sync_failed, daily_spend,
 *  bill_due, periodic_digest); `config` holds per-type thresholds, e.g.
 *  {"pct":90}, {"amount":200}, {"cadence":"weekly"}. */
export interface NotificationPref {
  id: UUID
  type: string
  enabled: boolean
  config: Record<string, unknown>
  created_at?: string | null
  updated_at?: string | null
}

/** notifications row — a generated alert event shown in the inbox. `payload` carries
 *  deep-link context (category_id/account_id/transaction_id); `dedup_key` is the
 *  backend's once-per-user firing guard (null for ad-hoc alerts). Named AppNotification
 *  to avoid clashing with the DOM `Notification` global. */
export interface AppNotification {
  id: UUID
  type: string
  title: string
  body: string
  payload: Record<string, unknown>
  dedup_key: string | null
  read_at: string | null
  created_at: string // ISO timestamp
}

/** device_tokens row — an APNs push target registered by the iOS client. */
export interface DeviceToken {
  id: UUID
  token: string
  platform: string // 'ios'
  created_at?: string | null
  updated_at?: string | null
}

/** profiles row — 1:1 with the auth user (id IS the auth user id). Holds the user's
 *  first/last name, captured at signup and editable later. */
export interface Profile {
  id: UUID
  first_name: string | null
  last_name: string | null
  created_at?: string | null
  updated_at?: string | null
}

// ── computed helpers (mirror iOS model computed props) ─────────────────────

export function displayName(t: Transaction): string {
  return t.merchant_name || t.description || 'Unknown'
}

/** Lowercased/trimmed merchant key — MUST match iOS Transaction.merchantKey and the
 *  backend _merchant_key so learned memory lines up across clients. */
export function merchantKey(t: Transaction): string {
  return (t.merchant_name || t.description || '').trim().toLowerCase()
}

/** Asset vs liability by account type (mirrors iOS). */
export function isLiabilityType(type: string): boolean {
  return type === 'credit' || type === 'loan'
}

export type LiquidityBucket = 'liquid' | 'semiLiquid' | 'liability'

/** Liquidity bucket for the Balances split.
 *  - liquid: cash spendable now — `depository` (checking/savings).
 *  - semiLiquid: sellable-but-not-instant assets — `investment` (incl. retirement:
 *    401k/IRA/etc are investment-typed), `other`, and any unknown asset type.
 *  - liability: debt — `credit`, `loan`.
 *  Kept consistent with isLiabilityType: any non-liability type is an asset. */
export function liquidityBucket(type: string): LiquidityBucket {
  if (isLiabilityType(type)) return 'liability'
  if (type === 'depository') return 'liquid'
  return 'semiLiquid'
}
