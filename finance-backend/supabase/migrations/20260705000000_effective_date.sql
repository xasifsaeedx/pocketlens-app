-- ============================================================
-- TRANSACTION effective_date
--   Bug: the app filters a month by Plaid's posted `date` but groups/displays
--   rows by authorized_date ?? date. A purchase authorized June 30 but posted
--   July 1 gets pulled into the July query, then rendered under June 30 — so
--   "June transactions show in the July view".
--
--   Fix: a single generated column = coalesce(authorized_date, date). The app
--   filters AND displays by it, so fetch and grouping always agree. STORED so
--   existing rows are computed at ALTER time and it can be indexed.
-- ============================================================
alter table transactions
  add column effective_date date generated always as (coalesce(authorized_date, date)) stored;

create index idx_transactions_effective_date on transactions(effective_date desc);
