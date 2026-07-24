-- ============================================================
-- TAG → CATEGORY RULES
--   Second kind of Auto Classify rule (alongside keyword→category in
--   category_rules): "when a transaction is tagged with tag A, categorize it as
--   category B". One category per tag, so a rule is keyed uniquely by (user, tag).
--
--   Where it runs: CLIENT-ONLY for now (iOS TagEditorSection / web TxnTagEditor at
--   tag-assignment time, plus an "Apply now" batch and a backfill-on-create prompt).
--   The sync-service categorizer.py deliberately does NOT honor these — freshly
--   pulled Plaid transactions arrive untagged, so a tag rule can never match at
--   sync time. Tags are a user action, so the trigger only ever fires client-side.
--
--   VERSION NOTE: hand-dated 20260729000000 — the first slot past the current head
--   (20260728120000_txn_location_currency). This repo front-dates migrations into
--   the future, so `supabase migration new` (real UTC now) would sort BEFORE the
--   tags/categories tables this FKs to and break a fresh-DB apply. The version only
--   needs to sort after its dependencies. Idempotent (if-not-exists), so a fresh-DB
--   apply and a re-apply are both safe.
-- ============================================================

create table if not exists tag_category_rules (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  tag_id uuid not null references tags(id) on delete cascade,
  category_id uuid not null references categories(id) on delete cascade,
  created_at timestamptz not null default now(),
  -- one category per tag per user: adding a rule for an already-ruled tag replaces it
  constraint tag_category_rules_user_tag unique (user_id, tag_id)
);
create index if not exists idx_tag_category_rules_user on tag_category_rules(user_id);
create index if not exists idx_tag_category_rules_tag on tag_category_rules(tag_id);

alter table tag_category_rules enable row level security;
do $$
begin
  if not exists (
    select 1 from pg_policy where polname = 'own'
      and polrelid = 'tag_category_rules'::regclass
  ) then
    create policy "own" on tag_category_rules for all to authenticated
      using (user_id = auth.uid()) with check (user_id = auth.uid());
  end if;
end $$;

-- API-role grants (mirror 20260709_tags; implicit defaults aren't present on a fresh stack).
grant all on all tables in schema public to service_role;
grant select, insert, update, delete on tag_category_rules to authenticated;
