"""Plaid clients, one per Plaid developer account.

Multi-user pilot model: every user brings their own Plaid developer account
(trial tier, 10 Items). Their client_id + secret live in plaid_credentials
(secret Fernet-encrypted — see vault.py) — the database is the only home for
Plaid credentials. The env-var "house" account (PLAID_CLIENT_ID /
PLAID_SECRET) is a legacy fallback: when those vars are unset, house_creds()
returns None and users without a plaid_credentials row simply can't link
banks until they add credentials in Settings.

Every plaid_items row records the plaid_client_id that created it, so sync
and webhook verification always call Plaid with the right account's
credentials.
"""
import logging
import os

import plaid
from dotenv import load_dotenv
from plaid.api import plaid_api
from plaid.model.country_code import CountryCode
from plaid.model.institutions_get_by_id_request import InstitutionsGetByIdRequest
from plaid.model.institutions_get_by_id_request_options import InstitutionsGetByIdRequestOptions

import vault

load_dotenv()

logger = logging.getLogger('plaid_client')

_ENV_MAP = {
    'sandbox': plaid.Environment.Sandbox,
    'production': plaid.Environment.Production,
}

_clients: dict = {}      # (client_id, env) -> PlaidApi
_creds_cache: dict = {}  # plaid_client_id -> decrypted creds dict

DEFAULT_ITEM_LIMIT = int(os.environ.get('PLAID_ITEM_LIMIT', '10'))


def house_creds():
    """Legacy env-var Plaid account, or None when not configured (the normal
    state now that credentials live in plaid_credentials)."""
    client_id = os.environ.get('PLAID_CLIENT_ID')
    secret = os.environ.get('PLAID_SANDBOX_SECRET') or os.environ.get('PLAID_SECRET')
    if not client_id or not secret:
        return None
    return {
        'plaid_client_id': client_id,
        'secret': secret,
        'env': os.environ.get('PLAID_ENV', 'production'),
        'item_limit': DEFAULT_ITEM_LIMIT,
        'source': 'house',
    }


def get_plaid_for_creds(creds: dict) -> plaid_api.PlaidApi:
    key = (creds['plaid_client_id'], creds['env'])
    if key not in _clients:
        configuration = plaid.Configuration(
            host=_ENV_MAP[creds['env']],
            api_key={
                'clientId': creds['plaid_client_id'],
                'secret': creds['secret'],
            }
        )
        _clients[key] = plaid_api.PlaidApi(plaid.ApiClient(configuration))
    return _clients[key]


def get_plaid() -> plaid_api.PlaidApi:
    """House (env-var) Plaid account — legacy paths and items with no plaid_client_id."""
    creds = house_creds()
    if creds is None:
        raise RuntimeError(
            'No house Plaid credentials (PLAID_CLIENT_ID/PLAID_SECRET unset) — '
            'credentials live per-user in plaid_credentials now'
        )
    return get_plaid_for_creds(creds)


def _row_to_creds(row: dict) -> dict:
    return {
        'plaid_client_id': row['plaid_client_id'],
        'secret': vault.decrypt(row['plaid_secret_enc']),
        'env': row['plaid_env'],
        'item_limit': row['item_limit'],
        'source': 'user',
    }


def load_user_credentials(supabase, user_id: str):
    """The user's own active credentials row (decrypted), or None."""
    rows = supabase.table('plaid_credentials').select('*') \
        .eq('user_id', user_id).eq('is_active', True) \
        .limit(1).execute().data
    return _row_to_creds(rows[0]) if rows else None


def credentials_for_user(supabase, user_id: str):
    """The user's own Plaid credentials, else the legacy house account, else
    None (user must add credentials in Settings before linking banks)."""
    return load_user_credentials(supabase, user_id) or house_creds()


def credentials_for_client_id(supabase, plaid_client_id: str):
    """Credentials for a specific Plaid developer account. The database wins
    over the legacy env fallback — after migrating the house account into a
    plaid_credentials row, the same client_id resolves from the row."""
    if plaid_client_id not in _creds_cache:
        rows = supabase.table('plaid_credentials').select('*') \
            .eq('plaid_client_id', plaid_client_id).eq('is_active', True) \
            .limit(1).execute().data
        if not rows:
            house = house_creds()
            if house and house['plaid_client_id'] == plaid_client_id:
                return house
            return None
        _creds_cache[plaid_client_id] = _row_to_creds(rows[0])
    return _creds_cache[plaid_client_id]


def get_plaid_for_item(supabase, item: dict) -> plaid_api.PlaidApi:
    """Client for the Plaid developer account that owns this item."""
    client_id = item.get('plaid_client_id')
    if not client_id:
        return get_plaid()
    creds = credentials_for_client_id(supabase, client_id)
    if creds is None:
        raise RuntimeError(
            f"No active plaid_credentials for client {client_id} "
            f"(item {item.get('plaid_item_id')}) — user removed their credentials?"
        )
    return get_plaid_for_creds(creds)


def fetch_institution_metadata(plaid_api_client: plaid_api.PlaidApi, institution_id) -> dict:
    """Institution branding (base64 PNG logo, brand color, homepage URL) from
    institutions/get_by_id. Best-effort: returns {} on any failure so linking
    never breaks over a missing logo. None values are dropped so an upsert
    can't null out branding stored earlier."""
    if not institution_id:
        return {}
    try:
        resp = plaid_api_client.institutions_get_by_id(InstitutionsGetByIdRequest(
            institution_id=institution_id,
            country_codes=[CountryCode('US')],
            options=InstitutionsGetByIdRequestOptions(include_optional_metadata=True),
        )).to_dict()
        inst = resp.get('institution') or {}
        return {k: v for k, v in {
            'institution_logo': inst.get('logo'),
            'institution_primary_color': inst.get('primary_color'),
            'institution_url': inst.get('url'),
        }.items() if v}
    except Exception:
        # Indistinguishable from "institution has no branding" without this.
        logger.warning('institutions_get_by_id failed', exc_info=True,
                       extra={'institution_id': institution_id})
        return {}


def invalidate_credentials_cache(plaid_client_id: str = None):
    """Call after a plaid_credentials row changes (secret rotated, row deleted)."""
    if plaid_client_id is None:
        _creds_cache.clear()
        _clients.clear()
        return
    _creds_cache.pop(plaid_client_id, None)
    for key in [k for k in _clients if k[0] == plaid_client_id]:
        _clients.pop(key)
