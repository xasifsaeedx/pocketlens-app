-- ============================================================
-- ZBB MONTH OVERVIEW RPC
--   One-round-trip load path for the zero-sum budgeting screen. Previously
--   BOTH clients (ZbbService.fetchMonth / web fetchZbbMonth) walked the
--   rollover chain client-side, firing one spend query per month in the
--   chain (bounded at 60) → up to 60 round-trips per budget-screen load.
--   This function reproduces the exact math of the pure client libs
--   (FinanceApp/Services/ZbbMath.swift, web/src/lib/zbb.ts — pinned by
--   ZbbMathTests / zbb.test.ts) server-side in one call:
--
--     chain months = budget_start (or viewed month if unset, each part
--                    coalesced independently) … viewed month, ascending,
--                    clamped to the most recent 60 months ending at the
--                    viewed month (monthRange semantics);
--     per month, per spend category:
--       rollover  = strict:   prev_available
--                   flexible: greatest(prev_available, 0)
--       available = rollover + assigned - activity     (carries to next month)
--     per month:
--       flexible_deficit = sum(-prev_available) where prev_available < 0
--                          (flexible mode only)
--       ready_to_assign  = income - total_assigned - flexible_deficit
--       income           = zbb_months row, else zbb_settings.monthly_income
--     Unassigned RTA does NOT carry month-to-month (income-driven model).
--
--   Activity comes from the category_spend view (splits-aware, spend per
--   (user, month of effective_date, category) — migration 20260716043438),
--   the same source both clients already read for per-month spend.
--
--   security invoker: runs with the caller's RLS on every table/view it
--   touches (same pattern as category_spend / latest_balances); auth.uid()
--   filters are explicit for index use + defense in depth. Returns jsonb —
--   a single object decodes cleanly in both supabase-js (plain JSON) and
--   supabase-swift (Decodable via JSONDecoder).
--
--   The pure client libs are KEPT for optimistic UI previews (canAssign,
--   applyMoveMoney); this RPC is the source of truth on load.
--
--   VERSION NOTE: minted by `supabase migration new` at the real UTC instant
--   2026-07-03 12:37:56, but that version sorts BEFORE the future-hand-dated
--   legacy files this function depends on (category_spend = 20260716043438,
--   zbb tables = 20260703025619 + their user_id/splits deps = 20260704+),
--   which breaks CI's fresh-DB apply. Date bumped to 20260717 (first slot
--   past the head 20260716043438); the HHMMSS keeps the real mint time for
--   collision resistance. Once real time passes 2026-07-16 this workaround
--   is moot. (Same precedent as 20260716043438_category_spend_view.)
-- ============================================================

create or replace function zbb_month_overview(p_year int, p_month int)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  v_enabled bool;
  v_mode text;
  v_default_income numeric;
  v_bs_year int;
  v_bs_month int;
  v_end_idx int;          -- absolute month index: year*12 + (month-1)
  v_start_idx int;
  v_cat_ids uuid[];       -- the user's spend categories (the envelopes)
  v_all_assigned jsonb;   -- 'y-m' -> { category_id: assigned }
  v_all_incomes jsonb;    -- 'y-m' -> income
  v_all_activity jsonb;   -- 'y-m' -> { category_id: spent }
  v_i int;
  v_y int;
  v_mo int;
  v_ym text;
  v_income numeric := 0;
  v_m_assigned jsonb;
  v_m_activity jsonb;
  v_prev jsonb := '{}'::jsonb;      -- category_id -> available at end of previous month
  v_rows jsonb := '[]'::jsonb;      -- rows of the month last computed
  v_total_assigned numeric := 0;
  v_flexible_deficit numeric := 0;
begin
  if uid is null then
    raise exception 'not authenticated';
  end if;
  if p_month < 1 or p_month > 12 then
    raise exception 'month must be between 1 and 12';
  end if;

  select enabled, rollover_mode, monthly_income, budget_start_year, budget_start_month
    into v_enabled, v_mode, v_default_income, v_bs_year, v_bs_month
    from zbb_settings
    where user_id = uid;
  -- No settings row → same defaults the clients use (disabled/strict/0 income).
  v_enabled := coalesce(v_enabled, false);
  v_mode := coalesce(v_mode, 'strict');
  v_default_income := coalesce(v_default_income, 0);

  -- monthRange: budget_start (parts coalesced independently, like the clients)
  -- … viewed month, clamped to the most recent 60 months ending at the viewed
  -- month; a start after the end collapses to just the viewed month.
  v_end_idx := p_year * 12 + p_month - 1;
  v_start_idx := coalesce(v_bs_year, p_year) * 12 + coalesce(v_bs_month, p_month) - 1;
  v_start_idx := least(greatest(v_start_idx, v_end_idx - 59), v_end_idx);

  select coalesce(array_agg(id order by name, id), '{}')
    into v_cat_ids
    from categories
    where user_id = uid and kind = 'spend';

  -- Prefetch the whole window once (the clients did the same with two table
  -- scans + one spend query per month; here the view is evaluated once).
  select coalesce(jsonb_object_agg(t.ym, t.m), '{}'::jsonb)
    into v_all_assigned
    from (
      select a.year::text || '-' || a.month::text as ym,
             jsonb_object_agg(a.category_id, a.assigned) as m
      from zbb_assignments a
      where a.user_id = uid
        and a.year * 12 + a.month - 1 between v_start_idx and v_end_idx
      group by 1
    ) t;

  select coalesce(jsonb_object_agg(zm.year::text || '-' || zm.month::text, zm.income), '{}'::jsonb)
    into v_all_incomes
    from zbb_months zm
    where zm.user_id = uid
      and zm.year * 12 + zm.month - 1 between v_start_idx and v_end_idx;

  select coalesce(jsonb_object_agg(t.ym, t.m), '{}'::jsonb)
    into v_all_activity
    from (
      select extract(year from cs.month)::int::text || '-'
               || extract(month from cs.month)::int::text as ym,
             jsonb_object_agg(cs.category_id, cs.spent) as m
      from category_spend cs
      where cs.user_id = uid
        and cs.month between make_date(v_start_idx / 12, v_start_idx % 12 + 1, 1)
                         and make_date(p_year, p_month, 1)
      group by 1
    ) t;

  -- computeChain: walk months ascending, feeding each month's end-of-month
  -- availables into the next month's rollover. The last iteration's outputs
  -- are the viewed month's overview.
  for v_i in v_start_idx..v_end_idx loop
    v_y := v_i / 12;
    v_mo := v_i % 12 + 1;
    v_ym := v_y::text || '-' || v_mo::text;
    v_income := coalesce((v_all_incomes ->> v_ym)::numeric, v_default_income);
    v_m_assigned := coalesce(v_all_assigned -> v_ym, '{}'::jsonb);
    v_m_activity := coalesce(v_all_activity -> v_ym, '{}'::jsonb);

    select
      coalesce(jsonb_agg(jsonb_build_object(
        'category_id', x.cid,
        'assigned', round(x.assigned, 2),
        'activity', round(x.activity, 2),
        'rollover', round(x.rollover, 2),
        'available', round(x.available, 2)) order by x.ord), '[]'::jsonb),
      coalesce(sum(x.assigned), 0),
      coalesce(sum(x.deficit), 0),
      coalesce(jsonb_object_agg(x.cid, x.available), '{}'::jsonb)
      into v_rows, v_total_assigned, v_flexible_deficit, v_prev
    from (
      select c.cid, c.ord, r.assigned, r.activity, r.rollover, r.deficit,
             r.rollover + r.assigned - r.activity as available
      from unnest(v_cat_ids) with ordinality as c(cid, ord)
      cross join lateral (
        select
          coalesce((v_m_assigned ->> c.cid::text)::numeric, 0) as assigned,
          coalesce((v_m_activity ->> c.cid::text)::numeric, 0) as activity,
          case when v_mode = 'strict' then pa.v else greatest(pa.v, 0) end as rollover,
          case when v_mode = 'flexible' and pa.v < 0 then -pa.v else 0 end as deficit
        from (select coalesce((v_prev ->> c.cid::text)::numeric, 0) as v) pa
      ) r
    ) x;
  end loop;

  return jsonb_build_object(
    'settings', jsonb_build_object(
      'enabled', v_enabled,
      'rollover_mode', v_mode,
      'monthly_income', v_default_income,
      'budget_start_year', v_bs_year,
      'budget_start_month', v_bs_month),
    'income', round(v_income, 2),
    'rows', v_rows,
    'total_assigned', round(v_total_assigned, 2),
    'ready_to_assign', round(v_income - v_total_assigned - v_flexible_deficit, 2),
    -- Raw assigned amounts for the viewed month (drives the assign inputs).
    'assignments', (
      select coalesce(jsonb_object_agg(a.category_id, a.assigned), '{}'::jsonb)
      from zbb_assignments a
      where a.user_id = uid and a.year = p_year and a.month = p_month)
  );
end;
$$;

grant execute on function zbb_month_overview(int, int) to authenticated;
