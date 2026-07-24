-- ============================================================
-- ALERTS & PUSH NOTIFICATIONS (Phase A — schema only)
--   Foundation for the alerts feature: per-user notification preferences, the
--   generated alert events clients display, and APNs device tokens. UI, backend
--   evaluation, and iOS push land in later phases; this migration is schema only.
--
--   Source of truth lives here so iOS and web share one schema; clients only add
--   UI. Each table carries user_id (default auth.uid()) so RLS is a flat
--   `user_id = auth.uid()` like every other table — no subquery joins.
--
--   The backend (service_role, bypasses RLS) inserts `notifications` with an
--   explicit user_id; the `authenticated` grants let clients read/mark-read/delete
--   their own notifications and manage their prefs + device tokens.
-- ============================================================

-- Per-(user, type) preference: is this alert on, and its per-type thresholds.
--   `type` is an open enum (values used by later phases: budget_threshold,
--   large_charge, low_balance, sync_failed, daily_spend, bill_due,
--   periodic_digest). No CHECK constraint — a new alert type is data, not a
--   migration.
create table notification_prefs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  type text not null,
  enabled boolean not null default true,
  config jsonb not null default '{}'::jsonb,   -- e.g. {"pct":90}, {"amount":200}, {"cadence":"weekly"}
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint notification_prefs_user_type unique (user_id, type)
);
create index idx_notification_prefs_user on notification_prefs(user_id);

-- Generated alert events the clients display in the inbox.
--   `dedup_key` lets the backend avoid re-firing the same alert (e.g.
--   "budget_threshold:<cat>:2026-07"); the partial unique index enforces once
--   per user while leaving ad-hoc (null-key) notifications unconstrained.
create table notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  type text not null,
  title text not null,
  body text not null,
  payload jsonb not null default '{}'::jsonb,   -- deep-link context, e.g. category_id/account_id/transaction_id
  dedup_key text,
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index idx_notifications_user on notifications(user_id);
create unique index idx_notifications_dedup
  on notifications(user_id, dedup_key) where dedup_key is not null;
create index idx_notifications_user_created on notifications(user_id, created_at desc);

-- APNs push targets, registered by the iOS client in a later phase.
create table device_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  token text not null,
  platform text not null default 'ios',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint device_tokens_user_token unique (user_id, token)
);
create index idx_device_tokens_user on device_tokens(user_id);

alter table notification_prefs enable row level security;
create policy "own" on notification_prefs for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

alter table notifications enable row level security;
create policy "own" on notifications for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

alter table device_tokens enable row level security;
create policy "own" on device_tokens for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- API-role grants (mirror 20260707; implicit defaults aren't present on a fresh stack).
grant all on all tables in schema public to service_role;
grant select, insert, update, delete on notification_prefs to authenticated;
grant select, insert, update, delete on notifications to authenticated;
grant select, insert, update, delete on device_tokens to authenticated;
