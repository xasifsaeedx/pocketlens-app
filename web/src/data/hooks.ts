// React Query hooks over our Supabase data modules. Separate key namespace ('sb') from
// Keep's original int-id queryKeys.

import { useEffect, useRef } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
// Not React Query's useMutation directly: in demo mode this wrapper turns every write
// into the sign-up prompt (demo/demoMutation.ts). Identical outside the demo.
import { useMutation } from '@/demo/demoMutation'
import { toast } from 'sonner'
import { triggerSync, backfillAll, type BackfillAllResult } from './sync'
import * as txns from './transactions'
import * as accts from './accounts'
import * as budgetsApi from './budgets'
import * as cats from './categories'
import * as nw from './netWorth'
import * as sep from './separateAccounts'
import * as tagsApi from './tags'
import * as tagRulesApi from './tagRules'
import * as splitsApi from './splits'
import * as transfersApi from './transfers'
import * as recurringApi from './recurring'
import * as savedViewsApi from './savedViews'
import * as zbbApi from './zbb'
import * as activityApi from './activity'
import * as reportsApi from './reports'
import * as categoryGroupsApi from './categoryGroups'
import * as groupBudgetsApi from './groupBudgets'
import * as notificationsApi from './notifications'
import * as profileApi from './profile'
import { fetchPlaidItems, deleteItem as deletePlaidItem } from './plaidItems'
import { toISODate } from '@/lib/dates'
import type {
  ActivityEntry,
  Category,
  CategoryGroup,
  NotificationPref,
  SavedViewParams,
  Tag,
  Transaction,
  UUID,
  ZbbSettings,
} from '@/types/domain'

export const sbKeys = {
  categories: ['sb', 'categories'] as const,
  rules: ['sb', 'rules'] as const,
  tagRules: ['sb', 'tagRules'] as const,
  merchantMemory: ['sb', 'merchantMemory'] as const,
  transactionsMonth: (iso: string) => ['sb', 'transactions', 'month', iso] as const,
  transactionsMonthAll: (iso: string) => ['sb', 'transactions', 'month-all', iso] as const,
  spendByCategory: (iso: string) => ['sb', 'transactions', 'spendByCategory', iso] as const,
  uncategorizedSpend: (iso: string) => ['sb', 'transactions', 'uncategorizedSpend', iso] as const,
  transferCandidates: (txnId: UUID) => ['sb', 'transactions', 'transferCandidates', txnId] as const,
  transferGroups: (iso: string) => ['sb', 'transactions', 'transferGroups', iso] as const,
  transferGroupLegs: (groupId: UUID) => ['sb', 'transactions', 'transferGroupLegs', groupId] as const,
  transferSuggestions: ['sb', 'transactions', 'transferSuggestions'] as const,
  recent: (days: number) => ['sb', 'transactions', 'recent', days] as const,
  transactionSearch: (q: string) => ['sb', 'transactions', 'search', q] as const,
  uncategorized: (monthKey: string) => ['sb', 'transactions', 'uncategorized', monthKey] as const,
  transactionsByAccount: (accountId: UUID) => ['sb', 'transactions', 'account', accountId] as const,
  accounts: ['sb', 'accounts'] as const,
  // Distinct key from `accounts`: the two hooks share the same base but different
  // query fns (with vs without latest balances). Under one key, whichever mounts
  // first wins the cache, so navigating from a page that used the balance-less
  // `useAccounts` left the Balances page showing accounts with no balances until a
  // hard refresh. Nested under `accounts` so invalidating that prefix still hits both.
  accountsWithBalance: ['sb', 'accounts', 'withBalance'] as const,
  budgetLimits: ['sb', 'budgetLimits'] as const,
  netWorth: (months?: number) => ['sb', 'netWorth', months ?? 'all'] as const,
  currentNetWorth: ['sb', 'netWorth', 'current'] as const,
  separateAccounts: ['sb', 'separateAccounts'] as const,
  // Nested under separateAccounts so invalidating the list prefix also refreshes
  // a detail page's ledger + contributions.
  separateAccountValues: (id: UUID) => ['sb', 'separateAccounts', id, 'values'] as const,
  separateAccountContributions: (id: UUID) =>
    ['sb', 'separateAccounts', id, 'contributions'] as const,
  plaidItems: ['sb', 'plaidItems'] as const,
  tags: ['sb', 'tags'] as const,
  recurring: ['sb', 'recurring'] as const,
  savedViews: ['sb', 'savedViews'] as const,
  zbbSettings: ['sb', 'zbb', 'settings'] as const,
  zbbMonth: (year: number, month: number) => ['sb', 'zbb', 'month', year, month] as const,
  activity: ['sb', 'activity'] as const,
  report: (year: number, month: number) => ['sb', 'report', year, month] as const,
  categoryGroups: ['sb', 'categoryGroups'] as const,
  groupBudgetLimits: ['sb', 'groupBudgetLimits'] as const,
  notifications: ['sb', 'notifications'] as const,
  notificationPrefs: ['sb', 'notificationPrefs'] as const,
  profile: ['sb', 'profile'] as const,
}

export function useCategories() {
  return useQuery({ queryKey: sbKeys.categories, queryFn: cats.fetchCategories })
}
export function useRules() {
  return useQuery({ queryKey: sbKeys.rules, queryFn: cats.fetchRules })
}

/** Add a keyword→category rule. New rules change auto-match suggestions, so refresh the
 *  rules cache and the activity feed (addRule logs an entry). */
export function useAddRule() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (rule: cats.NewRule) => cats.addRule(rule),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: sbKeys.rules })
      qc.invalidateQueries({ queryKey: sbKeys.activity })
    },
  })
}

/** Delete a keyword rule; refresh the rules cache and the activity feed. */
export function useDeleteRule() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: UUID) => cats.deleteRule(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: sbKeys.rules })
      qc.invalidateQueries({ queryKey: sbKeys.activity })
    },
  })
}

// ── Tag→category rules ──────────────────────────────────────────────

export function useTagRules() {
  return useQuery({ queryKey: sbKeys.tagRules, queryFn: tagRulesApi.fetchTagRules })
}

/** Add (or replace) a tag→category rule. When `backfill` is set, also apply the rule to every
 *  already-tagged txn — so refresh transactions (+ budget/ZBB spend) alongside the rules cache. */
export function useAddTagRule() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({
      tagId,
      categoryId,
      backfill,
    }: {
      tagId: UUID
      categoryId: UUID
      backfill?: boolean
    }) => {
      const rule = await tagRulesApi.addTagRule(tagId, categoryId)
      if (backfill) await tagRulesApi.applyTagRule(tagId, categoryId)
      return rule
    },
    onSuccess: (_r, vars) => {
      qc.invalidateQueries({ queryKey: sbKeys.tagRules })
      if (vars.backfill) {
        qc.invalidateQueries({ queryKey: ['sb', 'transactions'] })
        qc.invalidateQueries({ queryKey: sbKeys.budgetLimits })
        qc.invalidateQueries({ queryKey: ['sb', 'zbb'] })
      }
    },
  })
}

export function useDeleteTagRule() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: UUID) => tagRulesApi.deleteTagRule(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: sbKeys.tagRules }),
  })
}

/** "Apply now": backfill every tag rule onto its already-tagged txns. Category changes ripple
 *  into budget/ZBB spend, so refresh those too (mirrors useAutoCategorizeUncategorized). */
export function useApplyAllTagRules() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => tagRulesApi.applyAllTagRules(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sb', 'transactions'] })
      qc.invalidateQueries({ queryKey: sbKeys.budgetLimits })
      qc.invalidateQueries({ queryKey: ['sb', 'zbb'] })
    },
  })
}

/** Apply one tag's rule to one txn when the tag is attached (see TxnTagEditor). */
export function useApplyTagRuleToTransaction() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ transactionId, categoryId }: { transactionId: UUID; categoryId: UUID }) =>
      tagRulesApi.applyTagRuleToTransaction(transactionId, categoryId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sb', 'transactions'] }),
  })
}

/** Create/rename/recolor/re-icon a category. Name/color/icon render everywhere via the
 *  categories cache, so that one key covers display changes. */
export function useUpsertCategory() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (cat: Partial<Category> & { name: string; color: string; icon: string }) =>
      cats.upsertCategory(cat),
    onSuccess: () => qc.invalidateQueries({ queryKey: sbKeys.categories }),
  })
}

/** Persist a new category display order (drag-to-reorder). Writes sort_order per row,
 *  then refreshes the categories cache so every picker/list reflects the new order. */
export function useReorderCategories() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (ordered: Category[]) => cats.reorderCategories(ordered),
    onSuccess: () => qc.invalidateQueries({ queryKey: sbKeys.categories }),
  })
}

/** Delete a category. Cascades its budgets/ZBB/split rows in the DB; transactions fall
 *  back to uncategorized (category_id set null) — refresh everything that shows them. */
export function useDeleteCategory() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: UUID) => cats.deleteCategory(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: sbKeys.categories })
      qc.invalidateQueries({ queryKey: sbKeys.budgetLimits })
      qc.invalidateQueries({ queryKey: ['sb', 'zbb'] })
      qc.invalidateQueries({ queryKey: ['sb', 'transactions'] })
    },
  })
}

// ── Category groups ──────────────────────────────────────────────────────────

export function useCategoryGroups() {
  return useQuery({
    queryKey: sbKeys.categoryGroups,
    queryFn: categoryGroupsApi.fetchCategoryGroups,
  })
}

/** Create or rename a category group. */
export function useUpsertCategoryGroup() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (group: Partial<CategoryGroup> & { name: string }) =>
      categoryGroupsApi.upsertCategoryGroup(group),
    onSuccess: () => qc.invalidateQueries({ queryKey: sbKeys.categoryGroups }),
  })
}

/** Delete a group; the DB ON DELETE SET NULL ungroups its categories automatically. */
export function useDeleteCategoryGroup() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: UUID) => categoryGroupsApi.deleteCategoryGroup(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: sbKeys.categoryGroups })
      // categories.group_id may have been nulled by the cascade
      qc.invalidateQueries({ queryKey: sbKeys.categories })
    },
  })
}

/** Persist a new display order for groups (drag-to-reorder). */
export function useReorderCategoryGroups() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (ordered: CategoryGroup[]) =>
      categoryGroupsApi.reorderCategoryGroups(ordered),
    onSuccess: () => qc.invalidateQueries({ queryKey: sbKeys.categoryGroups }),
  })
}

/** Assign a category to a group, or clear its group when groupId is null. */
export function useSetCategoryGroup() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ categoryId, groupId }: { categoryId: UUID; groupId: UUID | null }) =>
      categoryGroupsApi.setCategoryGroup(categoryId, groupId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: sbKeys.categories })
      qc.invalidateQueries({ queryKey: sbKeys.categoryGroups })
    },
  })
}

// ── Group budget limits ───────────────────────────────────────────────────────

export function useGroupBudgetLimits() {
  return useQuery({
    queryKey: sbKeys.groupBudgetLimits,
    queryFn: groupBudgetsApi.fetchGroupBudgetLimits,
  })
}

export function useSaveGroupBudget() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({
      groupId,
      monthlyLimit,
      month,
    }: {
      groupId: UUID
      monthlyLimit: number
      month: Date
    }) => groupBudgetsApi.saveGroupBudget(groupId, monthlyLimit, { month }),
    onSuccess: () => qc.invalidateQueries({ queryKey: sbKeys.groupBudgetLimits }),
  })
}

export function useDeleteGroupBudget() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ groupId, month }: { groupId: UUID; month: Date }) =>
      groupBudgetsApi.deleteGroupBudget(groupId, { month }),
    onSuccess: () => qc.invalidateQueries({ queryKey: sbKeys.groupBudgetLimits }),
  })
}

export function useMerchantMemory() {
  return useQuery({ queryKey: sbKeys.merchantMemory, queryFn: txns.fetchMerchantMemory })
}
/** Cache-key fragment for a month (unpadded, e.g. "2026-7") — one spelling so every
 *  month-scoped key matches and invalidates together. */
function monthKey(month: Date): string {
  return `${month.getFullYear()}-${month.getMonth() + 1}`
}

export function useTransactionsMonth(month: Date) {
  return useQuery({
    queryKey: sbKeys.transactionsMonth(monthKey(month)),
    queryFn: () => txns.fetchTransactions(month),
  })
}
/** Splits-aware spend per category for a month, from the `category_spend` view — the
 *  cross-client source of truth. Use this instead of fetching every month txn just to
 *  re-sum client-side (the old `domain.categorySpend` path). Returns rows sorted by
 *  spend desc. */
export function useSpendByCategory(month: Date) {
  return useQuery({
    queryKey: sbKeys.spendByCategory(monthKey(month)),
    queryFn: () => txns.fetchSpendByCategory(month),
  })
}

/** Total spend for transactions with no category this month — the "ghost spending"
 *  that the category_spend view omits because it requires category_id IS NOT NULL. */
export function useUncategorizedSpend(month: Date) {
  return useQuery({
    queryKey: sbKeys.uncategorizedSpend(monthKey(month)),
    queryFn: () => txns.fetchUncategorizedSpend(month),
  })
}

/** Month transactions including excluded/transfer rows (Transactions page, so transfers
 *  stay visible + unlinkable). Separate cache key from useTransactionsMonth. */
export function useTransactionsMonthAll(month: Date) {
  return useQuery({
    queryKey: sbKeys.transactionsMonthAll(monthKey(month)),
    queryFn: () => txns.fetchTransactions(month, { includeExcluded: true }),
  })
}
export function useRecent(days: number) {
  return useQuery({ queryKey: sbKeys.recent(days), queryFn: () => txns.fetchRecent(days) })
}
/** Server-side search (all months). Pass the already-debounced query; disabled
 *  while blank. Nested under ['sb','transactions'] so mutations invalidate it. */
export function useTransactionSearch(q: string) {
  return useQuery({
    queryKey: sbKeys.transactionSearch(q),
    queryFn: () => txns.searchTransactions(q),
    enabled: q.trim().length > 0,
    // keep the previous results on screen while the next query loads
    placeholderData: (prev: Transaction[] | undefined) => prev,
    // every distinct query string is its own cache key and is never re-typed
    // exactly — collect them quickly instead of the default 5 minutes
    gcTime: 30_000,
  })
}
/** The "To Categorize" queue, scoped to `month` (banner + review flow). */
export function useUncategorized(month: Date) {
  return useQuery({
    queryKey: sbKeys.uncategorized(`${month.getFullYear()}-${month.getMonth()}`),
    queryFn: () => txns.fetchUncategorized(month),
  })
}
/** All transactions for a single account (for AccountDetailPage). */
export function useTransactionsByAccount(accountId: UUID) {
  return useQuery({
    queryKey: sbKeys.transactionsByAccount(accountId),
    queryFn: () => txns.fetchTransactionsByAccount(accountId),
    enabled: Boolean(accountId),
  })
}

export function useAccountsWithBalance() {
  return useQuery({
    queryKey: sbKeys.accountsWithBalance,
    queryFn: accts.fetchAccountsWithLatestBalance,
  })
}
export function useAccounts() {
  return useQuery({ queryKey: sbKeys.accounts, queryFn: accts.fetchAccounts })
}

/** Soft-delete a single Plaid account (sets is_active = false). The institution
 *  link is preserved so other accounts under the same institution keep syncing. */
export function useHideAccount() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (accountId: string) => accts.hideAccount(accountId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: sbKeys.accounts })
      qc.invalidateQueries({ queryKey: sbKeys.currentNetWorth })
      qc.invalidateQueries({ queryKey: ['sb', 'netWorth'] })
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Could not delete account'),
  })
}

/** Most-recent reported balance for one account — for the account detail header. */
export function useLatestBalance(accountId: UUID) {
  return useQuery({
    queryKey: ['sb', 'accounts', accountId, 'latestBalance'] as const,
    queryFn: () => accts.fetchLatestBalance(accountId),
    enabled: Boolean(accountId),
  })
}

/** Change an account's type. Refreshes the accounts list. */
export function usePatchAccountType() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ accountId, type }: { accountId: string; type: string }) =>
      accts.patchAccountType(accountId, type),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: sbKeys.accounts })
      qc.invalidateQueries({ queryKey: sbKeys.currentNetWorth })
      qc.invalidateQueries({ queryKey: ['sb', 'netWorth'] })
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Could not update account type'),
  })
}

/** Hard-delete an account and cascade its transactions. Unlinks transfer legs on other
 *  accounts first. Refreshes accounts + net worth + transactions caches. */
export function useDeleteAccount() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (accountId: string) => accts.deleteAccount(accountId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: sbKeys.accounts })
      qc.invalidateQueries({ queryKey: sbKeys.currentNetWorth })
      qc.invalidateQueries({ queryKey: ['sb', 'netWorth'] })
      qc.invalidateQueries({ queryKey: ['sb', 'transactions'] })
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Could not delete account'),
  })
}

export function useBudgetLimits() {
  return useQuery({ queryKey: sbKeys.budgetLimits, queryFn: budgetsApi.fetchBudgetLimits })
}
export function useNetWorth(months?: number) {
  return useQuery({ queryKey: sbKeys.netWorth(months), queryFn: () => nw.fetchSnapshots(months) })
}
export function useCurrentNetWorth() {
  return useQuery({ queryKey: sbKeys.currentNetWorth, queryFn: accts.fetchCurrentNetWorth })
}
export function useSeparateAccounts() {
  return useQuery({ queryKey: sbKeys.separateAccounts, queryFn: sep.fetchSeparateAccounts })
}

// ── Manual "separate" accounts — value ledger + recurring contributions ───────
// A separate account's balance = SUM(values), so any value/contribution mutation
// changes its balance and therefore net worth (current_net_worth folds them in).
// Nesting the per-account keys under sbKeys.separateAccounts means invalidating
// that prefix refreshes the list card, the detail balance, and the ledger at once.
function invalidateSeparateAccounts(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: sbKeys.separateAccounts })
  qc.invalidateQueries({ queryKey: ['sb', 'netWorth'] })
}

export function useSeparateAccountValues(accountId: UUID) {
  return useQuery({
    queryKey: sbKeys.separateAccountValues(accountId),
    queryFn: () => sep.fetchValues(accountId),
  })
}

export function useSeparateAccountContributions(accountId: UUID) {
  return useQuery({
    queryKey: sbKeys.separateAccountContributions(accountId),
    queryFn: () => sep.fetchContributions(accountId),
  })
}

/** Create a manual account, optionally seeding a starting balance and a recurring
 *  contribution in one action (mirrors iOS AddSeparateAccountSheet). */
export function useCreateSeparateAccount() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (input: {
      name: string
      type: string
      startingBalance?: number | null
      recurring?: { delta: number; frequencyInDays: number; anchorISO: string } | null
    }) => {
      const account = await sep.createSeparateAccount({
        name: input.name,
        type: input.type,
        currency: 'USD',
      })
      if (input.startingBalance != null) {
        await sep.addValue({
          separate_account_id: account.id,
          date: toISODate(new Date()),
          amount: input.startingBalance,
          note: 'Starting balance',
        })
      }
      if (input.recurring) {
        await sep.addContribution({
          separate_account_id: account.id,
          delta_balance: input.recurring.delta,
          frequency_in_days: input.recurring.frequencyInDays,
          anchor_date: input.recurring.anchorISO,
        })
      }
      return account
    },
    onSuccess: () => invalidateSeparateAccounts(qc),
  })
}

export function useDeleteSeparateAccount() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: UUID) => sep.deleteSeparateAccount(id),
    onSuccess: () => invalidateSeparateAccounts(qc),
  })
}

export function useAddSeparateAccountValue() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (payload: {
      separate_account_id: UUID
      date: string
      amount: number
      note: string | null
    }) => sep.addValue(payload),
    onSuccess: () => invalidateSeparateAccounts(qc),
  })
}

export function useAddContribution() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (payload: {
      separate_account_id: UUID
      delta_balance: number
      frequency_in_days: number
      anchor_date: string
    }) => sep.addContribution(payload),
    onSuccess: () => invalidateSeparateAccounts(qc),
  })
}

export function useDeleteContribution() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: UUID) => sep.deleteContribution(id),
    onSuccess: () => invalidateSeparateAccounts(qc),
  })
}
export function usePlaidItems() {
  return useQuery({
    queryKey: sbKeys.plaidItems,
    queryFn: fetchPlaidItems,
    // While any bank is mid-sync, poll so is_syncing (and last_synced_at) update
    // live; stop once every item settles. Drives the in-progress indicator.
    refetchInterval: (query) =>
      (query.state.data ?? []).some((i) => i.is_syncing) ? 3_000 : false,
  })
}

/** True while any linked bank is mid-sync (per-item lock). Powers the "Syncing…"
 *  indicator on Balances + Settings. Reuses the usePlaidItems cache. */
export function useSyncInProgress(): boolean {
  const { data } = usePlaidItems()
  return (data ?? []).some((i) => i.is_syncing)
}

/** Unlink a Plaid bank. On success, clears the plaidItems cache and also
 *  invalidates accounts + transactions since those rows were deleted server-side. */
export function useDeletePlaidItem() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (itemId: string) => deletePlaidItem(itemId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: sbKeys.plaidItems })
      qc.invalidateQueries({ queryKey: sbKeys.accounts })
      qc.invalidateQueries({ queryKey: ['sb', 'transactions'] })
      qc.invalidateQueries({ queryKey: sbKeys.currentNetWorth })
      qc.invalidateQueries({ queryKey: ['sb', 'netWorth'] })
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Could not unlink bank'),
  })
}

// ── Plaid sync trigger + post-sync refresh ───────────────────────────────────
// /sync/trigger fires an async Plaid pull that returns immediately, so an instant
// refetch would race the background write. Instead, invalidate everything a Plaid
// sync can change — accounts + latest balances, the net-worth view + its snapshot
// trend (['sb','netWorth'] prefix covers both), freshly-written transactions, and
// plaid_items' last_synced_at — twice: soon after the trigger and again a few
// seconds later, so a fast sync shows quickly and a slow one still lands. Shared by
// the Sync buttons on Balances and Settings.
const SYNC_REFRESH_DELAYS_MS = [3_000, 8_000]

export function useTriggerSync() {
  const qc = useQueryClient()
  const timers = useRef<ReturnType<typeof setTimeout>[]>([])
  // Don't let a queued refetch fire after the button's page unmounts.
  useEffect(() => () => timers.current.forEach(clearTimeout), [])

  return useMutation({
    mutationFn: triggerSync,
    onSuccess: () => {
      toast.success('Syncing… balances will update shortly.')
      const refresh = () => {
        qc.invalidateQueries({ queryKey: sbKeys.accounts })
        qc.invalidateQueries({ queryKey: ['sb', 'netWorth'] })
        qc.invalidateQueries({ queryKey: ['sb', 'transactions'] })
        qc.invalidateQueries({ queryKey: sbKeys.plaidItems })
      }
      timers.current = SYNC_REFRESH_DELAYS_MS.map((ms) => setTimeout(refresh, ms))
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Sync failed'),
  })
}

/** Full sync: reset every bank's cursor and re-pull the full 730-day window.
 *  Rate-limited server-side — a `cooldown` result surfaces as an info toast with
 *  the next-available time instead of an error. Shared refresh logic with
 *  useTriggerSync (invalidate everything a Plaid sync can change). */
export function useBackfillAll() {
  const qc = useQueryClient()
  const timers = useRef<ReturnType<typeof setTimeout>[]>([])
  useEffect(() => () => timers.current.forEach(clearTimeout), [])

  return useMutation({
    mutationFn: backfillAll,
    onSuccess: (res: BackfillAllResult) => {
      if (res.status === 'cooldown') {
        const when = res.next_at ? new Date(res.next_at).toLocaleString() : 'soon'
        toast.info(`Full sync ran recently. Next one available ${when}.`)
        return
      }
      toast.success('Full sync started — re-importing history may take a few minutes.')
      // Flip is_syncing right away so the in-progress poll (usePlaidItems) starts.
      qc.invalidateQueries({ queryKey: sbKeys.plaidItems })
      const refresh = () => {
        qc.invalidateQueries({ queryKey: sbKeys.accounts })
        qc.invalidateQueries({ queryKey: ['sb', 'netWorth'] })
        qc.invalidateQueries({ queryKey: ['sb', 'transactions'] })
        qc.invalidateQueries({ queryKey: sbKeys.plaidItems })
      }
      timers.current = SYNC_REFRESH_DELAYS_MS.map((ms) => setTimeout(refresh, ms))
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Full sync failed'),
  })
}

export function useTags() {
  return useQuery({ queryKey: sbKeys.tags, queryFn: tagsApi.fetchTags })
}

/** Create/rename/recolor a tag. */
export function useUpsertTag() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (tag: Partial<Tag> & { name: string; color: string }) =>
      tagsApi.upsertTag(tag),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: sbKeys.tags })
      qc.invalidateQueries({ queryKey: ['sb', 'transactions'] })
    },
  })
}

export function useDeleteTag() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: UUID) => tagsApi.deleteTag(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: sbKeys.tags })
      qc.invalidateQueries({ queryKey: ['sb', 'transactions'] })
    },
  })
}

/** Attach/detach a tag on a transaction; refresh the txn lists so chips update. */
export function useToggleTransactionTag() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({
      transactionId,
      tagId,
      attach,
    }: {
      transactionId: UUID
      tagId: UUID
      attach: boolean
    }) =>
      attach
        ? tagsApi.addTagToTransaction(transactionId, tagId)
        : tagsApi.removeTagFromTransaction(transactionId, tagId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sb', 'transactions'] }),
  })
}

/** Save/replace a transaction's splits (empty = clear). Refresh txn + budget/spend views. */
export function useSetSplits() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ transactionId, splits }: { transactionId: UUID; splits: splitsApi.SplitInput[] }) =>
      splitsApi.setSplits(transactionId, splits),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sb', 'transactions'] }),
  })
}

/** Match candidates for linking `txn` as a transfer (opposite leg). Enabled lazily. */
export function useTransferCandidates(txn: Transaction | null) {
  return useQuery({
    queryKey: sbKeys.transferCandidates(txn?.id ?? ('none' as UUID)),
    queryFn: () => transfersApi.findTransferCandidates(txn!),
    enabled: txn != null,
  })
}

/** Link two legs into a transfer; refresh txn lists (both legs drop from totals). */
export function useLinkTransfer() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ a, b }: { a: Transaction; b: Transaction }) =>
      transfersApi.linkTransfer(a, b),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sb', 'transactions'] }),
  })
}

/** Unlink a transfer group; refresh txn lists (legs re-enter totals). */
export function useUnlinkTransfer() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (groupId: UUID) => transfersApi.unlinkTransfer(groupId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sb', 'transactions'] }),
  })
}

/** A month's transfer groups ({groupId → legs}) for the Transfers tab. */
export function useTransferGroups(month: Date) {
  return useQuery({
    queryKey: sbKeys.transferGroups(monthKey(month)),
    queryFn: () => transfersApi.fetchTransferGroups(month),
  })
}

/** All legs of a single transfer group — used in the transaction detail modal to show
 *  the from→to route when only one leg is in scope. Pass null to skip. */
export function useTransferGroupLegs(groupId: UUID | null) {
  return useQuery({
    queryKey: sbKeys.transferGroupLegs(groupId ?? ('none' as UUID)),
    queryFn: () => transfersApi.fetchTransferGroupLegs(groupId!),
    enabled: groupId != null,
  })
}

/** Likely-transfer pairs the auto-detector declined (no Plaid signal / ambiguous). */
export function useTransferSuggestions() {
  return useQuery({
    queryKey: sbKeys.transferSuggestions,
    queryFn: () => transfersApi.findTransferSuggestions(),
  })
}

/** "Not a transfer" on a suggested pair: opts both rows out of future matching. */
export function useDismissSuggestion() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ a, b }: { a: Transaction; b: Transaction }) =>
      transfersApi.dismissSuggestion(a, b),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sb', 'transactions'] }),
  })
}

/** Hide/unhide a transaction; refresh txn lists + totals (row enters/leaves totals). */
export function useSetHidden() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ txn, hidden }: { txn: Transaction; hidden: boolean }) =>
      txns.setHidden(txn, hidden),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sb', 'transactions'] }),
  })
}

/** Detected recurring series (client-side) with the user's overrides applied. */
export function useRecurringSeries() {
  return useQuery({ queryKey: sbKeys.recurring, queryFn: recurringApi.fetchRecurringSeries })
}

/** Set/clear a series decision (confirm/ignore/remove, or null to reset to suggested). */
export function useSetRecurringStatus() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({
      merchantKey,
      status,
    }: {
      merchantKey: string
      status: recurringApi.RecurringStatus | null
    }) =>
      status && status !== 'suggested'
        ? recurringApi.setRecurringStatus(merchantKey, status)
        : recurringApi.clearRecurringStatus(merchantKey),
    onSuccess: () => qc.invalidateQueries({ queryKey: sbKeys.recurring }),
  })
}

/** Apply a category to every occurrence of a series; refresh recurring + txn views. */
export function useCategorizeRecurringSeries() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ occurrenceIds, categoryId }: { occurrenceIds: UUID[]; categoryId: UUID }) =>
      recurringApi.categorizeRecurringSeries(occurrenceIds, categoryId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: sbKeys.recurring })
      qc.invalidateQueries({ queryKey: ['sb', 'transactions'] })
    },
  })
}

/** Named filter sets for the transactions list, persisted in Supabase. */
export function useSavedViews() {
  return useQuery({ queryKey: sbKeys.savedViews, queryFn: savedViewsApi.fetchSavedViews })
}

/** Save the current filter set under a name; refresh the saved-views list. */
export function useCreateSavedView() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ name, params }: { name: string; params: SavedViewParams }) =>
      savedViewsApi.createSavedView(name, params),
    onSuccess: () => qc.invalidateQueries({ queryKey: sbKeys.savedViews }),
  })
}

export function useDeleteSavedView() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: UUID) => savedViewsApi.deleteSavedView(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: sbKeys.savedViews }),
  })
}

/** Import parsed CSV rows into an account; refresh txn lists, budgets, net worth. */
export function useImportTransactions() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ accountId, rows }: { accountId: UUID; rows: txns.ImportRow[] }) =>
      txns.importTransactions(accountId, rows),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sb', 'transactions'] })
      qc.invalidateQueries({ queryKey: sbKeys.accounts })
      qc.invalidateQueries({ queryKey: ['sb', 'netWorth'] })
    },
  })
}

/** Invalidate everything that changes when a transaction's category changes. */
export function useSetCategory() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ txn, categoryId }: { txn: Transaction; categoryId: UUID | null }) =>
      txns.setCategory(txn, categoryId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sb', 'transactions'] })
      qc.invalidateQueries({ queryKey: sbKeys.merchantMemory })
    },
  })
}

/** Mark/unmark a credit as a reimbursement (contra-expense). Changes both the flag and
 *  the offset category, which ripple into category spend, budgets, and ZBB — so refresh
 *  transactions + budgets + zbb. */
export function useSetReimbursement() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({
      transactionId,
      isReimbursement,
      categoryId,
    }: {
      transactionId: UUID
      isReimbursement: boolean
      categoryId: UUID | null
    }) => txns.setReimbursement(transactionId, isReimbursement, categoryId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sb', 'transactions'] })
      qc.invalidateQueries({ queryKey: sbKeys.budgetLimits })
      qc.invalidateQueries({ queryKey: ['sb', 'zbb'] })
    },
  })
}

// ── Activity log + Undo ──────────────────────────────────────────────────────

/** Newest-first activity feed (best-effort; empty if the table is briefly absent). */
export function useActivity() {
  return useQuery({ queryKey: sbKeys.activity, queryFn: activityApi.fetchActivity })
}

/** Undo an activity entry — apply the inverse mutation, mark it undone, then refresh
 *  the feed plus every domain an undo can touch (txns, budgets, rules, categories). */
export function useUndoActivity() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (entry: ActivityEntry) => activityApi.undoActivity(entry),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: sbKeys.activity })
      qc.invalidateQueries({ queryKey: ['sb', 'transactions'] })
      qc.invalidateQueries({ queryKey: sbKeys.budgetLimits })
      qc.invalidateQueries({ queryKey: sbKeys.rules })
      qc.invalidateQueries({ queryKey: sbKeys.merchantMemory })
      qc.invalidateQueries({ queryKey: ['sb', 'zbb'] })
    },
  })
}

// ── Monthly reports (client-side from Supabase) ──────────────────────────────

/** The monthly report for a selected year/month: stat metrics, the cumulative-vs-prior
 *  line, and split-aware category/subcategory/tag breakdowns. Computed client-side —
 *  no FastAPI. Kept briefly fresh since a month's data changes rarely mid-session. */
export function useReport(year: number, month: number) {
  return useQuery({
    queryKey: sbKeys.report(year, month),
    queryFn: () => reportsApi.fetchReport(year, month),
    staleTime: 60 * 1000,
  })
}

// ── Zero-sum (zero-based) budgeting ──────────────────────────────────────────
export function useZbbSettings() {
  return useQuery({ queryKey: sbKeys.zbbSettings, queryFn: zbbApi.fetchZbbSettings })
}

/** The viewed month's overview (rollover chain + Ready-to-Assign). */
export function useZbbMonth(year: number, month: number) {
  return useQuery({
    queryKey: sbKeys.zbbMonth(year, month),
    queryFn: () => zbbApi.fetchZbbMonth(year, month),
  })
}

/** Every ZBB mutation can shift Ready-to-Assign across months, so refresh all zbb queries. */
function invalidateZbb(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: ['sb', 'zbb'] })
}

export function useSaveZbbSettings() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (patch: Partial<ZbbSettings>) => zbbApi.saveZbbSettings(patch),
    onSuccess: () => invalidateZbb(qc),
  })
}

export function useSetZbbAssignment() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ categoryId, year, month, assigned }: {
      categoryId: UUID; year: number; month: number; assigned: number
    }) => zbbApi.setAssignment(categoryId, year, month, assigned),
    onSuccess: () => invalidateZbb(qc),
  })
}

export function useZbbMoveMoney() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ year, month, from, to, amount }: {
      year: number; month: number; from: UUID; to: UUID; amount: number
    }) => zbbApi.moveMoney(year, month, from, to, amount),
    onSuccess: () => invalidateZbb(qc),
  })
}

/** Accept the "categorize similar?" bulk prompt — apply the category to the merchant's
 *  other uncategorized txns (no re-learning; useSetCategory already updated memory). */
export function useBulkCategorizeMerchant() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ merchantKey, categoryId }: { merchantKey: string; categoryId: UUID }) =>
      txns.bulkCategorizeSameMerchant(merchantKey, categoryId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sb', 'transactions'] }),
  })
}

/** One-tap "Auto-categorize uncategorized": apply merchant memory + keyword rules to every
 *  uncategorized txn. Resolves to the count applied. Category changes ripple into budget/ZBB
 *  spend, so refresh those too. */
export function useAutoCategorizeUncategorized() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => txns.autoCategorizeUncategorized(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sb', 'transactions'] })
      qc.invalidateQueries({ queryKey: sbKeys.budgetLimits })
      qc.invalidateQueries({ queryKey: ['sb', 'zbb'] })
    },
  })
}

// ── Alerts & notifications ──────────────────────────────────────────
// Data layer only in Phase A; the Bell inbox UI is a later phase.

/** Newest-first notification inbox. */
export function useNotifications() {
  return useQuery({ queryKey: sbKeys.notifications, queryFn: notificationsApi.fetchNotifications })
}

/** Unread badge count, derived from the inbox query (no extra request). */
export function useUnreadNotificationCount(): number {
  const { data } = useNotifications()
  return (data ?? []).filter((n) => n.read_at == null).length
}

export function useMarkNotificationRead() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: UUID) => notificationsApi.markNotificationRead(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: sbKeys.notifications }),
  })
}

export function useMarkAllNotificationsRead() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => notificationsApi.markAllNotificationsRead(),
    onSuccess: () => qc.invalidateQueries({ queryKey: sbKeys.notifications }),
  })
}

export function useDeleteNotification() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: UUID) => notificationsApi.deleteNotification(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: sbKeys.notifications }),
  })
}

export function useDeleteAllNotifications() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => notificationsApi.deleteAllNotifications(),
    onSuccess: () => qc.invalidateQueries({ queryKey: sbKeys.notifications }),
  })
}

/** The user's per-type alert preferences (thresholds + on/off). */
export function useNotificationPrefs() {
  return useQuery({
    queryKey: sbKeys.notificationPrefs,
    queryFn: notificationsApi.fetchNotificationPrefs,
  })
}

/** Create/update one alert type's preference; refresh the prefs cache. */
export function useUpsertNotificationPref() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (pref: Partial<NotificationPref> & { type: string }) =>
      notificationsApi.upsertNotificationPref(pref),
    onSuccess: () => qc.invalidateQueries({ queryKey: sbKeys.notificationPrefs }),
  })
}

// ── Profile (first/last name) ────────────────────────────────────────────────

/** The signed-in user's profile row (first/last name), or null if not seeded yet. */
export function useMyProfile() {
  return useQuery({ queryKey: sbKeys.profile, queryFn: profileApi.fetchMyProfile })
}

/** Update the signed-in user's first/last name; refresh the profile cache. */
export function useUpdateMyProfile() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (patch: { first_name: string | null; last_name: string | null }) =>
      profileApi.updateMyProfile(patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: sbKeys.profile }),
  })
}

// ── Account deletion ─────────────────────────────────────────────────────────

/** Permanently delete the signed-in user's entire account and all their data.
 *  Calls DELETE /account on the backend (which uses auth.admin.delete_user),
 *  cascading through every user-owned table via on-delete-cascade FK constraints.
 *  This is irreversible — the caller must confirm in the UI before invoking. */
export function useDeleteMyAccount() {
  return useMutation({
    mutationFn: accts.deleteMyAccount,
  })
}
