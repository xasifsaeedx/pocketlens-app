-- ============================================================
-- CONDITIONAL CATEGORY RULES
--   Extends category_rules from a plain keyword -> category into a general
--   conditional rule that can also match on money direction and amount, and can
--   flag the matched transaction as a reimbursement (contra-expense) in addition
--   to (or instead of) setting a category.
--
--   Motivating case (created by the user via the UI, NOT seeded here): a roommate
--   Zelles their monthly rent share. "money IN + description contains 'Ved Rao'
--   + amount > $1500 -> category Rent + mark reimbursement" nets that credit
--   against rent, while their small $6/$22 Zelles (below the threshold) are ignored.
--
--   All new columns are NULLABLE / defaulted so every existing row keeps behaving
--   exactly as before (null conditions = "any", set_reimbursement = false). No data
--   migration is needed.
--
--   Sign convention (see transactions.amount): POSITIVE = spend/outflow,
--   NEGATIVE = money-in/inflow. So direction 'in' <=> amount < 0 and 'out' <=>
--   amount > 0; the amount thresholds are compared against ABS(amount). All of that
--   matching lives in the app/sync layer (categorizer.py, categorySuggester.ts/.swift);
--   this migration only stores the conditions.
--
--   VERSION NOTE: hand-dated 20260727000000 — the first slot past the current head
--   (20260726000000_profiles). Prod push uses `db push`, so the version only needs to
--   sort after its dependency (the category_rules table). Idempotent (if-not-exists)
--   so a fresh-DB apply and a re-apply are both safe.
-- ============================================================

alter table category_rules
  add column if not exists direction text,
  add column if not exists min_amount numeric,
  add column if not exists max_amount numeric,
  add column if not exists set_reimbursement boolean not null default false;

-- direction is a coarse money-flow filter: 'in' (credits/amount<0), 'out'
-- (debits/amount>0), or NULL = either. Guard the domain so a bad client can't
-- store a value the matchers don't understand.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'category_rules_direction_check'
  ) then
    alter table category_rules
      add constraint category_rules_direction_check
      check (direction in ('in', 'out'));
  end if;
end $$;

-- Amount bounds are magnitudes (compared against ABS(amount)), so they must be
-- non-negative and min <= max when both are present.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'category_rules_amount_bounds_check'
  ) then
    alter table category_rules
      add constraint category_rules_amount_bounds_check
      check (
        (min_amount is null or min_amount >= 0)
        and (max_amount is null or max_amount >= 0)
        and (min_amount is null or max_amount is null or min_amount <= max_amount)
      );
  end if;
end $$;

-- A rule with no action does nothing; require at least a category or the
-- reimbursement flag. (The clients also enforce this, plus that a rule always has
-- a keyword.) Existing rows all carry a category_id, so this is satisfied on apply.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'category_rules_has_action_check'
  ) then
    alter table category_rules
      add constraint category_rules_has_action_check
      check (category_id is not null or set_reimbursement);
  end if;
end $$;

-- RLS is already enabled on category_rules (user_id = auth.uid()); new columns are
-- covered by the existing table policy — nothing to add here.
