"""Per-user Plaid credentials: vault encryption, client routing, item caps,
and encrypted access tokens flowing through sync.

Same tier as test_logic.py — fakes only, no network, no live database.
"""
import pytest
from cryptography.fernet import Fernet

import plaid_client
import sync
import vault
from tests.fakes import FakePlaid, FakeSupabase

USER = "00000000-0000-0000-0000-000000000001"
HOUSE_CLIENT = "house-client-id"


@pytest.fixture(autouse=True)
def _clean_state(monkeypatch):
    """Fresh Fernet key + house env + empty caches for every test."""
    monkeypatch.setenv("CREDENTIALS_ENC_KEY", Fernet.generate_key().decode())
    monkeypatch.setenv("PLAID_CLIENT_ID", HOUSE_CLIENT)
    monkeypatch.setenv("PLAID_SECRET", "house-secret")
    monkeypatch.setenv("PLAID_ENV", "production")
    monkeypatch.delenv("PLAID_SANDBOX_SECRET", raising=False)
    vault._fernet = None
    plaid_client.invalidate_credentials_cache()
    yield
    vault._fernet = None
    plaid_client.invalidate_credentials_cache()


# ── 1. Vault ────────────────────────────────────────────────────────────────

def test_vault_roundtrip_and_legacy_passthrough(monkeypatch):
    ciphertext = vault.encrypt("access-production-abc123")
    assert ciphertext != "access-production-abc123"
    assert ciphertext.startswith(vault.FERNET_PREFIX)
    assert vault.decrypt(ciphertext) == "access-production-abc123"

    # pre-encryption rows (plaintext Plaid tokens) pass through unchanged
    assert vault.decrypt("access-production-legacy") == "access-production-legacy"
    assert vault.decrypt(None) is None

    # no key → loud failure on encrypt (never silently store plaintext)
    monkeypatch.delenv("CREDENTIALS_ENC_KEY")
    vault._fernet = None
    with pytest.raises(RuntimeError, match="CREDENTIALS_ENC_KEY"):
        vault.encrypt("x")
    # ...but legacy plaintext is still readable without the key
    assert vault.decrypt("access-production-legacy") == "access-production-legacy"


# ── 2. Credential lookup / client routing ───────────────────────────────────

def _creds_row(client_id="user-client-id", secret="user-secret", **over):
    row = {
        "id": "cred-1", "user_id": USER,
        "plaid_client_id": client_id,
        "plaid_secret_enc": vault.encrypt(secret),
        "plaid_env": "production", "item_limit": 10, "is_active": True,
    }
    row.update(over)
    return row


def test_credentials_for_user_prefers_own_row_and_decrypts():
    db = FakeSupabase(tables={"plaid_credentials": [_creds_row()]})
    creds = plaid_client.credentials_for_user(db, USER)
    assert creds["source"] == "user"
    assert creds["plaid_client_id"] == "user-client-id"
    assert creds["secret"] == "user-secret"     # decrypted, not ciphertext


def test_credentials_for_user_falls_back_to_house():
    db = FakeSupabase(tables={"plaid_credentials": []})
    creds = plaid_client.credentials_for_user(db, USER)
    assert creds["source"] == "house"
    assert creds["plaid_client_id"] == HOUSE_CLIENT
    assert creds["secret"] == "house-secret"


def test_inactive_credentials_ignored():
    db = FakeSupabase(tables={"plaid_credentials": [_creds_row(is_active=False)]})
    assert plaid_client.load_user_credentials(db, USER) is None
    assert plaid_client.credentials_for_user(db, USER)["source"] == "house"


def _client_id_of(client):
    return client.api_client.configuration.api_key["clientId"]


def test_get_plaid_for_item_routes_by_items_client_id():
    db = FakeSupabase(tables={"plaid_credentials": [_creds_row()]})

    byo_item = {"plaid_item_id": "it-1", "plaid_client_id": "user-client-id"}
    assert _client_id_of(plaid_client.get_plaid_for_item(db, byo_item)) == "user-client-id"

    # null client_id = pre-migration item on the house account
    house_item = {"plaid_item_id": "it-2", "plaid_client_id": None}
    assert _client_id_of(plaid_client.get_plaid_for_item(db, house_item)) == HOUSE_CLIENT


def test_get_plaid_for_item_raises_when_credentials_gone():
    db = FakeSupabase(tables={"plaid_credentials": []})
    orphan = {"plaid_item_id": "it-3", "plaid_client_id": "deleted-client-id"}
    with pytest.raises(RuntimeError, match="deleted-client-id"):
        plaid_client.get_plaid_for_item(db, orphan)


# ── 3. Item cap counting ────────────────────────────────────────────────────

def test_items_in_use_counts_only_that_credential():
    from api import _items_in_use
    db = FakeSupabase(tables={"plaid_items": [
        {"id": "i1", "plaid_client_id": "user-client-id", "is_active": True},
        {"id": "i2", "plaid_client_id": "user-client-id", "is_active": True},
        {"id": "i3", "plaid_client_id": "user-client-id", "is_active": False},  # unlinked
        {"id": "i4", "plaid_client_id": "someone-else", "is_active": True},
    ]})
    assert _items_in_use(db, "user-client-id", house=False) == 2


# ── 4. Sync uses decrypted tokens + per-item clients ────────────────────────

def test_sync_item_decrypts_access_token():
    """An encrypted access_token in plaid_items must reach Plaid decrypted."""
    seen_tokens = []

    class RecordingPlaid(FakePlaid):
        def transactions_sync(self, req):
            seen_tokens.append(req.access_token if hasattr(req, "access_token")
                               else req["access_token"])
            return super().transactions_sync(req)

    plaid = RecordingPlaid(
        accounts=[{"account_id": "pa-1", "name": "Checking", "type": "depository",
                   "subtype": "checking", "balances": {"current": 100, "available": 90}}],
        pages=[{"added": [], "modified": [], "removed": [],
                "next_cursor": "cur-1", "has_more": False}],
    )
    db = FakeSupabase(tables={
        "plaid_items": [{"id": "item-1", "user_id": USER,
                         "access_token": vault.encrypt("access-production-real"),
                         "plaid_client_id": "user-client-id",
                         "institution_name": "Bank", "cursor": None,
                         "last_synced_at": None, "is_syncing": False}],
    })

    item = db.rows("plaid_items")[0]
    ctx = {"memory": {}, "rules": [], "income_id": None}
    sync.sync_item(plaid, db, item, ctx, sync._new_stats(), USER, refresh_balances=True)

    assert seen_tokens == ["access-production-real"]
    assert db.one("plaid_items", id="item-1")["cursor"] == "cur-1"


# ── 5. House-less operation (credentials live in the DB only) ───────────────

def test_house_creds_none_without_env(monkeypatch):
    monkeypatch.delenv("PLAID_CLIENT_ID")
    monkeypatch.delenv("PLAID_SECRET")
    assert plaid_client.house_creds() is None
    db = FakeSupabase(tables={"plaid_credentials": []})
    assert plaid_client.credentials_for_user(db, USER) is None
    with pytest.raises(RuntimeError, match="house Plaid credentials"):
        plaid_client.get_plaid()


def test_db_row_wins_over_env_for_same_client_id():
    """Post-migration: the house account also exists as a user's row — the
    row (its possibly-rotated secret) must win over the env fallback."""
    db = FakeSupabase(tables={
        "plaid_credentials": [_creds_row(client_id=HOUSE_CLIENT, secret="db-secret")],
    })
    creds = plaid_client.credentials_for_client_id(db, HOUSE_CLIENT)
    assert creds["source"] == "user"
    assert creds["secret"] == "db-secret"


def test_client_id_falls_back_to_env_house_when_no_row():
    db = FakeSupabase(tables={"plaid_credentials": []})
    creds = plaid_client.credentials_for_client_id(db, HOUSE_CLIENT)
    assert creds["source"] == "house"


# ── 6. Demo items never touch Plaid ─────────────────────────────────────────

def test_run_sync_skips_demo_items(monkeypatch):
    """A seeded demo item (plaid_item_id 'demo-…', fake token) is skipped
    outright: no Plaid client resolved, no error in sync_log."""
    db = FakeSupabase(tables={
        "plaid_items": [{
            "id": "item-demo", "user_id": USER, "plaid_item_id": "demo-item-abc12345",
            "access_token": "demo-access-token-not-real", "plaid_client_id": None,
            "institution_name": "Demo Bank", "cursor": None,
            "last_synced_at": None, "is_syncing": False, "is_active": True,
        }],
    })
    monkeypatch.setattr(sync, "get_supabase", lambda: db)

    def boom(*a, **k):
        raise AssertionError("demo item must never resolve a Plaid client")
    monkeypatch.setattr(sync, "get_plaid_for_item", boom)

    sync.run_sync()

    log = db.rows("sync_log")[-1]
    assert log["status"] == "success", log.get("error_message")


def test_run_sync_for_item_skips_demo_webhook(monkeypatch):
    db = FakeSupabase(tables={
        "plaid_items": [{
            "id": "item-demo", "user_id": USER, "plaid_item_id": "demo-item-abc12345",
            "access_token": "demo-access-token-not-real", "plaid_client_id": None,
            "institution_name": "Demo Bank", "cursor": None,
            "last_synced_at": None, "is_syncing": False, "is_active": True,
        }],
    })
    monkeypatch.setattr(sync, "get_supabase", lambda: db)
    monkeypatch.setattr(sync, "get_plaid_for_item",
                        lambda *a, **k: (_ for _ in ()).throw(AssertionError("no Plaid for demo")))

    sync.run_sync_for_item("demo-item-abc12345", "SYNC_UPDATES_AVAILABLE")

    assert db.rows("sync_log") == [], "skip must not open a sync_log row"
