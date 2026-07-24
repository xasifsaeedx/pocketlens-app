"""
One-time upgrade for pre-encryption rows:
  1. Encrypt plaintext plaid_items.access_token values (Fernet, CREDENTIALS_ENC_KEY).
  2. Stamp plaid_client_id = the house PLAID_CLIENT_ID on items that predate the
     plaid_credentials migration (null = house, but explicit keeps the Item-cap
     count exact).

Safe to re-run: already-encrypted tokens and already-stamped items are skipped.
Usage: python encrypt_existing_tokens.py
"""
import os

import vault
from supabase_client import get_supabase


def main():
    supabase = get_supabase()
    house_client_id = os.environ.get('PLAID_CLIENT_ID')  # may be unset post-migration

    items = supabase.table('plaid_items').select('id, access_token, plaid_client_id, institution_name').execute().data
    encrypted = stamped = 0

    for item in items:
        patch = {}
        token = item.get('access_token') or ''
        if token and not token.startswith(vault.FERNET_PREFIX):
            patch['access_token'] = vault.encrypt(token)
            encrypted += 1
        if house_client_id and not item.get('plaid_client_id'):
            patch['plaid_client_id'] = house_client_id
            stamped += 1
        if patch:
            supabase.table('plaid_items').update(patch).eq('id', item['id']).execute()
            print(f"→ {item.get('institution_name')}: {', '.join(patch.keys())}")

    print(f"Done: {encrypted} token(s) encrypted, {stamped} item(s) stamped house client_id "
          f"({len(items)} total)")


if __name__ == '__main__':
    main()
