# Features

What PocketLens does, grouped by area.

## Auth & accounts

- Email/password sign-up and sign-in (Supabase Auth), multi-user with per-user RLS isolation.
- Interactive demo: when logged out, the home page shows the app running on sample data
  (read-only, no database calls) instead of a login wall.
- Forgot-password / reset flow via emailed recovery link.
- User profile (first/last name) captured at signup, shown in Settings.
- Password policy enforced client-side (10+ characters plus complexity).

## Bank & manual accounts

- Link banks and brokerages through Plaid; institution logos and names shown per account.
- Accounts grouped into a net-worth header with a Liquid / Semi-liquid / Liabilities split, and
  an Assets vs Liabilities T-account layout.
- Manual "separate" accounts (non-Plaid): balance ledger with add/subtract entries and recurring
  contributions.
- Net worth over time chart from daily snapshots.
- Quick incremental sync (cursor delta) and a full 730-day re-import (rate-limited by a cooldown).
- Real-time updates via Plaid webhooks, with a daily cron as safety net plus a drift reconciler.

## Transactions

- Month-navigated transaction list with per-month Spent / Income totals.
- Cross-month search (substring + trigram typo tolerance + amount match).
- Tap-to-categorize, a swipe-to-categorize review queue, and bulk-categorize by merchant.
- Auto-categorization: per-merchant learned memory plus keyword rules with optional money
  direction and amount conditions; one-click auto-categorize of everything uncategorized.
- Tags: create, attach/detach, filter by tag; tag→category rules that set a category on attach.
- Transaction splits across multiple categories (splits sum to the transaction amount).
- Transfers: automatic detection of paired legs across accounts (bank↔bank, bank↔brokerage),
  one-sided external moves, manual link/unlink, and suggestion cards for fuzzy matches. Transfer
  legs are excluded from spend/income totals.
- Reimbursements (contra-expense): flag an incoming credit to offset a category's spend rather
  than count as income; card refunds on credit/loan accounts are auto-flagged.
- Hidden transactions: keep a row but drop it from totals and the categorize queue.
- Recurring-charge detection (cadence + consistent amount) with confirm / ignore / remove and
  per-series bulk categorize.
- CSV export of the current transaction view.

## Budgets

- Per-category monthly limits, effective-dated so each past month shows its true historical
  limit against that month's spend; editable per-month.
- Create, edit, and delete categories, with color, icon, and drag or keyboard reorder.
- Zero-based budgeting (opt-in): income-driven, assign every dollar until Ready-to-Assign = 0,
  cover overspend by moving money between envelopes, with month-to-month rollover
  (strict/flexible) and an overspend-cover prompt.
- Spending health check (savings rate) and spend-by category / tag / category-group donuts.
- Budget spend pie with tap-to-select category drill-down.

## Explore & reports

- Explore page: filter transactions by account, category, tag, amount, and date range, with
  saved filter sets.
- Summary stats: total spending, total income, net cash flow, transaction count, average size.
- Breakdown donuts (spend by category / tag / group) using each entity's stored color, and a
  daily income-vs-spending activity chart. Hovering a slice or day lists the transactions behind
  it.

## Settings

- Manage linked banks; add a bank, quick sync, and full sync.
- Guided Plaid onboarding wizard for bringing your own Plaid developer account, with a manual
  key-entry fallback. Per-user credentials are validated against Plaid and stored
  Fernet-encrypted.
- Category, tag, and auto-classify rule management.
- Activity log of undoable mutations (categorize, hide, budget, rule changes) with one-tap undo.
- In-app notification inbox and per-type alert preferences (budget threshold, large charge, low
  balance, sync failure, spend digests) with threshold controls.
- Light / Dark / System theme toggle; profile name; sign out.
</content>
