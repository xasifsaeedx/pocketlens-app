"""Tests for the backfill-prompt feature:
  - POST /backfill/{item_id} endpoint
  - POST /link/exchange returning item_id + new_account

Same tier as test_onboarding.py — fakes only, no network, no live database.
"""
import pytest
from cryptography.fernet import Fernet
from fastapi.testclient import TestClient

import api
import plaid_client
import vault
from tests.fakes import FakeSupabase

# ── Constants ────────────────────────────────────────────────────────────────

USER = "00000000-0000-0000-0000-000000000001"
OTHER_USER = "00000000-0000-0000-0000-000000000002"
ITEM_UUID = "aaaaaaaa-0000-0000-0000-000000000001"
PLAID_ITEM_ID = "plaid-item-abc123"
CLIENT_ID = "a" * 24
USER_SECRET = "b" * 30


# ── Fixtures ─────────────────────────────────────────────────────────────────

@pytest.fixture(autouse=True)
def _clean_state(monkeypatch):
    """Fresh vault key + empty credential cache for every test."""
    monkeypatch.setenv("CREDENTIALS_ENC_KEY", Fernet.generate_key().decode())
    monkeypatch.delenv("PLAID_CLIENT_ID", raising=False)
    monkeypatch.delenv("PLAID_SECRET", raising=False)
    vault._fernet = None
    plaid_client.invalidate_credentials_cache()
    yield
    vault._fernet = None
    plaid_client.invalidate_credentials_cache()


@pytest.fixture()
def client():
    return TestClient(api.app, raise_server_exceptions=False)


def _make_item(item_id=ITEM_UUID, user_id=USER, plaid_item_id=PLAID_ITEM_ID,
               cursor="some-cursor", is_active=True, backfill_requested=False):
    """Minimal plaid_items row."""
    return {
        "id": item_id,
        "user_id": user_id,
        "plaid_item_id": plaid_item_id,
        "access_token": vault.encrypt("access-production-tok"),
        "plaid_client_id": CLIENT_ID,
        "is_active": is_active,
        "cursor": cursor,
        "backfill_requested": backfill_requested,
    }


def _wire(monkeypatch, db, *, user_id=USER, sync_calls=None):
    """Patch api to use the given FakeSupabase and a fixed user_id.
    sync_calls is an optional list that records (plaid_item_id, code) pairs
    to verify background task was enqueued with the right args."""
    monkeypatch.setattr(api, "get_supabase", lambda: db)
    monkeypatch.setattr(api, "_user_id_from_token", lambda t: user_id)

    if sync_calls is not None:
        def fake_sync(plaid_item_id, code):
            sync_calls.append((plaid_item_id, code))
        monkeypatch.setattr(api, "run_sync_for_item", fake_sync)


# ── POST /backfill/{item_id} ─────────────────────────────────────────────────

def test_backfill_returns_ok_for_owner(monkeypatch, client):
    """200 {"status": "ok"} when the item belongs to the calling user."""
    db = FakeSupabase(tables={"plaid_items": [_make_item()]})
    _wire(monkeypatch, db)

    resp = client.post(f"/backfill/{ITEM_UUID}",
                       headers={"Authorization": "Bearer tok"})
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}


def test_backfill_sets_cursor_none_and_flag(monkeypatch, client):
    """After a successful call, cursor is None and backfill_requested is True."""
    db = FakeSupabase(tables={"plaid_items": [_make_item(cursor="old-cursor")]})
    _wire(monkeypatch, db)

    client.post(f"/backfill/{ITEM_UUID}",
                headers={"Authorization": "Bearer tok"})

    row = db.one("plaid_items", id=ITEM_UUID)
    assert row["cursor"] is None
    assert row["backfill_requested"] is True


def test_backfill_enqueues_background_sync(monkeypatch, client):
    """The endpoint kicks off run_sync_for_item with HISTORICAL_UPDATE."""
    sync_calls = []
    db = FakeSupabase(tables={"plaid_items": [_make_item()]})
    _wire(monkeypatch, db, sync_calls=sync_calls)

    client.post(f"/backfill/{ITEM_UUID}",
                headers={"Authorization": "Bearer tok"})

    assert len(sync_calls) == 1
    assert sync_calls[0] == (PLAID_ITEM_ID, "HISTORICAL_UPDATE")


def test_backfill_404_when_item_not_found(monkeypatch, client):
    """404 when the item_id doesn't exist in the database at all."""
    db = FakeSupabase(tables={"plaid_items": []})
    _wire(monkeypatch, db)

    resp = client.post("/backfill/nonexistent-id",
                       headers={"Authorization": "Bearer tok"})
    assert resp.status_code == 404


def test_backfill_404_when_item_belongs_to_other_user(monkeypatch, client):
    """404 when the item exists but belongs to a different user (ownership check)."""
    # Item owned by OTHER_USER; the calling user is USER
    db = FakeSupabase(tables={"plaid_items": [_make_item(user_id=OTHER_USER)]})
    _wire(monkeypatch, db, user_id=USER)  # caller is USER

    resp = client.post(f"/backfill/{ITEM_UUID}",
                       headers={"Authorization": "Bearer tok"})
    assert resp.status_code == 404


def test_backfill_404_when_item_inactive(monkeypatch, client):
    """404 when the item exists but is not active (is_active=False)."""
    db = FakeSupabase(tables={"plaid_items": [_make_item(is_active=False)]})
    _wire(monkeypatch, db)

    resp = client.post(f"/backfill/{ITEM_UUID}",
                       headers={"Authorization": "Bearer tok"})
    assert resp.status_code == 404


def test_backfill_401_without_authorization_header(monkeypatch, client):
    """401 when no Authorization header is provided."""
    db = FakeSupabase(tables={"plaid_items": [_make_item()]})
    # Do NOT patch _user_id_from_token — let the real one run (it raises 401
    # immediately for an empty/missing token before touching the DB).
    monkeypatch.setattr(api, "get_supabase", lambda: db)

    resp = client.post(f"/backfill/{ITEM_UUID}")
    assert resp.status_code == 401


# ── POST /link/exchange ───────────────────────────────────────────────────────

class _FakePlaidExchange:
    """Minimal fake of the Plaid client surface used by link_exchange."""
    def item_public_token_exchange(self, req):
        class _R:
            def to_dict(self_inner):
                return {
                    "item_id": PLAID_ITEM_ID,
                    "access_token": "access-production-tok",
                }
        return _R()


class _FakeInstitutionFetch:
    """Returns empty metadata (colour/logo) so link_exchange doesn't need a real Plaid call."""
    def __init__(self):
        pass


def _wire_exchange(monkeypatch, db):
    """Wire up all the collaborators link_exchange calls."""
    monkeypatch.setattr(api, "get_supabase", lambda: db)
    monkeypatch.setattr(api, "_user_id_from_token", lambda t: USER)
    monkeypatch.setattr(api, "credentials_for_user", lambda sb, uid: {
        "plaid_client_id": CLIENT_ID,
        "secret": USER_SECRET,
        "env": "production",
        "source": "user",
    })
    monkeypatch.setattr(api, "get_plaid_for_creds", lambda creds: _FakePlaidExchange())
    monkeypatch.setattr(api, "fetch_institution_metadata", lambda plaid, inst_id: {})


def test_link_exchange_returns_item_id_and_new_account(monkeypatch, client):
    """POST /link/exchange must include item_id and new_account:true in response."""
    db = FakeSupabase(tables={"plaid_items": []})
    _wire_exchange(monkeypatch, db)

    resp = client.post("/link/exchange", json={
        "public_token": "public-sandbox-tok",
        "access_token": "Bearer user-jwt",
        "metadata": {
            "institution": {"institution_id": "ins_1", "name": "Chase"},
        },
    })
    assert resp.status_code == 200
    data = resp.json()
    assert data["institution"] == "Chase"
    assert data["new_account"] is True
    # item_id must be the UUID of the row that was just upserted
    row = db.one("plaid_items", plaid_item_id=PLAID_ITEM_ID)
    assert row is not None
    assert data["item_id"] == str(row["id"])


def test_link_exchange_item_id_is_string(monkeypatch, client):
    """item_id in the response is always a string (str(uuid))."""
    db = FakeSupabase(tables={"plaid_items": []})
    _wire_exchange(monkeypatch, db)

    resp = client.post("/link/exchange", json={
        "public_token": "public-sandbox-tok",
        "access_token": "Bearer user-jwt",
        "metadata": {},
    })
    assert resp.status_code == 200
    assert isinstance(resp.json()["item_id"], str)


# ── POST /link/claim (update-mode reconnect) ──────────────────────────────────

def _make_item_named(institution_name="Chase", **kw):
    """plaid_items row carrying an institution_name for the claim banner."""
    row = _make_item(**kw)
    row["institution_name"] = institution_name
    return row


def test_link_claim_404_when_item_not_found(monkeypatch, client):
    """404 when the item_id doesn't exist at all."""
    db = FakeSupabase(tables={"plaid_items": []})
    _wire(monkeypatch, db)

    resp = client.post("/link/claim",
                       json={"item_id": "nonexistent-id", "access_token": "jwt"})
    assert resp.status_code == 404


def test_link_claim_404_when_item_belongs_to_other_user(monkeypatch, client):
    """404 when the item exists but belongs to a different user (ownership check)."""
    db = FakeSupabase(tables={"plaid_items": [_make_item_named(user_id=OTHER_USER)]})
    _wire(monkeypatch, db, user_id=USER)  # caller is USER

    resp = client.post("/link/claim",
                       json={"item_id": ITEM_UUID, "access_token": "jwt"})
    assert resp.status_code == 404


def test_link_claim_400_without_item_id(monkeypatch, client):
    """400 when item_id is missing from the body."""
    db = FakeSupabase(tables={"plaid_items": [_make_item_named()]})
    _wire(monkeypatch, db)

    resp = client.post("/link/claim", json={"access_token": "jwt"})
    assert resp.status_code == 400


def test_link_claim_happy_path_backfills_and_returns_institution(monkeypatch, client):
    """Owner reconnect: resets cursor + backfill flag, enqueues a HISTORICAL_UPDATE
    re-pull, and returns the institution name for the success banner. No token
    is exchanged — the item's access_token is untouched."""
    sync_calls = []
    db = FakeSupabase(tables={"plaid_items": [
        _make_item_named(institution_name="Chase", cursor="old-cursor"),
    ]})
    _wire(monkeypatch, db, sync_calls=sync_calls)

    resp = client.post("/link/claim",
                       json={"item_id": ITEM_UUID, "access_token": "jwt"})

    assert resp.status_code == 200
    assert resp.json() == {"institution": "Chase", "item_id": str(ITEM_UUID)}

    # Full re-pull armed on the reconnected item.
    row = db.one("plaid_items", id=ITEM_UUID)
    assert row["cursor"] is None
    assert row["backfill_requested"] is True

    # Background sync kicked with the Plaid item id, historical code.
    assert sync_calls == [(PLAID_ITEM_ID, "HISTORICAL_UPDATE")]


def test_link_claim_falls_back_to_account_when_name_missing(monkeypatch, client):
    """A row with no institution_name yields the 'account' banner fallback."""
    db = FakeSupabase(tables={"plaid_items": [_make_item_named(institution_name=None)]})
    _wire(monkeypatch, db)

    resp = client.post("/link/claim",
                       json={"item_id": ITEM_UUID, "access_token": "jwt"})
    assert resp.status_code == 200
    assert resp.json()["institution"] == "account"
