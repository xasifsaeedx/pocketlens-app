"""Tests for POST /backfill-all — the Settings "Full sync" button.

Resets every active item's cursor to re-pull the 730d window, rate-limited to
once per FULL_SYNC_COOLDOWN_DAYS. Fakes only, no network, no live database.
"""
import datetime

import pytest
from cryptography.fernet import Fernet
from fastapi.testclient import TestClient

import api
import plaid_client
import vault
from tests.fakes import FakeSupabase

USER = "00000000-0000-0000-0000-000000000001"
OTHER_USER = "00000000-0000-0000-0000-000000000002"
CLIENT_ID = "a" * 24


@pytest.fixture(autouse=True)
def _clean_state(monkeypatch):
    monkeypatch.setenv("CREDENTIALS_ENC_KEY", Fernet.generate_key().decode())
    vault._fernet = None
    plaid_client.invalidate_credentials_cache()
    yield
    vault._fernet = None
    plaid_client.invalidate_credentials_cache()


@pytest.fixture()
def client():
    return TestClient(api.app, raise_server_exceptions=False)


def _item(item_id, user_id=USER, is_active=True, cursor="cur", last_backfill_at=None):
    return {
        "id": item_id,
        "user_id": user_id,
        "plaid_item_id": f"plaid-{item_id}",
        "access_token": vault.encrypt("access-tok"),
        "plaid_client_id": CLIENT_ID,
        "is_active": is_active,
        "cursor": cursor,
        "backfill_requested": False,
        "last_backfill_at": last_backfill_at,
    }


def _wire(monkeypatch, db, *, user_id=USER, sync_calls=None):
    monkeypatch.setattr(api, "get_supabase", lambda: db)
    monkeypatch.setattr(api, "_user_id_from_token", lambda t: user_id)
    if sync_calls is not None:
        monkeypatch.setattr(api, "run_sync", lambda uid: sync_calls.append(uid))


def _iso(delta_days=0):
    return (datetime.datetime.now(datetime.UTC)
            + datetime.timedelta(days=delta_days)).isoformat()


# ── happy path ────────────────────────────────────────────────────────────────

def test_backfill_all_resets_every_active_item(monkeypatch, client):
    db = FakeSupabase(tables={"plaid_items": [
        _item("i1", cursor="c1"),
        _item("i2", cursor="c2"),
        _item("i3", user_id=OTHER_USER, cursor="c3"),   # other user — untouched
        _item("i4", is_active=False, cursor="c4"),       # inactive — untouched
    ]})
    _wire(monkeypatch, db)

    resp = client.post("/backfill-all", headers={"Authorization": "Bearer tok"})
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok", "items": 2}

    for iid in ("i1", "i2"):
        row = db.one("plaid_items", id=iid)
        assert row["cursor"] is None
        assert row["backfill_requested"] is True
        assert row["last_backfill_at"] is not None
    # Untouched rows keep their cursor.
    assert db.one("plaid_items", id="i3")["cursor"] == "c3"
    assert db.one("plaid_items", id="i4")["cursor"] == "c4"


def test_backfill_all_kicks_one_full_user_sync(monkeypatch, client):
    sync_calls = []
    db = FakeSupabase(tables={"plaid_items": [_item("i1"), _item("i2")]})
    _wire(monkeypatch, db, sync_calls=sync_calls)

    client.post("/backfill-all", headers={"Authorization": "Bearer tok"})
    assert sync_calls == [USER]   # one run_sync for the whole user, not per-item


def test_backfill_all_404_when_no_banks(monkeypatch, client):
    db = FakeSupabase(tables={"plaid_items": []})
    _wire(monkeypatch, db)

    resp = client.post("/backfill-all", headers={"Authorization": "Bearer tok"})
    assert resp.status_code == 404


# ── cooldown ──────────────────────────────────────────────────────────────────

def test_backfill_all_blocks_within_cooldown(monkeypatch, client):
    sync_calls = []
    db = FakeSupabase(tables={"plaid_items": [
        _item("i1", last_backfill_at=_iso(0)),   # just full-synced
        _item("i2"),
    ]})
    _wire(monkeypatch, db, sync_calls=sync_calls)

    resp = client.post("/backfill-all", headers={"Authorization": "Bearer tok"})
    assert resp.status_code == 429
    body = resp.json()
    assert body["status"] == "cooldown"
    assert body["next_at"]
    assert sync_calls == []                       # no sync kicked
    assert db.one("plaid_items", id="i2")["cursor"] == "cur"   # nothing reset


def test_backfill_all_allowed_after_cooldown(monkeypatch, client):
    db = FakeSupabase(tables={"plaid_items": [
        _item("i1", last_backfill_at=_iso(-3)),   # 3 days ago > 2-day cooldown
    ]})
    _wire(monkeypatch, db)

    resp = client.post("/backfill-all", headers={"Authorization": "Bearer tok"})
    assert resp.status_code == 200
    assert resp.json()["status"] == "ok"


def test_backfill_all_401_without_auth(monkeypatch, client):
    db = FakeSupabase(tables={"plaid_items": [_item("i1")]})
    monkeypatch.setattr(api, "get_supabase", lambda: db)

    resp = client.post("/backfill-all")
    assert resp.status_code == 401
