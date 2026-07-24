-- Transaction search: pg_trgm + search_transactions RPC.
--
-- One server-side search both clients call the same way:
--
--   supabase.rpc('search_transactions', { p_query: 'starbucks' })  → [{ id }, ...]
--
-- The RPC returns only matching transaction ids (newest effective_date first,
-- capped at p_limit). Clients then re-fetch those rows through their existing
-- PostgREST selects (`*, categories(*), ...`), so embeds, decoders and RLS
-- behave exactly like every other transaction list — no second decode path.
--
-- Matching, against merchant_name / description / notes:
--   1. case-insensitive substring (ILIKE) on the concatenated haystack;
--   2. trigram word_similarity() for typo tolerance ("strabucks" still hits);
--   3. if the query parses as a number, |amount| = value also matches
--      ("42.50" finds the charge regardless of sign).
--
-- pg_trgm lives in the `extensions` schema (Supabase convention; config.toml
-- already lists it in extra_search_path). The RPC pins search_path = public,
-- so trigram functions are schema-qualified explicitly.
--
-- No trigram index: the OR of ILIKE + word_similarity() isn't indexable as
-- written, and idx_transactions_user already narrows the scan to one user's
-- rows (thousands, not millions). ponytail: add a GIN trgm index + <% operator
-- rewrite only if per-user volume ever makes this RPC slow.
--
-- VERSION NOTE: minted 2026-07-03 16:31:54 UTC by `supabase migration new`;
-- date part bumped past the (future-dated) head 20260718140418_suggest_transfers
-- so fresh-DB apply order stays correct. Same convention as 20260716043438,
-- 20260717123756 and 20260718140418.

create extension if not exists pg_trgm with schema extensions;

create or replace function search_transactions(p_query text, p_limit int default 50)
returns table (id uuid)
language plpgsql
stable
security invoker
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  q text := trim(p_query);
  q_like text;
  q_amount numeric := null;
begin
  if uid is null then
    raise exception 'not authenticated';
  end if;

  if q = '' then
    return;
  end if;

  -- LIKE wildcards in the query are literals: "50%" must not match everything
  q_like := replace(replace(replace(q, '\', '\\'), '%', '\%'), '_', '\_');

  -- "$42.50", "42.5", "-7" → also match on |amount|
  begin
    q_amount := abs(replace(ltrim(q, '$'), ',', '')::numeric);
  exception when data_exception then
    q_amount := null;
  end;

  return query
  select t.id
  from transactions t
  cross join lateral (
    select coalesce(t.merchant_name, '') || ' '
        || coalesce(t.description, '') || ' '
        || coalesce(t.notes, '') as haystack
  ) h
  where t.user_id = uid  -- security invoker: RLS already scopes; explicit for index use
    and (
      h.haystack ilike '%' || q_like || '%'
      -- 0.4: loose enough for one-typo merchants ("strabucks" → Starbucks ≈ .43),
      -- tight enough that short queries don't match everything
      or extensions.word_similarity(q, h.haystack) >= 0.4
      or (q_amount is not null and abs(t.amount) = q_amount)
    )
  order by t.effective_date desc, t.id
  limit greatest(p_limit, 1);
end;
$$;

revoke execute on function search_transactions(text, int) from public, anon;
grant execute on function search_transactions(text, int) to authenticated;
