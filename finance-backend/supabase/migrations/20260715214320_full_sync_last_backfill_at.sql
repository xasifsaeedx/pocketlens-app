-- ============================================================
-- FULL SYNC cooldown: track when each item last had a full-history re-pull.
--
-- POST /backfill-all resets every cursor to re-pull the 730d window. That is
-- expensive (drains full history from Plaid), so it's rate-limited per user.
-- last_backfill_at records the last full sync; the endpoint blocks another
-- until FULL_SYNC_COOLDOWN_DAYS have passed. NULL = never full-synced.
--
-- The incremental /sync/trigger path is unaffected — it never writes this.
-- ============================================================

alter table plaid_items
  add column if not exists last_backfill_at timestamptz;
