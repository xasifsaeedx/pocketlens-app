"""Logic-tier test for DELETE /items/{id} (api.delete_item).

Guards the two bugs that made unlinking a bank a 500:
  * get_plaid_for_item must be imported into api — else the Plaid item_remove
    call NameErrors, is swallowed, and the token is never invalidated.
  * accounts/transactions must be deleted by the real FK column
    accounts.plaid_item_id, not a non-existent accounts.item_id.
"""
import api
import plaid_client
import vault
from tests.fakes import FakeSupabase

USER = "user-1"
ITEM = "item-uuid-1"


class _Remover:
    """Stands in for a Plaid client; records the invalidated access token."""
    def __init__(self):
        self.removed = None

    def item_remove(self, req):
        self.removed = req.access_token


def _db():
    return FakeSupabase(tables={
        "plaid_items": [
            {"id": ITEM, "user_id": USER, "plaid_item_id": "plaid-1",
             "access_token": "access-tok", "plaid_client_id": None, "is_active": True},
            {"id": "item-other", "user_id": USER, "plaid_item_id": "plaid-2",
             "access_token": "tok2", "plaid_client_id": None, "is_active": True},
        ],
        "accounts": [
            {"id": "acc-1", "plaid_item_id": ITEM, "is_active": True},
            {"id": "acc-2", "plaid_item_id": ITEM, "is_active": True},
            {"id": "acc-other", "plaid_item_id": "item-other", "is_active": True},
        ],
        "transactions": [
            {"id": "txn-1", "account_id": "acc-1", "date": "2026-01-01", "amount": 1},
            {"id": "txn-2", "account_id": "acc-2", "date": "2026-01-02", "amount": 2},
            {"id": "txn-other", "account_id": "acc-other", "date": "2026-01-03", "amount": 3},
        ],
    })


def test_delete_item_invalidates_plaid_and_scopes_cleanup(monkeypatch):
    db = _db()
    remover = _Remover()
    monkeypatch.setattr(api, "get_supabase", lambda: db)
    monkeypatch.setattr(api, "_user_id_from_token", lambda auth: USER)
    monkeypatch.setattr(vault, "decrypt", lambda tok: tok)
    # plaid_client_id is None on the item, so get_plaid_for_item falls back to
    # the house client — patch that to the recorder.
    monkeypatch.setattr(plaid_client, "get_plaid", lambda: remover)

    result = api.delete_item(ITEM, authorization="bearer")

    assert result == {"status": "ok"}
    # Bug A: Plaid item_remove actually ran with the decrypted token.
    assert remover.removed == "access-tok"
    # Bug B: only this item's accounts/transactions removed, by plaid_item_id.
    assert {r["id"] for r in db.rows("accounts")} == {"acc-other"}
    assert {r["id"] for r in db.rows("transactions")} == {"txn-other"}
    # Item soft-deleted; the unrelated item untouched.
    assert db.one("plaid_items", id=ITEM)["is_active"] is False
    assert db.one("plaid_items", id="item-other")["is_active"] is True


class _MultiRemover:
    """Plaid client stub that records every invalidated access token."""
    def __init__(self):
        self.removed = []

    def item_remove(self, req):
        self.removed.append(req.access_token)


class _Auth:
    """Stands in for supabase.auth.admin — records the deleted user id."""
    def __init__(self):
        self.admin = self
        self.deleted = None

    def delete_user(self, uid):
        self.deleted = uid


def test_delete_account_removes_every_plaid_item_then_deletes_user(monkeypatch):
    """Clean break: DELETE /account must invalidate every active Plaid item on
    Plaid's side BEFORE deleting the auth user (whose cascade drops the rows),
    or the tokens leak on Plaid. Regression guard for that ordering."""
    db = _db()
    db.auth = _Auth()
    remover = _MultiRemover()
    monkeypatch.setattr(api, "get_supabase", lambda: db)
    monkeypatch.setattr(api, "_user_id_from_token", lambda auth: USER)
    monkeypatch.setattr(vault, "decrypt", lambda tok: tok)
    monkeypatch.setattr(plaid_client, "get_plaid", lambda: remover)

    result = api.delete_account(authorization="bearer")

    assert result == {"deleted": True}
    # Both of the user's active items were invalidated on Plaid.
    assert sorted(remover.removed) == ["access-tok", "tok2"]
    # And only then was the auth user deleted (cascade removes the DB rows).
    assert db.auth.deleted == USER
