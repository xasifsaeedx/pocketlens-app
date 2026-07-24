-- plaid_items uses column-level SELECT grants (access_token & other secrets are
-- withheld from clients). Three columns the web/iOS clients legitimately read were
-- added later WITHOUT a grant to the `authenticated` role:
--   * is_syncing        — per-item sync lock, powers the "Syncing…" indicator
--   * sync_started_at    — when the current sync acquired that lock
--   * last_backfill_at   — gates the full-sync (730d) cooldown
--
-- Postgres rejects a SELECT that references any column the role can't read, so the
-- clients' plaid_items fetch (which lists these columns) errored with
-- "permission denied for column" for every authenticated user. The failure was
-- silent in the UI: institution logos + names fell back to the generic
-- placeholder, and the sync-in-progress indicator never fired.
--
-- Grant SELECT on exactly those columns. GRANT is idempotent, so this is
-- fresh-DB safe and re-appliable.
grant select (is_syncing, sync_started_at, last_backfill_at)
  on public.plaid_items to authenticated;
