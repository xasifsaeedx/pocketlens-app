"""
One-time: point all existing plaid_items at the webhook URL.
Usage: PLAID_WEBHOOK_URL=https://<api>/webhook/plaid python register_webhooks.py
"""
import os

from plaid.model.item_webhook_update_request import ItemWebhookUpdateRequest

import vault
from plaid_client import get_plaid_for_item
from supabase_client import get_supabase


def main():
    url = os.environ.get('PLAID_WEBHOOK_URL')
    if not url:
        raise SystemExit("Set PLAID_WEBHOOK_URL first (e.g. https://<api>/webhook/plaid)")

    supabase = get_supabase()
    items = supabase.table('plaid_items') \
        .select('*') \
        .eq('is_active', True) \
        .execute().data

    for item in items:
        plaid = get_plaid_for_item(supabase, item)
        plaid.item_webhook_update(ItemWebhookUpdateRequest(
            access_token=vault.decrypt(item['access_token']), webhook=url,
        ))
        print(f"→ webhook set for {item.get('institution_name')}")

    print(f"Done: {len(items)} item(s) now notify {url}")


if __name__ == '__main__':
    main()
