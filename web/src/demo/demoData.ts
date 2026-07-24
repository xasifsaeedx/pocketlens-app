// Fixtures for the demo landing page — a plausible six months of one person's money,
// generated in the browser. Nothing here touches Supabase.
//
// Everything is derived from `now` so the demo always looks current: months are real
// months, the newest transactions are days old, and the budget page opens on a month
// that is genuinely in progress.
//
// Amounts are jittered by a seeded LCG (not Math.random) so a reload shows the same
// numbers — a demo whose totals shuffle on refresh reads as broken.

import { toISODate } from '@/lib/dates'
import type {
  Account,
  ActivityEntry,
  AppNotification,
  BudgetLimit,
  Category,
  CategoryGroup,
  GroupBudgetLimit,
  NetWorthSnapshot,
  PlaidItem,
  Profile,
  SavedView,
  SeparateAccount,
  Tag,
  Transaction,
  TransactionTag,
  UUID,
  ZbbSettings,
} from '@/types/domain'

/** Months of history the demo carries, including the in-progress current month. */
export const DEMO_MONTHS = 6

// ── deterministic jitter ─────────────────────────────────────────────────────
function lcg(seed: number): () => number {
  let s = seed % 2147483647
  if (s <= 0) s += 2147483646
  return () => {
    s = (s * 16807) % 2147483647
    return (s - 1) / 2147483646
  }
}

// ── category groups ──────────────────────────────────────────────────────────
export const demoGroups: CategoryGroup[] = [
  { id: 'demo-grp-essentials', name: 'Essentials', color: '#5B8C7A', sort_order: 0 },
  { id: 'demo-grp-lifestyle', name: 'Lifestyle', color: '#C4633A', sort_order: 1 },
  { id: 'demo-grp-financial', name: 'Financial', color: '#7A8B99', sort_order: 2 },
]

const ESSENTIALS = demoGroups[0].id
const LIFESTYLE = demoGroups[1].id
const FINANCIAL = demoGroups[2].id

// ── categories ───────────────────────────────────────────────────────────────
function cat(
  id: string,
  name: string,
  color: string,
  icon: string,
  group_id: UUID | null,
  sort_order: number,
  kind: 'spend' | 'income' = 'spend',
): Category {
  return { id, name, color, icon, parent_id: null, group_id, sort_order, kind }
}

export const demoCategories: Category[] = [
  cat('demo-cat-income', 'Income', '#34C759', 'dollarsign.circle.fill', null, 0, 'income'),
  cat('demo-cat-housing', 'Housing', '#FF9500', 'house.fill', ESSENTIALS, 1),
  cat('demo-cat-groceries', 'Groceries', '#34C759', 'cart.fill', ESSENTIALS, 2),
  cat('demo-cat-utilities', 'Utilities', '#5AC8FA', 'bolt.fill', ESSENTIALS, 3),
  cat('demo-cat-transport', 'Transport', '#007AFF', 'car.fill', ESSENTIALS, 4),
  cat('demo-cat-health', 'Health', '#FF2D55', 'cross.fill', ESSENTIALS, 5),
  cat('demo-cat-dining', 'Dining', '#FF6B35', 'fork.knife', LIFESTYLE, 6),
  cat('demo-cat-coffee', 'Coffee', '#A2845E', 'cup.and.saucer.fill', LIFESTYLE, 7),
  cat('demo-cat-shopping', 'Shopping', '#AF52DE', 'bag.fill', LIFESTYLE, 8),
  cat('demo-cat-fun', 'Entertainment', '#FF375F', 'tv.fill', LIFESTYLE, 9),
  cat('demo-cat-subs', 'Subscriptions', '#64D2FF', 'music.note', LIFESTYLE, 10),
  cat('demo-cat-fitness', 'Fitness', '#FFCC00', 'dumbbell.fill', LIFESTYLE, 11),
  cat('demo-cat-travel', 'Travel', '#30B0C7', 'suitcase.fill', LIFESTYLE, 12),
  cat('demo-cat-loan', 'Loan payment', '#8E8E93', 'building.columns.fill', FINANCIAL, 13),
]

const catById = new Map(demoCategories.map((c) => [c.id, c]))

// ── tags ─────────────────────────────────────────────────────────────────────
export const demoTags: Tag[] = [
  { id: 'demo-tag-expense', name: 'Will expense (won’t)', color: '#0055D5' },
  { id: 'demo-tag-hamptons', name: 'Hamptons share', color: '#30B0C7' },
  { id: 'demo-tag-2am', name: '2 AM decisions', color: '#FF9500' },
]

const tagById = new Map(demoTags.map((t) => [t.id, t]))

// ── accounts ─────────────────────────────────────────────────────────────────
const CHECKING = 'demo-acct-checking'
const SAVINGS = 'demo-acct-savings'
const CARD = 'demo-acct-card'
const BROKERAGE = 'demo-acct-brokerage'
const LOAN = 'demo-acct-loan'

function account(
  id: string,
  name: string,
  official_name: string,
  type: string,
  subtype: string,
  mask: string,
  itemId: string,
  display_order: number,
  balance: number,
): Account {
  return {
    id,
    plaid_account_id: `${id}-plaid`,
    plaid_item_id: itemId,
    name,
    official_name,
    type,
    subtype,
    mask,
    currency: 'USD',
    is_active: true,
    display_order,
    currentBalance: balance,
  }
}

export const demoAccounts: Account[] = [
  account(CHECKING, 'Rent goes here', 'Chase Total Checking', 'depository', 'checking', '4821', 'demo-item-chase', 0, 1847.22),
  account(SAVINGS, 'Emergency fund', 'Marcus Online Savings', 'depository', 'savings', '9017', 'demo-item-marcus', 1, 8410.0),
  account(CARD, 'The points card', 'Amex Platinum', 'credit', 'credit card', '3388', 'demo-item-amex', 2, 3188.19),
  account(BROKERAGE, 'Brokerage', 'Fidelity Individual', 'investment', 'brokerage', '2210', 'demo-item-fidelity', 3, 31140.55),
  account(LOAN, 'Grad school', 'Sallie Mae — NYU', 'loan', 'student', '7745', 'demo-item-salliemae', 4, 41200.0),
]

const accountNameById = new Map(demoAccounts.map((a) => [a.id, a.name]))

export const demoPlaidItems: PlaidItem[] = [
  plaidItem('demo-item-chase', 'Chase', 'ins_56'),
  plaidItem('demo-item-marcus', 'Marcus by Goldman Sachs', 'ins_15'),
  plaidItem('demo-item-amex', 'American Express', 'ins_10'),
  plaidItem('demo-item-fidelity', 'Fidelity', 'ins_12'),
  plaidItem('demo-item-salliemae', 'Sallie Mae', 'ins_116'),
]

function plaidItem(id: string, name: string, institutionId: string): PlaidItem {
  return {
    id,
    plaid_item_id: `${id}-plaid`,
    institution_id: institutionId,
    institution_name: name,
    institution_logo: null,
    last_synced_at: null, // filled in by buildDemoData (relative to now)
    is_active: true,
    is_syncing: false,
    sync_started_at: null,
    last_backfill_at: null,
  }
}

// ── transaction templates ────────────────────────────────────────────────────
/** One recurring line item: same merchant, same day each month. */
interface FixedCharge {
  merchant: string
  amount: number
  day: number
  categoryId: string
  accountId: string
  plaidCategory: string
  jitter?: number // ± fraction applied to the amount (utilities vary, Netflix doesn't)
}

const FIXED: FixedCharge[] = [
  { merchant: 'Rent — 412 E 9th St, 4th fl walkup', amount: 4250, day: 1, categoryId: 'demo-cat-housing', accountId: CHECKING, plaidCategory: 'RENT_AND_UTILITIES' },
  { merchant: 'Sallie Mae (NYU, worth it)', amount: 478.2, day: 6, categoryId: 'demo-cat-loan', accountId: CHECKING, plaidCategory: 'LOAN_PAYMENTS' },
  { merchant: 'Con Edison', amount: 186, day: 14, categoryId: 'demo-cat-utilities', accountId: CHECKING, plaidCategory: 'RENT_AND_UTILITIES', jitter: 0.34 },
  { merchant: 'Spectrum (the only option in the building)', amount: 89.99, day: 18, categoryId: 'demo-cat-utilities', accountId: CHECKING, plaidCategory: 'RENT_AND_UTILITIES' },
  { merchant: 'MTA OMNY', amount: 132, day: 2, categoryId: 'demo-cat-transport', accountId: CARD, plaidCategory: 'TRANSPORTATION' },
  { merchant: 'Fluff & Fold (no in-unit laundry)', amount: 47.5, day: 11, categoryId: 'demo-cat-utilities', accountId: CHECKING, plaidCategory: 'GENERAL_SERVICES', jitter: 0.22 },
  { merchant: 'Netflix', amount: 22.99, day: 4, categoryId: 'demo-cat-subs', accountId: CARD, plaidCategory: 'ENTERTAINMENT' },
  { merchant: 'Spotify', amount: 11.99, day: 9, categoryId: 'demo-cat-subs', accountId: CARD, plaidCategory: 'ENTERTAINMENT' },
  { merchant: 'NYT Cooking (for the one recipe)', amount: 5, day: 16, categoryId: 'demo-cat-subs', accountId: CARD, plaidCategory: 'ENTERTAINMENT' },
  { merchant: 'iCloud+ 2TB (all screenshots)', amount: 9.99, day: 20, categoryId: 'demo-cat-subs', accountId: CARD, plaidCategory: 'GENERAL_SERVICES' },
  { merchant: 'Equinox', amount: 305, day: 12, categoryId: 'demo-cat-fitness', accountId: CARD, plaidCategory: 'PERSONAL_CARE' },
  { merchant: 'Dr. Feldman, LCSW — copay', amount: 60, day: 7, categoryId: 'demo-cat-health', accountId: CARD, plaidCategory: 'MEDICAL' },
  { merchant: 'Dr. Feldman, LCSW — copay', amount: 60, day: 21, categoryId: 'demo-cat-health', accountId: CARD, plaidCategory: 'MEDICAL' },
]

/** Everyday spend: picked a few times a month with a jittered amount. */
interface VariableCharge {
  merchant: string
  low: number
  high: number
  perMonth: number
  categoryId: string
  accountId: string
  plaidCategory: string
  tagId?: string
}

const VARIABLE: VariableCharge[] = [
  { merchant: 'Trader Joe’s (Union Sq, 40 min line)', low: 42, high: 104, perMonth: 3, categoryId: 'demo-cat-groceries', accountId: CARD, plaidCategory: 'FOOD_AND_DRINK' },
  { merchant: 'Erewhon', low: 68, high: 190, perMonth: 2, categoryId: 'demo-cat-groceries', accountId: CARD, plaidCategory: 'FOOD_AND_DRINK' },
  { merchant: 'Bodega — bacon egg & cheese', low: 4.5, high: 7.25, perMonth: 5, categoryId: 'demo-cat-groceries', accountId: CARD, plaidCategory: 'FOOD_AND_DRINK' },
  { merchant: 'Sweetgreen', low: 17.4, high: 22.85, perMonth: 4, categoryId: 'demo-cat-dining', accountId: CARD, plaidCategory: 'FOOD_AND_DRINK' },
  { merchant: 'Joe’s Pizza', low: 4, high: 12, perMonth: 3, categoryId: 'demo-cat-dining', accountId: CARD, plaidCategory: 'FOOD_AND_DRINK' },
  { merchant: 'DoorDash (restaurant is 0.3 mi away)', low: 28, high: 64, perMonth: 4, categoryId: 'demo-cat-dining', accountId: CARD, plaidCategory: 'FOOD_AND_DRINK' },
  { merchant: 'The Halal Guys — 2:14 AM', low: 11, high: 19, perMonth: 2, categoryId: 'demo-cat-dining', accountId: CARD, plaidCategory: 'FOOD_AND_DRINK', tagId: 'demo-tag-2am' },
  { merchant: 'Rooftop bar, $26 cocktail', low: 52, high: 148, perMonth: 2, categoryId: 'demo-cat-dining', accountId: CARD, plaidCategory: 'FOOD_AND_DRINK' },
  { merchant: 'Brunch (someone always Venmos late)', low: 44, high: 92, perMonth: 2, categoryId: 'demo-cat-dining', accountId: CARD, plaidCategory: 'FOOD_AND_DRINK', tagId: 'demo-tag-expense' },
  { merchant: 'Blank Street Coffee', low: 6.25, high: 9.5, perMonth: 8, categoryId: 'demo-cat-coffee', accountId: CARD, plaidCategory: 'FOOD_AND_DRINK' },
  { merchant: 'Levain Bakery (waited 25 min)', low: 12, high: 28, perMonth: 1, categoryId: 'demo-cat-coffee', accountId: CARD, plaidCategory: 'FOOD_AND_DRINK' },
  { merchant: 'Amazon (delivered to a locked lobby)', low: 18, high: 142, perMonth: 4, categoryId: 'demo-cat-shopping', accountId: CARD, plaidCategory: 'GENERAL_MERCHANDISE' },
  { merchant: 'Duane Reade', low: 9, high: 48, perMonth: 3, categoryId: 'demo-cat-shopping', accountId: CARD, plaidCategory: 'GENERAL_MERCHANDISE' },
  { merchant: 'The Strand (bought 4, will read 1)', low: 22, high: 68, perMonth: 1, categoryId: 'demo-cat-shopping', accountId: CARD, plaidCategory: 'GENERAL_MERCHANDISE' },
  { merchant: 'Uber (surge, it was raining)', low: 24, high: 71, perMonth: 3, categoryId: 'demo-cat-transport', accountId: CARD, plaidCategory: 'TRANSPORTATION' },
  { merchant: 'Citi Bike', low: 4.5, high: 18, perMonth: 3, categoryId: 'demo-cat-transport', accountId: CARD, plaidCategory: 'TRANSPORTATION' },
  { merchant: 'CityMD (it was just a cold)', low: 40, high: 175, perMonth: 1, categoryId: 'demo-cat-health', accountId: CARD, plaidCategory: 'MEDICAL' },
  { merchant: 'Angelika Film Center', low: 19, high: 44, perMonth: 1, categoryId: 'demo-cat-fun', accountId: CARD, plaidCategory: 'ENTERTAINMENT' },
  { merchant: 'MoMA membership (went once)', low: 24, high: 110, perMonth: 1, categoryId: 'demo-cat-fun', accountId: CARD, plaidCategory: 'ENTERTAINMENT' },
  { merchant: 'SoulCycle (Equinox is separate, yes)', low: 36, high: 78, perMonth: 2, categoryId: 'demo-cat-fitness', accountId: CARD, plaidCategory: 'PERSONAL_CARE' },
]

const PAYCHECK = 4412.18

// ── transaction construction ─────────────────────────────────────────────────
let seq = 0

function txn(input: {
  date: Date
  amount: number
  merchant: string
  accountId: string
  categoryId: string | null
  plaidCategory: string
  tagIds?: string[]
  pending?: boolean
  transferGroupId?: string | null
}): Transaction {
  const iso = toISODate(input.date)
  const tags: TransactionTag[] = (input.tagIds ?? []).map((id) => ({
    tag_id: id,
    tags: tagById.get(id) ?? null,
  }))
  const isTransfer = input.transferGroupId != null
  return {
    id: `demo-txn-${(seq += 1)}`,
    plaid_transaction_id: `demo-plaid-txn-${seq}`,
    account_id: input.accountId,
    date: iso,
    authorized_date: iso,
    effective_date: iso,
    amount: Number(input.amount.toFixed(2)),
    merchant_name: input.merchant,
    description: input.merchant,
    plaid_category: input.plaidCategory,
    plaid_category_detail: null,
    category_id: input.categoryId,
    notes: null,
    pending: input.pending ?? false,
    // Transfer legs are money moving between the demo's own accounts: visible in the
    // list, never counted as spend or income (same contract as the real app).
    exclude_from_totals: isTransfer,
    transfer_group_id: input.transferGroupId ?? null,
    transfer_kind: isTransfer ? 'auto' : null,
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
    iso_currency_code: 'USD',
    categories: input.categoryId ? (catById.get(input.categoryId) ?? null) : null,
    transaction_tags: tags,
    transaction_splits: [],
  }
}

/** Clamp a day-of-month to a month that may be shorter (day 31 in February). */
function dayIn(year: number, month: number, day: number): Date {
  const last = new Date(year, month + 1, 0).getDate()
  return new Date(year, month, Math.min(day, last))
}

export interface DemoData {
  categories: Category[]
  groups: CategoryGroup[]
  tags: Tag[]
  accounts: Account[]
  plaidItems: PlaidItem[]
  transactions: Transaction[]
  budgetLimits: BudgetLimit[]
  groupBudgetLimits: GroupBudgetLimit[]
  snapshots: NetWorthSnapshot[]
  separateAccounts: SeparateAccount[]
  savedViews: SavedView[]
  activity: ActivityEntry[]
  notifications: AppNotification[]
  profile: Profile
  zbbSettings: ZbbSettings
  months: Date[] // first-of-month for each month with data, oldest first
  now: Date
}

/** Build the whole demo dataset. `now` is injectable so tests get stable output. */
export function buildDemoData(now: Date = new Date()): DemoData {
  seq = 0
  const rand = lcg(20260723)
  const transactions: Transaction[] = []
  const months: Date[] = []

  for (let back = DEMO_MONTHS - 1; back >= 0; back--) {
    const cursor = new Date(now.getFullYear(), now.getMonth() - back, 1)
    const year = cursor.getFullYear()
    const month = cursor.getMonth()
    months.push(new Date(year, month, 1))
    const isCurrentMonth = back === 0

    // Only emit rows that have already happened — a demo showing next week's rent
    // posted would be the first thing a careful visitor notices.
    const push = (t: Transaction, when: Date) => {
      if (when <= now) transactions.push(t)
    }

    // Income: semi-monthly paycheck.
    for (const day of [1, 15]) {
      const when = dayIn(year, month, day)
      push(
        txn({
          date: when,
          amount: -PAYCHECK,
          merchant: 'Sterling Cohen Capital — payroll',
          accountId: CHECKING,
          categoryId: 'demo-cat-income',
          plaidCategory: 'INCOME',
        }),
        when,
      )
    }

    // Fixed monthly charges.
    for (const f of FIXED) {
      const when = dayIn(year, month, f.day)
      const jitter = f.jitter ? 1 + (rand() - 0.5) * 2 * f.jitter : 1
      push(
        txn({
          date: when,
          amount: f.amount * jitter,
          merchant: f.merchant,
          accountId: f.accountId,
          categoryId: f.categoryId,
          plaidCategory: f.plaidCategory,
        }),
        when,
      )
    }

    // Everyday spend, spread across the month.
    for (const v of VARIABLE) {
      for (let i = 0; i < v.perMonth; i++) {
        const day = 1 + Math.floor(rand() * 27)
        const when = dayIn(year, month, day)
        push(
          txn({
            date: when,
            amount: v.low + rand() * (v.high - v.low),
            merchant: v.merchant,
            accountId: v.accountId,
            categoryId: v.categoryId,
            plaidCategory: v.plaidCategory,
            tagIds: v.tagId ? [v.tagId] : undefined,
            // A couple of card charges in the current month are still pending.
            pending: isCurrentMonth && i === 0 && v.merchant === 'Amazon',
          }),
          when,
        )
      }
    }

    // Monthly savings transfer (checking → savings), linked as one transfer group.
    const transferDay = dayIn(year, month, 16)
    const groupId = `demo-transfer-${year}-${month}`
    push(
      txn({
        date: transferDay,
        amount: 500,
        merchant: 'Transfer to Emergency fund',
        accountId: CHECKING,
        categoryId: null,
        plaidCategory: 'TRANSFER_OUT',
        transferGroupId: groupId,
      }),
      transferDay,
    )
    push(
      txn({
        date: transferDay,
        amount: -500,
        merchant: 'Transfer from Rent goes here',
        accountId: SAVINGS,
        categoryId: null,
        plaidCategory: 'TRANSFER_IN',
        transferGroupId: groupId,
      }),
      transferDay,
    )

    // Card autopay (checking → card), also a transfer group.
    const payDay = dayIn(year, month, 22)
    const payGroup = `demo-cardpay-${year}-${month}`
    push(
      txn({
        date: payDay,
        amount: 2650,
        merchant: 'Amex autopay (statement balance, barely)',
        accountId: CHECKING,
        categoryId: null,
        plaidCategory: 'LOAN_PAYMENTS',
        transferGroupId: payGroup,
      }),
      payDay,
    )
    push(
      txn({
        date: payDay,
        amount: -2650,
        merchant: 'Payment Thank You',
        accountId: CARD,
        categoryId: null,
        plaidCategory: 'TRANSFER_IN',
        transferGroupId: payGroup,
      }),
      payDay,
    )
  }

  // A Hamptons share weekend two months back — gives the tag something to hold and
  // the Travel category a spike worth exploring.
  const tripMonth = new Date(now.getFullYear(), now.getMonth() - 2, 1)
  const trip: Array<[string, number, number, string]> = [
    ['Hamptons Jitney', 74.0, 8, 'demo-cat-travel'],
    ['Share house — 1/8 of a bedroom', 1450.0, 8, 'demo-cat-travel'],
    ['Rosé, three bottles, Montauk', 138.75, 9, 'demo-cat-dining'],
    ['Parking ticket, Montauk', 115.0, 10, 'demo-cat-transport'],
    ['Sunscreen at beach prices', 34.5, 9, 'demo-cat-shopping'],
  ]
  for (const [merchant, amount, day, categoryId] of trip) {
    transactions.push(
      txn({
        date: dayIn(tripMonth.getFullYear(), tripMonth.getMonth(), day),
        amount,
        merchant,
        accountId: CARD,
        categoryId,
        plaidCategory: 'TRAVEL',
        tagIds: ['demo-tag-hamptons'],
      }),
    )
  }

  // Two once-a-year gut punches, placed where they show up in the trend rather than
  // in every month: the move-in broker fee at the start of the window, and the card's
  // annual fee last month.
  const brokerMonth = months[0]
  transactions.push(
    txn({
      date: dayIn(brokerMonth.getFullYear(), brokerMonth.getMonth(), 3),
      amount: 7650,
      merchant: 'Broker fee — 15%, for unlocking a door',
      accountId: CHECKING,
      categoryId: 'demo-cat-housing',
      plaidCategory: 'RENT_AND_UTILITIES',
    }),
  )
  const feeMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1)
  transactions.push(
    txn({
      date: dayIn(feeMonth.getFullYear(), feeMonth.getMonth(), 19),
      amount: 695,
      merchant: 'Amex annual fee (the lounge is 40 min away)',
      accountId: CARD,
      categoryId: 'demo-cat-subs',
      plaidCategory: 'GENERAL_SERVICES',
    }),
  )

  transactions.sort((a, b) => (a.effective_date < b.effective_date ? 1 : -1))

  // Leave a few recent rows uncategorized so the "to categorize" queue, the
  // uncategorized-spend figure, and the categorize affordances all have something
  // real to show — an app where everything is already filed looks staged.
  for (const t of transactions.filter((x) => x.transfer_group_id == null).slice(0, 3)) {
    t.category_id = null
    t.categories = null
  }

  // ── budgets ────────────────────────────────────────────────────────────────
  // One effective-dated row per category, effective from the oldest demo month.
  const budgetsFrom = toISODate(months[0])
  // Budgets are set where a New Yorker *hopes* to land, which is why Dining and Coffee
  // spend the month pinned to the red end of the bar.
  const limits: Array<[string, number]> = [
    ['demo-cat-housing', 4250],
    ['demo-cat-groceries', 700],
    ['demo-cat-utilities', 340],
    ['demo-cat-transport', 260],
    ['demo-cat-health', 180],
    ['demo-cat-dining', 550],
    ['demo-cat-coffee', 90],
    ['demo-cat-shopping', 350],
    ['demo-cat-fun', 150],
    ['demo-cat-subs', 55],
    ['demo-cat-fitness', 305],
    ['demo-cat-travel', 300],
    ['demo-cat-loan', 480],
  ]
  const budgetLimits: BudgetLimit[] = limits.map(([category_id, monthly_limit], i) => ({
    id: `demo-budget-${i}`,
    category_id,
    effective_month: budgetsFrom,
    monthly_limit,
  }))

  const groupBudgetLimits: GroupBudgetLimit[] = [
    { id: 'demo-gbudget-0', group_id: ESSENTIALS, effective_month: budgetsFrom, monthly_limit: 5730 },
    { id: 'demo-gbudget-1', group_id: LIFESTYLE, effective_month: budgetsFrom, monthly_limit: 1700 },
  ]

  // ── net worth trend ────────────────────────────────────────────────────────
  // 12 monthly snapshots climbing to today's balances, so the Balances chart has a
  // story (steady saving, one dip for the trip month).
  const assetsNow = demoAccounts
    .filter((a) => a.type !== 'credit' && a.type !== 'loan')
    .reduce((s, a) => s + (a.currentBalance ?? 0), 0)
  const liabilitiesNow = demoAccounts
    .filter((a) => a.type === 'credit' || a.type === 'loan')
    .reduce((s, a) => s + (a.currentBalance ?? 0), 0)

  const snapshots: NetWorthSnapshot[] = []
  for (let back = 11; back >= 0; back--) {
    const d = new Date(now.getFullYear(), now.getMonth() - back, 1)
    const progress = (11 - back) / 11
    const drift = 1 - 0.14 * (1 - progress) + (rand() - 0.5) * 0.012
    const total_assets = Number((assetsNow * drift).toFixed(2))
    const total_liabilities = Number((liabilitiesNow * (1 + 0.09 * (1 - progress))).toFixed(2))
    snapshots.push({
      id: `demo-snap-${back}`,
      date: toISODate(d),
      total_assets,
      total_liabilities,
      net_worth: Number((total_assets - total_liabilities).toFixed(2)),
    })
  }

  // ── manual (non-Plaid) accounts ────────────────────────────────────────────
  const separateAccounts: SeparateAccount[] = [
    { id: 'demo-sep-deposit', name: 'Security deposit (held hostage)', type: 'other', currency: 'USD', is_active: true, display_order: 0, currentBalance: 4250 },
    { id: 'demo-sep-ira', name: 'Roth IRA (started at 29)', type: 'investment', currency: 'USD', is_active: true, display_order: 1, currentBalance: 12480.6 },
  ]

  const savedViews: SavedView[] = [
    { id: 'demo-view-dining', name: 'Food I did not cook', params: { categoryIds: ['demo-cat-dining', 'demo-cat-coffee'], tagIds: [] } },
    { id: 'demo-view-trip', name: 'Hamptons damage', params: { categoryIds: [], tagIds: ['demo-tag-hamptons'] } },
  ]

  const hoursAgo = (h: number) => new Date(now.getTime() - h * 3600_000).toISOString()

  const activity: ActivityEntry[] = [
    {
      id: 'demo-act-1',
      created_at: hoursAgo(5),
      action_type: 'categorize',
      entity_type: 'transaction',
      entity_id: transactions[0]?.id ?? null,
      summary: 'Categorized Blank Street Coffee as Coffee (the 9th one)',
      before: null,
      after: null,
      reversible: false,
      undone: false,
      undone_at: null,
    },
    {
      id: 'demo-act-2',
      created_at: hoursAgo(30),
      action_type: 'set_budget',
      entity_type: 'budget',
      entity_id: 'demo-cat-dining',
      summary: 'Set Dining budget to $550, up from $400, up from $300',
      before: null,
      after: null,
      reversible: false,
      undone: false,
      undone_at: null,
    },
    {
      id: 'demo-act-3',
      created_at: hoursAgo(74),
      action_type: 'add_rule',
      entity_type: 'category_rule',
      entity_id: 'demo-rule-1',
      summary: 'Added rule: “the halal guys” → 2 AM decisions',
      before: null,
      after: null,
      reversible: false,
      undone: false,
      undone_at: null,
    },
  ]

  const notifications: AppNotification[] = [
    {
      id: 'demo-note-1',
      type: 'budget_threshold',
      title: 'Dining is at 94% of budget',
      body: 'Sweetgreen alone is $214 of it. There are 11 days left in the month.',
      payload: {},
      dedup_key: null,
      read_at: null,
      created_at: hoursAgo(9),
    },
    {
      id: 'demo-note-2',
      type: 'large_charge',
      title: 'Large charge on The points card',
      body: 'Amex charged $695 for the annual fee. You have used the lounge once.',
      payload: {},
      dedup_key: null,
      read_at: null,
      created_at: hoursAgo(28),
    },
    {
      id: 'demo-note-3',
      type: 'sync_failed',
      title: 'Rent cleared',
      body: '$4,250 left Rent goes here. Everything is fine. Godspeed.',
      payload: {},
      dedup_key: null,
      read_at: hoursAgo(50),
      created_at: hoursAgo(52),
    },
  ]

  const plaidItems = demoPlaidItems.map((item) => ({
    ...item,
    last_synced_at: hoursAgo(2),
    last_backfill_at: hoursAgo(24 * 12),
  }))

  return {
    categories: demoCategories,
    groups: demoGroups,
    tags: demoTags,
    accounts: demoAccounts,
    plaidItems,
    transactions,
    budgetLimits,
    groupBudgetLimits,
    snapshots,
    separateAccounts,
    savedViews,
    activity,
    notifications,
    profile: {
      id: 'demo-user',
      // One name, Hawaii license, organ donor.
      first_name: 'McLovin',
      last_name: null,
    },
    // Zero-sum budgeting stays off in the demo: the classic per-category budget page
    // is the one that shows well cold, without an assign-every-dollar setup step.
    zbbSettings: {
      enabled: false,
      rollover_mode: 'strict',
      monthly_income: PAYCHECK * 2,
      budget_start_year: null,
      budget_start_month: null,
    },
    months,
    now,
  }
}

/** Account display name for a transaction — used by the demo Explore builder. */
export function demoAccountName(accountId: UUID): string {
  return accountNameById.get(accountId) ?? 'Account'
}
