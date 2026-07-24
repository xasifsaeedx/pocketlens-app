-- ============================================================
-- SUGGEST TRANSFERS RPC — single-source transfer-pair matching for clients
--   Until now TWO independent matchers implemented the same pairing rules and
--   had already drifted: sync-service/transfers.py (auto-link at sync time)
--   and web/src/data/transfers.ts pairSuggestions (manual-review suggestions).
--   This function is now the ONE matcher clients call for suggestions (web
--   today, the iOS port later — same RPC, no schema change).
--
--   suggest_transfers(p_lookback_days default 60): greedy matching over the
--   caller's posted, visible, not-opted-out, UNLINKED transactions within
--   p_lookback_days of today —
--     * outflows (amount > 0) walked in (effective_date, id) order, each
--       greedily claiming the best unclaimed inflow;
--     * a valid inflow has the exact opposite amount (|out + in| < 0.005;
--       amounts are numeric(12,2), so cent-exact), a DIFFERENT account, and
--       is ≤ 5 days away;
--     * closest date wins, id as the deterministic tie-break, each row used
--       at most once;
--     * two candidates at the SAME distance → ambiguous, skip the outflow
--       (never guess — suggestions are human-reviewed, so showing nothing
--       beats promoting one side of ambiguous evidence).
--   Returns (days_apart, out_txn jsonb, in_txn jsonb) with the full
--   transaction rows embedded — one round trip, decodes as plain JSON in
--   supabase-js and via Decodable in supabase-swift.
--
--   SCOPE — matching truth only, not auto-link policy. The sync-time
--   auto-linker (sync-service/transfers.py) keeps its own Python matcher and
--   additionally applies two Plaid-informed rules this RPC deliberately
--   lacks: the PFC signal gate (only auto-link when a leg carries
--   TRANSFER_IN/TRANSFER_OUT/LOAN_PAYMENTS) and the LOAN_PAYMENTS
--   credit-account tie-break. Those are WRITE policy for acting without user
--   confirmation; rows reaching the suggestions tier are exactly the ones
--   the sync declined, and a skipped ambiguous tie here is harmless. If you
--   change the shared rules (EPS / window / closest-date / ambiguity) HERE,
--   change them in transfers.py too — tests/test_integration.py pins this
--   function (including parity with the deleted web pairSuggestions),
--   tests/test_transfers.py pins the Python.
--
--   security invoker: runs with the caller's RLS (user_id = auth.uid()),
--   same pattern as zbb_month_overview; the explicit user_id filter is for
--   index use + defense in depth.
--
--   VERSION NOTE: minted by `supabase migration new` at the real UTC instant
--   2026-07-03 14:04:18, but that version sorts before the future-hand-dated
--   legacy files it depends on (transfer columns = 20260711/20260715). Date
--   bumped to 20260718 (first slot past the head 20260717123756); the HHMMSS
--   keeps the real mint time for collision resistance. Moot once real time
--   passes 2026-07-18. (Same precedent as 20260717123756_zbb_month_overview.)
-- ============================================================

create or replace function suggest_transfers(p_lookback_days int default 60)
returns table (days_apart int, out_txn jsonb, in_txn jsonb)
language plpgsql
stable
security invoker
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  eps constant numeric := 0.005;   -- sub-cent tolerance; mirrors EPS in transfers.py
  window_days constant int := 5;   -- posting/settlement lag; mirrors WINDOW_DAYS
  o record;
  cand_ids uuid[];
  cand_dds int[];
  used uuid[] := '{}';             -- inflow ids already claimed by an earlier outflow
begin
  if uid is null then
    raise exception 'not authenticated';
  end if;

  -- Greedy pass in deterministic outflow order, exactly like the Python and
  -- old-web matchers: earlier (date, id) outflows claim their best inflow first.
  for o in
    select t.id, t.account_id, t.amount, t.effective_date
    from transactions t
    where t.user_id = uid
      and t.pending = false
      and t.hidden = false
      and t.transfer_opt_out = false
      and t.transfer_group_id is null
      and t.effective_date >= current_date - p_lookback_days
      and t.amount > 0
    order by t.effective_date, t.id
  loop
    -- Top two candidates by (date distance, id): the first is the match; the
    -- second exists only to detect an ambiguous tie.
    select array_agg(c.id), array_agg(c.dd)
      into cand_ids, cand_dds
      from (
        select i.id, abs(i.effective_date - o.effective_date) as dd
        from transactions i
        where i.user_id = uid
          and i.pending = false
          and i.hidden = false
          and i.transfer_opt_out = false
          and i.transfer_group_id is null
          and i.amount < 0
          and i.account_id <> o.account_id
          and abs(i.amount + o.amount) < eps
          and abs(i.effective_date - o.effective_date) <= window_days
          and not (i.id = any (used))
        order by 2, 1
        limit 2
      ) c;
    continue when cand_ids is null;
    -- Two equally-close candidates → ambiguous, skip (don't consume the legs;
    -- a later outflow may still legitimately claim one of them).
    continue when array_length(cand_ids, 1) = 2 and cand_dds[1] = cand_dds[2];

    used := used || cand_ids[1];
    days_apart := cand_dds[1];
    select to_jsonb(t.*) into out_txn from transactions t where t.id = o.id;
    select to_jsonb(t.*) into in_txn from transactions t where t.id = cand_ids[1];
    return next;
  end loop;
end;
$$;

revoke execute on function suggest_transfers(int) from public, anon;
grant execute on function suggest_transfers(int) to authenticated;
