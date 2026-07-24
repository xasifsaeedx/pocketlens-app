-- (fix): the previous migration (20260723020000) revoked EXECUTE from `anon`, but that
-- did NOT close the hole. Postgres grants EXECUTE on functions to the PUBLIC pseudo-role by
-- default, and `anon` inherits it through PUBLIC — so `revoke ... from anon` left both
-- SECURITY DEFINER functions still callable pre-auth via /rest/v1/rpc/*. The Supabase advisor
-- (0028) correctly kept flagging them.
--
-- Revoke EXECUTE from PUBLIC on both. After this:
--   * zbb_move_money  -> executable only by `authenticated` (its explicit grant, the legit
--     signed-in caller), plus the owner and service_role. anon can no longer reach it.
--   * seed_default_categories -> executable only by the owner and service_role. It is a
--     trigger-only function; its trigger fires as the owner (SECURITY DEFINER) regardless of
--     these grants, so signup-time category seeding is unaffected.
--
-- REVOKE of a privilege that is not held is a no-op, so this is idempotent and fresh-DB safe.

revoke execute on function public.zbb_move_money(integer, integer, uuid, uuid, numeric) from public;
revoke execute on function public.seed_default_categories() from public;
