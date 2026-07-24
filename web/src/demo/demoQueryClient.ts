// A QueryClient pre-filled with the demo dataset.
//
// Every key here is seeded with `staleTime: Infinity` and refetching disabled, so a
// seeded query never runs its queryFn and never reaches the network. Keys that aren't
// seeded (a month outside the demo window, a filter combination nobody anticipated)
// fall through to the Supabase client, which is stubbed in demo mode (lib/supabase.ts)
// and resolves empty — so the worst case is an empty panel, never a request.

import { QueryClient } from '@tanstack/react-query'
import { sbKeys } from '@/data/hooks'
import { buildReport } from '@/data/reports'
import type { RecurringSeriesCard } from '@/data/recurring'
import { detectRecurringSeries } from '@/lib/recurring'
import { toISODate } from '@/lib/dates'
import type { CategoryRule, NotificationPref, SeparateAccountValue, UUID } from '@/types/domain'
import { demoData } from './demoStore'
import {
  demoAccountTransactions,
  demoMerchantMemory,
  demoMonthTransactions,
  demoRecent,
  demoSpendByCategory,
  demoTransferGroups,
  demoUncategorized,
  demoUncategorizedSpend,
} from './demoStore'

/** Months to seed either side of the demo window, so paging back/forward off the end
 *  of the data lands on a seeded (empty) month rather than an unseeded one. */
const SEED_MONTHS_BEFORE = 8
const SEED_MONTHS_AFTER = 1

/** Same month-key spelling as data/hooks.monthKey. */
function monthKey(month: Date): string {
  return `${month.getFullYear()}-${month.getMonth() + 1}`
}

const demoRules: CategoryRule[] = [
  { id: 'demo-rule-1', keyword: 'sweetgreen', category_id: 'demo-cat-dining', direction: 'out', min_amount: null, max_amount: null, set_reimbursement: false },
  { id: 'demo-rule-2', keyword: 'blank street', category_id: 'demo-cat-coffee', direction: 'out', min_amount: null, max_amount: null, set_reimbursement: false },
  { id: 'demo-rule-3', keyword: 'payroll', category_id: 'demo-cat-income', direction: 'in', min_amount: null, max_amount: null, set_reimbursement: false },
  { id: 'demo-rule-4', keyword: 'halal guys', category_id: 'demo-cat-dining', direction: 'out', min_amount: null, max_amount: null, set_reimbursement: false },
  { id: 'demo-rule-5', keyword: 'doordash', category_id: 'demo-cat-dining', direction: 'out', min_amount: null, max_amount: null, set_reimbursement: false },
]

const demoNotificationPrefs: NotificationPref[] = [
  { id: 'demo-pref-1', type: 'budget_threshold', enabled: true, config: { pct: 90 } },
  { id: 'demo-pref-2', type: 'large_charge', enabled: true, config: { amount: 200 } },
  { id: 'demo-pref-3', type: 'periodic_digest', enabled: false, config: { cadence: 'weekly' } },
]

export function createDemoQueryClient(): QueryClient {
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        // Seeded data is the whole world in demo mode — never re-fetch it, and never
        // retry the handful of queries that fall through to the stubbed client.
        staleTime: Infinity,
        gcTime: Infinity,
        retry: false,
        refetchOnMount: false,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
      },
      mutations: { retry: false },
    },
  })

  const d = demoData()
  const set = (key: readonly unknown[], value: unknown) => client.setQueryData(key, value)

  // ── reference data ─────────────────────────────────────────────────────────
  set(sbKeys.categories, d.categories)
  set(sbKeys.categoryGroups, d.groups)
  set(sbKeys.tags, d.tags)
  set(sbKeys.rules, demoRules)
  set(sbKeys.tagRules, [])
  set(sbKeys.merchantMemory, demoMerchantMemory())
  set(sbKeys.profile, d.profile)
  set(sbKeys.savedViews, d.savedViews)
  set(sbKeys.activity, d.activity)
  set(sbKeys.notifications, d.notifications)
  set(sbKeys.notificationPrefs, demoNotificationPrefs)
  set(sbKeys.zbbSettings, d.zbbSettings)

  // ── accounts + balances ────────────────────────────────────────────────────
  set(sbKeys.accounts, d.accounts)
  set(sbKeys.accountsWithBalance, d.accounts)
  set(sbKeys.plaidItems, d.plaidItems)
  set(sbKeys.currentNetWorth, currentNetWorth())
  for (const months of [undefined, 3, 6, 12, 24]) {
    set(sbKeys.netWorth(months), d.snapshots)
  }
  for (const a of d.accounts) {
    set(['sb', 'accounts', a.id, 'latestBalance'], a.currentBalance ?? null)
    set(sbKeys.transactionsByAccount(a.id), demoAccountTransactions(a.id))
  }

  // ── manual accounts ────────────────────────────────────────────────────────
  set(sbKeys.separateAccounts, d.separateAccounts)
  for (const sa of d.separateAccounts) {
    set(sbKeys.separateAccountValues(sa.id), separateValues(sa.id, sa.currentBalance ?? 0))
    set(sbKeys.separateAccountContributions(sa.id), [])
  }

  // ── budgets ────────────────────────────────────────────────────────────────
  set(sbKeys.budgetLimits, d.budgetLimits)
  set(sbKeys.groupBudgetLimits, d.groupBudgetLimits)

  // ── per-month data ─────────────────────────────────────────────────────────
  for (let back = SEED_MONTHS_BEFORE; back >= -SEED_MONTHS_AFTER; back--) {
    const month = new Date(d.now.getFullYear(), d.now.getMonth() - back, 1)
    const key = monthKey(month)
    const counted = demoMonthTransactions(month)
    const spend = demoSpendByCategory(month)

    set(sbKeys.transactionsMonth(key), counted)
    set(sbKeys.transactionsMonthAll(key), demoMonthTransactions(month, { includeExcluded: true }))
    set(sbKeys.spendByCategory(key), spend)
    set(sbKeys.uncategorizedSpend(key), demoUncategorizedSpend(month))
    set(sbKeys.transferGroups(key), demoTransferGroups(month))
    // useUncategorized keys on a different month spelling (0-based month) than monthKey.
    set(
      sbKeys.uncategorized(`${month.getFullYear()}-${month.getMonth()}`),
      demoUncategorized(month),
    )

    const prevMonth = new Date(month.getFullYear(), month.getMonth() - 1, 1)
    set(
      sbKeys.report(month.getFullYear(), month.getMonth() + 1),
      buildReport({
        year: month.getFullYear(),
        month: month.getMonth() + 1,
        thisTxns: counted,
        prevTxns: demoMonthTransactions(prevMonth),
        spend,
        categories: d.categories,
        groups: d.groups,
        now: d.now,
      }),
    )
  }

  // ── recent / recurring / transfers ─────────────────────────────────────────
  for (const days of [7, 8, 14, 30]) set(sbKeys.recent(days), demoRecent(days))
  set(sbKeys.transferSuggestions, [])
  set(
    sbKeys.recurring,
    detectRecurringSeries(d.transactions).map(
      (s): RecurringSeriesCard => ({ ...s, status: 'suggested' }),
    ),
  )

  return client
}

function currentNetWorth() {
  const d = demoData()
  const assets = d.accounts
    .filter((a) => a.type !== 'credit' && a.type !== 'loan')
    .reduce((s, a) => s + (a.currentBalance ?? 0), 0)
  const liabilities = d.accounts
    .filter((a) => a.type === 'credit' || a.type === 'loan')
    .reduce((s, a) => s + (a.currentBalance ?? 0), 0)
  const manual = d.separateAccounts.reduce((s, a) => s + (a.currentBalance ?? 0), 0)
  return {
    net_worth: Number((assets + manual - liabilities).toFixed(2)),
    total_assets: Number((assets + manual).toFixed(2)),
    total_liabilities: Number(liabilities.toFixed(2)),
    as_of: toISODate(d.now),
  }
}

/** A short value ledger for a manual account: an opening balance plus monthly adds
 *  that sum to today's balance. */
function separateValues(accountId: UUID, balance: number): SeparateAccountValue[] {
  const d = demoData()
  const monthly = Number((balance * 0.04).toFixed(2))
  const opening = Number((balance - monthly * 3).toFixed(2))
  const rows: SeparateAccountValue[] = [
    {
      id: `${accountId}-val-0`,
      separate_account_id: accountId,
      date: toISODate(new Date(d.now.getFullYear(), d.now.getMonth() - 3, 1)),
      amount: opening,
      note: 'Starting balance',
    },
  ]
  for (let i = 2; i >= 0; i--) {
    rows.push({
      id: `${accountId}-val-${3 - i}`,
      separate_account_id: accountId,
      date: toISODate(new Date(d.now.getFullYear(), d.now.getMonth() - i, 1)),
      amount: monthly,
      note: 'Monthly update',
    })
  }
  return rows.reverse()
}
