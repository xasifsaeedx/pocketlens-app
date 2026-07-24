-- Capture Plaid merchant location + currency on transactions.
--
-- Plaid returns a `location` object and `iso_currency_code` on every transaction
-- that the sync currently drops. Persist them as new Plaid-owned columns (sync
-- writes/overwrites them, like amount/merchant_name — see sync.PLAID_OWNED) so
-- future transactions carry city/region/country + currency. Forward-only: existing
-- rows stay NULL until a Plaid re-sync (cursor reset) rewrites them.
--
-- Enables (as follow-ups, not built here):
--   • self-tagging trips        — cluster spend by merchant_region/merchant_country
--   • foreign-transaction detect — iso_currency_code present and not the home currency
--
-- All nullable (Plaid omits location/currency for many transactions), no defaults,
-- no new indexes. RLS is inherited from the transactions table's existing policies.
-- `if not exists` keeps this fresh-DB safe and re-appliable.

alter table transactions
  add column if not exists merchant_city         text,
  add column if not exists merchant_region       text,
  add column if not exists merchant_country       text,
  add column if not exists merchant_postal_code  text,
  add column if not exists merchant_store_number text,
  add column if not exists merchant_lat          numeric,
  add column if not exists merchant_lon          numeric,
  add column if not exists iso_currency_code     text;
