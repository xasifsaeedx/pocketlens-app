-- Add backfill_requested flag on plaid_items.
-- When set true, the next cron/webhook sync run treats this item as if it
-- has no cursor (full historical re-fetch from Plaid, up to 730 days).
alter table plaid_items
  add column if not exists backfill_requested boolean not null default false;
