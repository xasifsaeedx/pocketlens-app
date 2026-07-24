"""Logic tests for reconcile.py — the nightly drift healer.

Same tier as test_logic.py: real production functions against the in-memory
Supabase/Plaid fakes. The invariants that matter:

  - each drift class heals (missing → insert, mismatched → update, stale → delete)
  - user-owned columns (category_id, notes, hidden, exclude_from_totals,
    transfer_*) are NEVER written by the healer
  - transfer-group bookkeeping matches sync.py's modified/removed paths
  - the item cursor is never touched (it belongs to the incremental sync)

Run:  pytest tests/test_reconcile.py      (from finance-backend/sync-service)
"""
import reconcile
from tests.fakes import FakePlaid, FakeSupabase

USER = "user-1"

CTX = {"memory": {"whole foods": "cat-groceries"}, "rules": [], "income_id": "cat-income"}


def _plaid_txn(tid, acct="pa-check", date="2026-06-10", amount=10.0,
               merchant="Shop", name="SHOP", pending=False,
               primary="FOOD", detailed="FOOD_GROCERIES"):
    return {
        "transaction_id": tid, "account_id": acct, "date": date,
        "authorized_date": None, "amount": amount, "merchant_name": merchant,
        "name": name, "pending": pending,
        "personal_finance_category": {"primary": primary, "detailed": detailed},
    }


def _db_row(tid, amount=10.0, merchant="Shop", name="SHOP", date="2026-06-10",
            pending=False, primary="FOOD", detailed="FOOD_GROCERIES", **extra):
    return {
        "plaid_transaction_id": tid, "user_id": USER, "account_id": "acct-check",
        "date": date, "authorized_date": None, "amount": amount,
        "merchant_name": merchant, "description": name, "pending": pending,
        "plaid_category": primary, "plaid_category_detail": detailed,
        "category_id": None, **extra,
    }


def _db(transactions, cursor="cur-live"):
    return FakeSupabase(tables={
        "plaid_items": [{"id": "item-1", "user_id": USER, "access_token": "tok",
                         "institution_name": "Bank", "cursor": cursor,
                         "is_syncing": False, "plaid_item_id": "real-item"}],
        "accounts": [{"id": "acct-check", "plaid_account_id": "pa-check",
                      "plaid_item_id": "item-1", "user_id": USER, "is_active": True}],
        "transactions": transactions,
    })


def _plaid(*txns):
    """One snapshot page replaying everything as `added` (fresh-cursor shape)."""
    return FakePlaid(accounts=[], pages=[{
        "added": list(txns), "modified": [], "removed": [],
        "next_cursor": "snap-1", "has_more": False,
    }])


def _item(db):
    return db.rows("plaid_items")[0]


# ── no drift ─────────────────────────────────────────────────────────────────
def test_no_drift_writes_nothing():
    db = _db([_db_row("t-1")])
    plaid = _plaid(_plaid_txn("t-1"))

    drift = reconcile.reconcile_item(plaid, db, _item(db), CTX, USER)

    assert drift == {"missing": 0, "mismatched": 0, "stale": 0}
    txn_writes = [c for c in db.calls if c[0] == "transactions" and c[1] != "select"]
    assert txn_writes == [], "clean item must not touch transaction rows"


# ── missing ──────────────────────────────────────────────────────────────────
def test_missing_row_inserted_and_categorized():
    db = _db([_db_row("t-1")])
    plaid = _plaid(
        _plaid_txn("t-1"),
        _plaid_txn("t-lost", amount=42.5, merchant="Whole Foods", name="WHOLEFDS"),
    )

    drift = reconcile.reconcile_item(plaid, db, _item(db), CTX, USER)

    assert drift["missing"] == 1
    healed = db.one("transactions", plaid_transaction_id="t-lost")
    assert healed["account_id"] == "acct-check" and healed["amount"] == 42.5
    assert healed["category_id"] == "cat-groceries", "insert path must apply_learned"


def test_missing_txn_on_unmapped_account_skipped():
    db = _db([])
    plaid = _plaid(_plaid_txn("t-new", acct="pa-unknown"))

    drift = reconcile.reconcile_item(plaid, db, _item(db), CTX, USER)

    assert drift == {"missing": 0, "mismatched": 0, "stale": 0}
    assert db.one("transactions", plaid_transaction_id="t-new") is None


# ── mismatched ───────────────────────────────────────────────────────────────
def test_mismatch_heals_plaid_fields_only():
    db = _db([_db_row(
        "t-1", amount=40.0, merchant="Old Name", pending=True,
        # user-owned data that must survive the heal
        category_id="cat-user", notes="my note", hidden=True,
        exclude_from_totals=True,
    )])
    plaid = _plaid(_plaid_txn("t-1", amount=55.0, merchant="Costco", name="COSTCO"))

    drift = reconcile.reconcile_item(plaid, db, _item(db), CTX, USER)

    assert drift["mismatched"] == 1
    row = db.one("transactions", plaid_transaction_id="t-1")
    assert row["amount"] == 55.0 and row["merchant_name"] == "Costco"
    assert row["pending"] is False
    assert row["category_id"] == "cat-user", "user category clobbered"
    assert row["notes"] == "my note" and row["hidden"] is True
    assert row["exclude_from_totals"] is True


def test_amount_change_unlinks_auto_pair_keeps_manual():
    db = _db([
        _db_row("t-a", amount=100.0,
                transfer_group_id="g-auto", transfer_kind="auto"),
        _db_row("t-a2", amount=-100.0,
                transfer_group_id="g-auto", transfer_kind="auto",
                exclude_from_totals=True),
        _db_row("t-m", amount=50.0,
                transfer_group_id="g-manual", transfer_kind="manual"),
    ])
    plaid = _plaid(
        _plaid_txn("t-a", amount=101.0),                # amount drift → break pair
        _plaid_txn("t-a2", amount=-100.0),
        _plaid_txn("t-m", amount=51.0, merchant="Shop"),  # manual pair: heal, keep link
    )

    reconcile.reconcile_item(plaid, db, _item(db), CTX, USER)

    assert db.one("transactions", plaid_transaction_id="t-a")["transfer_group_id"] is None
    assert db.one("transactions", plaid_transaction_id="t-a2")["transfer_group_id"] is None
    m = db.one("transactions", plaid_transaction_id="t-m")
    assert m["amount"] == 51.0
    assert m["transfer_group_id"] == "g-manual", "manual links are the user's assertion"


# ── stale ────────────────────────────────────────────────────────────────────
def test_stale_row_deleted_and_partner_unlinked():
    db = _db([
        _db_row("t-keep"),
        _db_row("t-gone", transfer_group_id="g-1", transfer_kind="auto"),
        _db_row("t-partner", amount=-10.0, transfer_group_id="g-1",
                transfer_kind="auto", exclude_from_totals=True),
    ])
    plaid = _plaid(_plaid_txn("t-keep"), _plaid_txn("t-partner", amount=-10.0))

    drift = reconcile.reconcile_item(plaid, db, _item(db), CTX, USER)

    assert drift["stale"] == 1
    assert db.one("transactions", plaid_transaction_id="t-gone") is None
    partner = db.one("transactions", plaid_transaction_id="t-partner")
    assert partner["transfer_group_id"] is None, "orphaned leg must be freed to re-pair"
    assert partner["exclude_from_totals"] is False


# ── invariants ───────────────────────────────────────────────────────────────
def test_cursor_and_lock_restored():
    db = _db([_db_row("t-1")], cursor="cur-live")
    plaid = _plaid(_plaid_txn("t-1", amount=99.0))  # force a write

    reconcile.reconcile_item(plaid, db, _item(db), CTX, USER)

    item = db.one("plaid_items", id="item-1")
    assert item["cursor"] == "cur-live", "reconcile must never move the sync cursor"
    assert item["is_syncing"] is False


def test_subcent_amount_is_not_drift():
    """DB stores decimal(12,2); Plaid floats can carry sub-cent precision.
    Cents-compare must treat 4.24 (stored) vs 4.235 (Plaid) as equal — raw
    float != would re-flag the row every night forever."""
    db = _db([_db_row("t-fx", amount=4.24)])
    plaid = _plaid(_plaid_txn("t-fx", amount=4.235))

    drift = reconcile.reconcile_item(plaid, db, _item(db), CTX, USER)

    assert drift == {"missing": 0, "mismatched": 0, "stale": 0}


def test_empty_snapshot_refuses_stale_delete():
    db = _db([_db_row("t-1"), _db_row("t-2")])
    plaid = _plaid()  # successful but empty replay

    drift = reconcile.reconcile_item(plaid, db, _item(db), CTX, USER)

    assert drift["stale"] == 0
    assert db.one("transactions", plaid_transaction_id="t-1") is not None
    assert db.one("transactions", plaid_transaction_id="t-2") is not None


def test_rows_older_than_snapshot_window_are_not_stale():
    """Plaid's replay window can shrink (relink, retention aging). Rows older
    than the snapshot's oldest transaction are outside its evidence — keep them."""
    db = _db([
        _db_row("t-ancient", date="2024-01-05"),   # older than window
        _db_row("t-recent", date="2026-06-12"),    # inside window, truly gone
        _db_row("t-keep", date="2026-06-10"),
    ])
    plaid = _plaid(_plaid_txn("t-keep", date="2026-06-10"))

    drift = reconcile.reconcile_item(plaid, db, _item(db), CTX, USER)

    assert drift["stale"] == 1
    assert db.one("transactions", plaid_transaction_id="t-ancient") is not None
    assert db.one("transactions", plaid_transaction_id="t-recent") is None


def test_mass_stale_over_cap_refuses_delete():
    """A truncated replay must alert, not delete: > max(20, 10% of rows)
    stale is an anomaly."""
    rows = [_db_row(f"t-{i}") for i in range(30)]
    db = _db(rows)
    plaid = _plaid(_plaid_txn("t-0"))  # window covers them; 29 would be stale

    drift = reconcile.reconcile_item(plaid, db, _item(db), CTX, USER)

    assert drift["stale"] == 0
    assert len(db.rows("transactions")) == 30


def test_truncated_recent_window_replay_deletes_nothing():
    """A truncated-but-non-empty replay must not delete live rows.

    Plaid returns only a handful of *recent* txns this run (a short/partial
    replay). The DB holds those plus older history. Absence from a truncated
    replay is not proof of upstream deletion, so nothing must be deleted.

    The trap the anomaly cap has to catch is the interaction with the window
    floor: the missing older rows look like retention aging and get filtered
    out, leaving the missing *recent* rows (17 here) under the cap — the old
    order (floor filter, then cap) would have deleted those live rows. Gating
    the cap on the raw pre-floor divergence (22 > max(20, 10%)) refuses instead."""
    old = [_db_row(f"t-old-{i}", date="2024-01-05") for i in range(5)]
    recent = [_db_row(f"t-new-{i}", date="2026-06-10") for i in range(20)]
    db = _db(old + recent)
    # Replay truncated to 3 of the 20 recent txns; window floor = 2026-06-10.
    plaid = _plaid(*(_plaid_txn(f"t-new-{i}", date="2026-06-10") for i in range(3)))

    drift = reconcile.reconcile_item(plaid, db, _item(db), CTX, USER)

    assert drift["stale"] == 0
    assert len(db.rows("transactions")) == 25, "truncated replay must delete nothing"


def test_conflicted_insert_not_counted_as_drift(monkeypatch):
    """A row the paged read missed (or a concurrent writer inserted) conflicts
    on upsert: ON CONFLICT DO NOTHING returns nothing, so it must not count as
    drift, fire the alert warning, or clobber the existing row's user fields."""
    db = _db([_db_row("t-1"), _db_row("t-race", category_id="cat-user")])
    plaid = _plaid(_plaid_txn("t-1"), _plaid_txn("t-race"))
    real = reconcile._fetch_db_rows
    monkeypatch.setattr(reconcile, "_fetch_db_rows",
                        lambda s, ids: [r for r in real(s, ids)
                                        if r["plaid_transaction_id"] != "t-race"])

    drift = reconcile.reconcile_item(plaid, db, _item(db), CTX, USER)

    assert drift == {"missing": 0, "mismatched": 0, "stale": 0}
    assert db.one("transactions", plaid_transaction_id="t-race")["category_id"] == "cat-user"


def test_inactive_account_snapshot_rows_skipped_silently():
    db = _db([_db_row("t-1")])
    db._insert("accounts", {"plaid_account_id": "pa-closed", "plaid_item_id": "item-1",
                            "user_id": USER, "is_active": False})
    plaid = _plaid(_plaid_txn("t-1"), _plaid_txn("t-old", acct="pa-closed"))

    drift = reconcile.reconcile_item(plaid, db, _item(db), CTX, USER)

    assert drift == {"missing": 0, "mismatched": 0, "stale": 0}
    assert db.one("transactions", plaid_transaction_id="t-old") is None


def test_snapshot_applies_modified_and_removed_pages():
    """Plaid can interleave modified/removed mid-pagination; the snapshot must
    reflect them, not just the added stream."""
    plaid = FakePlaid(accounts=[], pages=[
        {"added": [_plaid_txn("t-1"), _plaid_txn("t-2")],
         "modified": [], "removed": [], "next_cursor": "c1", "has_more": True},
        {"added": [], "modified": [_plaid_txn("t-1", amount=77.0)],
         "removed": [{"transaction_id": "t-2"}], "next_cursor": "c2", "has_more": False},
    ])
    db = _db([_db_row("t-1"), _db_row("t-2")])

    drift = reconcile.reconcile_item(plaid, db, _item(db), CTX, USER)

    assert drift == {"missing": 0, "mismatched": 1, "stale": 1}
    assert db.one("transactions", plaid_transaction_id="t-1")["amount"] == 77.0
    assert db.one("transactions", plaid_transaction_id="t-2") is None


def test_busy_lock_skips_item(monkeypatch):
    db = _db([_db_row("t-1")])
    plaid = _plaid(_plaid_txn("t-1", amount=99.0))
    monkeypatch.setattr(reconcile, "_acquire_item_lock", lambda *a: False)

    drift = reconcile.reconcile_item(plaid, db, _item(db), CTX, USER)

    assert drift is None
    assert plaid.sync_count == 0
    assert db.one("transactions", plaid_transaction_id="t-1")["amount"] == 10.0


def test_sync_added_replay_preserves_user_category():
    """sync.py's added path must be ON CONFLICT DO NOTHING: reconcile mints rows
    ahead of the cursor, so the later replay of their added events must not
    reset user categorization (the lossless-heal contract's second-order path)."""
    import sync
    plaid = FakePlaid(
        accounts=[{"account_id": "pa-check", "name": "Checking", "type": "depository",
                   "subtype": "checking", "balances": {"current": 1, "available": 1}}],
        pages=[{"added": [_plaid_txn("t-healed")], "modified": [], "removed": [],
                "next_cursor": "c1", "has_more": False}])
    db = FakeSupabase(tables={
        "plaid_items": [{"id": "item-1", "user_id": USER, "access_token": "tok",
                         "institution_name": "Bank", "cursor": None,
                         "is_syncing": False}],
        "transactions": [_db_row("t-healed", category_id="cat-user", notes="kept")],
    })

    sync.sync_item(plaid, db, db.rows("plaid_items")[0], CTX, sync._new_stats(), USER)

    row = db.one("transactions", plaid_transaction_id="t-healed")
    assert row["category_id"] == "cat-user"
    assert row["notes"] == "kept"


# ── run_reconcile orchestration ──────────────────────────────────────────────
def test_run_reconcile_skips_demo_and_finalizes_only_drifted(monkeypatch):
    db = FakeSupabase(tables={
        "plaid_items": [
            {"id": "item-1", "user_id": USER, "access_token": "tok", "is_active": True,
             "institution_name": "Bank", "cursor": "c", "is_syncing": False,
             "plaid_item_id": "real-item"},
            {"id": "item-demo", "user_id": "user-demo", "access_token": "fake",
             "is_active": True, "institution_name": "Demo", "cursor": "c",
             "is_syncing": False, "plaid_item_id": "demo-item"},
        ],
        "accounts": [{"id": "acct-check", "plaid_account_id": "pa-check",
                      "plaid_item_id": "item-1", "user_id": USER, "is_active": True}],
        "transactions": [_db_row("t-1")],
    })
    plaid = _plaid(_plaid_txn("t-1"), _plaid_txn("t-lost"))

    finalized = []
    monkeypatch.setattr(reconcile, "get_supabase", lambda: db)
    monkeypatch.setattr(reconcile, "get_plaid_for_item", lambda s, i: plaid)
    monkeypatch.setattr(reconcile, "load_guess_context", lambda uid: CTX)
    monkeypatch.setattr(reconcile, "_finalize_user",
                        lambda s, uid, full: finalized.append((uid, full)))

    totals = reconcile.run_reconcile()

    assert totals == {"missing": 1, "mismatched": 0, "stale": 0}
    assert plaid.sync_count == 1, "demo item must never hit Plaid"
    assert finalized == [(USER, True)], "drifted user gets a full-history rescan"
