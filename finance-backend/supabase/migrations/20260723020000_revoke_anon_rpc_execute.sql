-- close the pre-auth RPC surface flagged by the Supabase advisor
-- (0028_anon_security_definer_function_executable).
--
-- Both functions are SECURITY DEFINER and PostgREST exposes them as RPCs the `anon` role can
-- call. In practice zbb_move_money already guards on auth.uid() (raises 'not authenticated'
-- when null) and scopes every write to the caller, and seed_default_categories is a
-- trigger-only function that errors if invoked directly with no NEW row — so this is
-- defense-in-depth to remove the exposed surface, not a fix for a live exploit.
--
-- Revoke EXECUTE from anon on both. Also revoke from authenticated on the trigger-only seeder,
-- which must never be called directly; its trigger fires as the function owner (SECURITY
-- DEFINER) regardless of these grants, so signup-time seeding is unaffected. zbb_move_money
-- keeps EXECUTE for authenticated — that is its legitimate signed-in caller.
--
-- REVOKE of a privilege that is not held is a no-op in Postgres, so this is idempotent and
-- fresh-DB safe (both functions are created by earlier migrations that run before this one).

revoke execute on function public.zbb_move_money(integer, integer, uuid, uuid, numeric) from anon;
revoke execute on function public.seed_default_categories() from anon, authenticated;
