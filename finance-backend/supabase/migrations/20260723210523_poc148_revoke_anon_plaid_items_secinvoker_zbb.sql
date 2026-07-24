-- tighten access around the Plaid secret columns.
--
-- Neither item below is a live hole today — both are defense-in-depth ahead of
-- opening signup to untrusted users. The access tokens themselves are Fernet
-- ciphertext (sync-service/vault.py); the decryption key lives only in the
-- service environment, never in this database.

-- ── 1. Revoke the leftover `anon` SELECT on plaid_items ──────────────
-- 20260704000000_multi_user.sql revoked SELECT from `authenticated` and
-- re-granted a safe column list, but never touched the hosted project's
-- default grant to `anon` — which still covers all 18 columns, access_token
-- included. RLS saves us: plaid_items has no policy naming `anon`, so an
-- unauthenticated caller reads zero rows. That makes this latent, not live:
-- a future policy added `to public`, or a security-definer view over the
-- table, would turn it into a real leak of ciphertext + plaid_item_id.
--
-- Only plaid_items carries a secret column, so the revoke is scoped here.
-- (`anon` holds the same default SELECT on every other public table; those
-- are likewise RLS-blocked and hold no secrets.)
revoke select on public.plaid_items from anon;

-- ── 2. zbb_move_money: SECURITY DEFINER → SECURITY INVOKER ───────────
-- Advisor 0029: the function is callable by `authenticated` over
-- /rest/v1/rpc/ while running as its owner. It never needs that privilege —
-- it derives uid from auth.uid() and scopes every write to it, `authenticated`
-- already holds select/insert/update/delete on zbb_assignments
-- (20260703025619_zbb.sql), and the `own` RLS policy covers all commands.
-- Running as invoker keeps behavior identical while letting RLS backstop the
-- function's own uid checks instead of bypassing them.
--
-- Body is unchanged from 20260703025619_zbb.sql apart from the security mode.
create or replace function public.zbb_move_money(
  p_year integer, p_month integer, p_from uuid, p_to uuid, p_amount numeric
)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  uid uuid := auth.uid();
begin
  if uid is null then
    raise exception 'not authenticated';
  end if;
  if p_from = p_to then
    raise exception 'from and to categories must differ';
  end if;
  if p_amount <= 0 then
    raise exception 'amount must be positive';
  end if;
  -- Ensure both rows exist for this month before adjusting.
  insert into zbb_assignments (category_id, year, month, assigned, user_id)
  values (p_from, p_year, p_month, 0, uid), (p_to, p_year, p_month, 0, uid)
  on conflict (user_id, category_id, year, month) do nothing;

  update zbb_assignments set assigned = assigned - p_amount
    where user_id = uid and category_id = p_from and year = p_year and month = p_month;
  update zbb_assignments set assigned = assigned + p_amount
    where user_id = uid and category_id = p_to and year = p_year and month = p_month;
end;
$$;

-- CREATE OR REPLACE resets grants to the defaults (EXECUTE to public), so
-- re-apply 20260802000000's revoke of the anon/public execute grant.
revoke execute on function public.zbb_move_money(integer, integer, uuid, uuid, numeric) from anon, public;
grant execute on function public.zbb_move_money(integer, integer, uuid, uuid, numeric) to authenticated;
