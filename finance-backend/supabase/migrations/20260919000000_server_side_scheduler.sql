-- Server-side scheduler: Supabase pg_cron + pg_net call the API on a schedule.
--
-- Replaces every off-server scheduler this project has had (the Render cron
-- removed in 443a900, then Windows Scheduled Tasks on a PC). Nothing runs
-- anywhere but Render and Supabase after this: the database fires HTTP
-- requests at pocketlens-api, and the API runs the job as a background task
-- (POST /internal/sync, POST /internal/daily — see sync-service/api.py).
--
-- Configuration lives in Supabase Vault, NOT in this file, so the migration is
-- safe in a public repo and identical for every self-hoster. Two secrets must
-- exist (SQL editor, once):
--
--   select vault.create_secret('https://your-api.onrender.com', 'pocketlens_api_url');
--   select vault.create_secret('<same value as TRIGGER_SECRET on the API>', 'pocketlens_trigger_secret');
--
-- Until both exist every job logs a WARNING and does nothing (visible in
-- cron.job_run_details), rather than failing loudly or calling a wrong host.
--
-- Schedule (all UTC; pg_cron only speaks UTC):
--   pocketlens-wake-api      :02 every hour       GET  /health  — wakes the free-tier API
--                                                   so the :07 sync hits a warm instance
--   pocketlens-hourly-sync   :07 every hour       POST /internal/sync
--   pocketlens-daily         09:20 every day      POST /internal/daily — reconcile + digests
--                                                   (05:20 EDT, inside digests' morning window)
--   pocketlens-keep-awake    every 10 min, 15:00–06:59 UTC  GET /health — keeps the API
--                                                   responsive during waking hours
--                                                   (08:00–23:00 PDT) without burning
--                                                   the whole 750 h/month free allowance
--
-- Idempotent: extensions are IF NOT EXISTS, the function is CREATE OR REPLACE,
-- and cron.schedule(name, …) updates a job that already has that name. Safe to
-- run from `supabase db push` or pasted into the SQL editor.

create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

create schema if not exists private;

-- Fire one HTTP request at the API. Returns pg_net's request id (async; the
-- response lands in net._http_response) or NULL when the Vault secrets are
-- missing. GET carries no body; POST sends an empty JSON object.
create or replace function private.pocketlens_call_api(path text, method text default 'POST')
returns bigint
language plpgsql
as $$
declare
  base_url text;
  secret   text;
  rid      bigint;
begin
  select decrypted_secret into base_url
    from vault.decrypted_secrets where name = 'pocketlens_api_url';
  select decrypted_secret into secret
    from vault.decrypted_secrets where name = 'pocketlens_trigger_secret';

  if base_url is null or secret is null then
    raise warning 'pocketlens scheduler: Vault secrets pocketlens_api_url / pocketlens_trigger_secret are not set; skipping % %', method, path;
    return null;
  end if;

  base_url := rtrim(base_url, '/');

  if upper(method) = 'GET' then
    select net.http_get(
      url := base_url || path,
      headers := jsonb_build_object('X-Trigger-Secret', secret),
      timeout_milliseconds := 90000   -- long enough to ride out a Render cold start
    ) into rid;
  else
    select net.http_post(
      url := base_url || path,
      body := '{}'::jsonb,
      headers := jsonb_build_object('Content-Type', 'application/json',
                                    'X-Trigger-Secret', secret),
      timeout_milliseconds := 90000
    ) into rid;
  end if;
  return rid;
end;
$$;

revoke all on function private.pocketlens_call_api(text, text) from public, anon, authenticated;

select cron.schedule('pocketlens-wake-api',    '2 * * * *',
                     $$select private.pocketlens_call_api('/health', 'GET')$$);
select cron.schedule('pocketlens-hourly-sync', '7 * * * *',
                     $$select private.pocketlens_call_api('/internal/sync')$$);
select cron.schedule('pocketlens-daily',       '20 9 * * *',
                     $$select private.pocketlens_call_api('/internal/daily')$$);
select cron.schedule('pocketlens-keep-awake',  '*/10 15-23,0-6 * * *',
                     $$select private.pocketlens_call_api('/health', 'GET')$$);
