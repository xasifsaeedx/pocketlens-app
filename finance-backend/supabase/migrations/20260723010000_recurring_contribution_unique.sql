-- stop overlapping syncs from double-counting recurring contributions.
--
-- materialize_recurring_contributions (sync-service/sync.py) reads a flow's
-- last_applied_date, inserts one separate_account_values row per elapsed period,
-- then advances last_applied_date. That read -> insert -> advance is unlocked, so
-- two overlapping syncs (the daily cron + an app/webhook-triggered sync) can both
-- read the same last_applied_date and both insert the same period rows,
-- permanently inflating net worth.
--
-- Fix: give each materialized value row a link back to the recurring flow that
-- produced it, plus a UNIQUE (recurring_contribution_id, date) key, so a second
-- insert of the same (flow, period) can't land. sync.py upserts these rows with
-- on_conflict=(recurring_contribution_id,date) do-nothing to match, so the
-- constraint never raises in normal operation.
--
-- Why the natural key needs the flow id, not (separate_account_id, date): two
-- different recurring flows can target the same separate account, and a user can
-- record several manual values on one date -- both are legitimate, so keying on
-- the account+date would wrongly reject them. The flow id + period date is the
-- true identity of a materialized period.
--
-- Manually-entered values keep recurring_contribution_id NULL; NULLs are distinct
-- in a btree unique index, so multiple manual values on one date for one account
-- are still allowed. Existing historical rows predate the column and stay NULL
-- (not backfilled -- a value row can't be reliably re-attributed to a flow), so
-- index creation never collides on an existing database.
--
-- Fresh-DB safe and idempotent: add column / create index are IF [NOT] EXISTS.
-- RLS unaffected -- the row's user_id and the "own" policy are unchanged; deleting
-- a flow keeps the values it already recorded (on delete set null), matching the
-- rule that deleting a recurring rule must not rewrite recorded net-worth history.

alter table separate_account_values
  add column if not exists recurring_contribution_id uuid
    references recurring_contributions(id) on delete set null;

create unique index if not exists separate_account_values_recurring_period_key
  on separate_account_values (recurring_contribution_id, date);
