-- ============================================================
-- PER-USER PLAID CREDENTIALS (BYO developer account pilot)
--   Each user may register their own Plaid developer account (trial tier,
--   10 Items). The API secret is Fernet-encrypted by the backend before it
--   ever reaches the database (key = CREDENTIALS_ENC_KEY env var, never
--   stored here). Users without a row use the house account from env vars.
-- ============================================================

create table plaid_credentials (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users(id) on delete cascade,
  plaid_client_id text not null,
  plaid_secret_enc text not null,  -- Fernet ciphertext; decryption key lives only in the backend env
  plaid_env text not null default 'production' check (plaid_env in ('sandbox', 'production')),
  item_limit int not null default 10,  -- Plaid trial-tier Item cap
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index idx_plaid_credentials_client on plaid_credentials(plaid_client_id);

alter table plaid_credentials enable row level security;

-- Client may read its own row's *status*; all writes go through the API
-- (service role) so credentials are validated against Plaid and the secret is
-- encrypted before storage. No insert/update/delete policy = blocked.
create policy "own_read" on plaid_credentials
  for select to authenticated using (user_id = auth.uid());

-- Column-level grant withholding the secret ciphertext (mirror of the
-- plaid_items.access_token pattern from 20260704). Explicit revoke first:
-- the hosted project's default privileges would otherwise grant SELECT on
-- every column, ciphertext included.
revoke all on plaid_credentials from anon, authenticated;
grant select (id, user_id, plaid_client_id, plaid_env, item_limit, is_active, created_at)
  on plaid_credentials to authenticated;
grant all on plaid_credentials to service_role;

-- Which Plaid developer account created each item (null = house/env account).
-- Sync and webhook-signature verification must call Plaid with that account's
-- credentials, and the Item cap is counted per account.
alter table plaid_items add column plaid_client_id text;
create index idx_plaid_items_client on plaid_items(plaid_client_id);
