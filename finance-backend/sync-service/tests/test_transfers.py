"""Transfer auto-detection logic (transfers.py) against the in-memory Supabase.

Covers the matcher's gates (PFC signal, amount, account, window, pending/hidden/
opt-out), the credit-card tie-break, ambiguity skip, one-sided marking and its
in-place upgrade to a pair, idempotency, system unlink on removed/modified legs,
and the categorizer's transfer exemption.

Run:  pytest tests/test_transfers.py      (from finance-backend/sync-service)
"""
import datetime

import sync
import transfers
from categorizer import apply_learned
from tests.fakes import FakePlaid, FakeSupabase
from transfers import detect_transfers, unlink_groups

USER = "user-1"


def d(days_ago: int) -> str:
    return (datetime.date.today() - datetime.timedelta(days=days_ago)).isoformat()


def txn(id, account, amount, days_ago=2, pfc=None, **extra):
    # created_at defaults to the transaction date (a row dated N days ago was
    # typically ingested then); pass created_at=d(0) to model a backdated leg
    # that was only just delivered by Plaid. `**extra` can override.
    return {"id": id, "user_id": USER, "plaid_transaction_id": f"p-{id}",
            "account_id": account, "amount": amount, "date": d(days_ago),
            "created_at": d(days_ago),
            "pending": False, "plaid_category": pfc, **extra}


ACCOUNTS = [
    {"id": "a-check", "user_id": USER, "type": "depository"},
    {"id": "a-save", "user_id": USER, "type": "depository"},
    {"id": "a-card", "user_id": USER, "type": "credit"},
    {"id": "a-card2", "user_id": USER, "type": "credit"},
]


def db_with(*txns):
    return FakeSupabase(tables={"accounts": ACCOUNTS, "transactions": list(txns)})


def test_pfc_pair_links_and_excludes():
    db = db_with(
        txn("out", "a-check", 500.0, days_ago=3, pfc="TRANSFER_OUT"),
        txn("in", "a-save", -500.0, days_ago=2, pfc="TRANSFER_IN"),
    )
    stats = detect_transfers(db, USER)
    assert stats == {"linked": 1, "one_sided": 0}
    out, inn = db.one("transactions", id="out"), db.one("transactions", id="in")
    assert out["transfer_group_id"] == inn["transfer_group_id"] is not None
    assert out["transfer_kind"] == inn["transfer_kind"] == "auto"
    assert out["exclude_from_totals"] and inn["exclude_from_totals"]


def test_pfc_signal_on_one_leg_suffices():
    db = db_with(
        txn("out", "a-check", 250.0, pfc="TRANSFER_OUT"),
        txn("in", "a-save", -250.0, pfc=None),   # other bank tagged it poorly
    )
    assert detect_transfers(db, USER)["linked"] == 1


def test_no_pfc_signal_no_autolink():
    """Amount-only matches are the web-suggestions tier, never auto-linked."""
    db = db_with(
        txn("out", "a-check", 100.0),
        txn("in", "a-save", -100.0),
    )
    assert detect_transfers(db, USER) == {"linked": 0, "one_sided": 0}
    assert db.one("transactions", id="out")["transfer_group_id"] is None


def test_gates_same_account_amount_window_pending_hidden_optout():
    db = db_with(
        txn("out", "a-check", 500.0, days_ago=5, pfc="TRANSFER_OUT"),
        txn("same-acct", "a-check", -500.0, days_ago=5, pfc="TRANSFER_IN"),
        txn("off-amount", "a-save", -499.0, days_ago=5, pfc="TRANSFER_IN"),
        txn("too-late", "a-save", -500.0, days_ago=11, pfc="TRANSFER_IN"),  # 6 days apart
        txn("pending", "a-save", -500.0, days_ago=5, pfc="TRANSFER_IN", pending=True),
        txn("hidden", "a-save", -500.0, days_ago=5, pfc="TRANSFER_IN", hidden=True),
        txn("opted-out", "a-save", -500.0, days_ago=5, pfc="TRANSFER_IN",
            transfer_opt_out=True),
    )
    stats = detect_transfers(db, USER)
    assert stats["linked"] == 0
    # ... and none of the rejected rows got one-sided groups they shouldn't:
    # pending/hidden/opted-out are never touched; the rest ARE lone PFC legs.
    for id in ("pending", "hidden", "opted-out"):
        assert db.one("transactions", id=id)["transfer_group_id"] is None


def test_window_boundary_five_days_links():
    db = db_with(
        txn("out", "a-check", 75.0, days_ago=7, pfc="TRANSFER_OUT"),
        txn("in", "a-save", -75.0, days_ago=2),
    )
    assert detect_transfers(db, USER)["linked"] == 1


def test_ambiguous_tie_skipped():
    """Two equally-good candidates (same date delta, same rank) → don't guess."""
    db = db_with(
        txn("out", "a-check", 500.0, days_ago=3, pfc="TRANSFER_OUT",
            plaid_category_detail="TRANSFER_OUT_SAVINGS"),
        txn("in1", "a-save", -500.0, days_ago=3),
        txn("in2", "a-card2", -500.0, days_ago=3),
    )
    stats = detect_transfers(db, USER)
    assert stats["linked"] == 0
    # the lone self-move leg still gets excluded as one-sided
    assert stats["one_sided"] == 1
    assert db.one("transactions", id="out")["transfer_kind"] == "one_sided"


def test_credit_card_payment_tiebreak():
    """LOAN_PAYMENTS outflow with a credit-account and a depository candidate on
    the same date: the card leg wins instead of counting as ambiguous."""
    db = db_with(
        txn("payment", "a-check", 800.0, days_ago=3, pfc="LOAN_PAYMENTS"),
        txn("card-credit", "a-card", -800.0, days_ago=3),
        txn("savings-dep", "a-save", -800.0, days_ago=3),
    )
    assert detect_transfers(db, USER)["linked"] == 1
    payment = db.one("transactions", id="payment")
    card = db.one("transactions", id="card-credit")
    assert card["transfer_group_id"] == payment["transfer_group_id"]
    assert db.one("transactions", id="savings-dep")["transfer_group_id"] is None


def test_one_sided_marked_then_upgraded_in_place():
    """A lone PFC leg is excluded immediately; when its counterpart syncs later,
    the pair reuses the same group id (no flicker for anything referencing it)."""
    db = db_with(txn("out", "a-check", 200.0, days_ago=4, pfc="TRANSFER_OUT",
                     plaid_category_detail="TRANSFER_OUT_INVESTMENT_AND_RETIREMENT_FUNDS"))
    assert detect_transfers(db, USER) == {"linked": 0, "one_sided": 1}
    out = db.one("transactions", id="out")
    group = out["transfer_group_id"]
    assert group is not None and out["transfer_kind"] == "one_sided"
    assert out["exclude_from_totals"]

    db.tables["transactions"].append(txn("in", "a-save", -200.0, days_ago=3))
    db._derive("transactions", db.tables["transactions"][-1])
    assert detect_transfers(db, USER) == {"linked": 1, "one_sided": 0}
    out, inn = db.one("transactions", id="out"), db.one("transactions", id="in")
    assert out["transfer_group_id"] == inn["transfer_group_id"] == group
    assert out["transfer_kind"] == inn["transfer_kind"] == "auto"


def test_one_sided_requires_self_move_detail():
    """Plaid tags Zelle/Venmo-to-people, ATM cash, and cash-advance apps as
    TRANSFER_*/LOAN_PAYMENTS too; without a counterpart leg those are real
    spend/income, so only the self-move detailed categories mark one-sided.
    Null detail (pre-plaid_detail rows) never marks either."""
    db = db_with(
        txn("zelle", "a-check", 150.0, pfc="TRANSFER_OUT",
            plaid_category_detail="TRANSFER_OUT_ACCOUNT_TRANSFER"),
        txn("atm", "a-check", 103.0, pfc="TRANSFER_OUT",
            plaid_category_detail="TRANSFER_OUT_WITHDRAWAL"),
        txn("empower", "a-card", 24.5, pfc="LOAN_PAYMENTS",
            plaid_category_detail="LOAN_PAYMENTS_OTHER_PAYMENT"),
        txn("legacy", "a-check", 42.0, pfc="TRANSFER_OUT"),  # null detail
        txn("wealthfront", "a-check", 1000.0, pfc="TRANSFER_OUT",
            plaid_category_detail="TRANSFER_OUT_INVESTMENT_AND_RETIREMENT_FUNDS"),
        txn("card-pmt", "a-check", 800.0, pfc="LOAN_PAYMENTS",
            plaid_category_detail="LOAN_PAYMENTS_CREDIT_CARD_PAYMENT"),
    )
    assert detect_transfers(db, USER) == {"linked": 0, "one_sided": 2}
    for id in ("zelle", "atm", "empower", "legacy"):
        assert db.one("transactions", id=id)["transfer_group_id"] is None, id
    for id in ("wealthfront", "card-pmt"):
        assert db.one("transactions", id=id)["transfer_kind"] == "one_sided", id


def test_cash_category_bucket_move_marked_one_sided():
    """Wealthfront Cash bucket moves are internal to one account, tagged with the
    CASH_CATEGORY marker in the name (not a self-move PFC detail — theirs is the
    generic TRANSFER_OUT_WITHDRAWAL). Mark them one-sided; a coincidental
    equal-amount leg in another account must NOT pull them into an auto pair."""
    db = db_with(
        txn("bucket", "a-check", 6000.0, pfc="TRANSFER_OUT",
            plaid_category_detail="TRANSFER_OUT_WITHDRAWAL",
            description="Emergency fund Withdrawal CASH_CATEGORY"),
        # Same amount, different account, with a transfer signal — would pair a
        # normal withdrawal, but the bucket leg is out of candidacy.
        txn("coincidence", "a-save", -6000.0, days_ago=1, pfc="TRANSFER_IN"),
    )
    assert detect_transfers(db, USER) == {"linked": 0, "one_sided": 1}
    bucket = db.one("transactions", id="bucket")
    assert bucket["transfer_kind"] == "one_sided" and bucket["exclude_from_totals"]
    assert db.one("transactions", id="coincidence")["transfer_group_id"] is None


def test_plain_withdrawal_without_marker_stays_counted():
    """A real ATM/external withdrawal shares TRANSFER_OUT_WITHDRAWAL but lacks the
    CASH_CATEGORY marker — it must stay spend (regression guard on the marker)."""
    db = db_with(
        txn("atm", "a-check", 103.0, pfc="TRANSFER_OUT",
            plaid_category_detail="TRANSFER_OUT_WITHDRAWAL",
            description="ATM Withdrawal"),
    )
    assert detect_transfers(db, USER) == {"linked": 0, "one_sided": 0}
    assert db.one("transactions", id="atm")["transfer_group_id"] is None


def test_one_sided_past_lookback_still_upgrades():
    """A one-sided leg just past the incremental cutoff must still pair when its
    counterpart syncs late — the one-sided fetch deliberately ignores the lookback."""
    db = db_with(
        txn("old", "a-check", 200.0, days_ago=31, pfc="TRANSFER_OUT",
            transfer_group_id="g-one", transfer_kind="one_sided",
            exclude_from_totals=True),
        txn("new", "a-save", -200.0, days_ago=29),
    )
    assert detect_transfers(db, USER)["linked"] == 1
    new = db.one("transactions", id="new")
    assert new["transfer_group_id"] == "g-one" and new["transfer_kind"] == "auto"


def test_fetch_paged_loops_past_the_response_cap(monkeypatch):
    """_fetch_matchable must page past PostgREST's 1000-row response
    cap — a truncated fetch silently drops matchable legs (a user with 2667
    unlinked rows had the tail invisible, so a full backfill left old transfers
    undetected). Patch the page size small and assert every row is fetched
    across multiple pages, not just the first page."""
    monkeypatch.setattr(transfers, "_PAGE", 2)
    db = db_with(*[txn(f"r{i}", "a-check", 1.0 + i) for i in range(5)])
    calls = {"n": 0}

    def factory():
        calls["n"] += 1
        return db.table("transactions").select("id").eq("user_id", USER)

    rows = transfers._fetch_paged(factory)
    assert len(rows) == 5, "paging must return every row, not just the first page"
    assert calls["n"] == 3, "pages of 2, 2, 1 → three fetches (last is short → stop)"


def test_full_scan_marks_self_moves_beyond_the_first_page(monkeypatch):
    """End-to-end guard on the cap fix: with a tiny page size, a full=True scan
    still one-sided-marks every lone self-move leg, including ones that fall on
    a later page."""
    monkeypatch.setattr(transfers, "_PAGE", 2)
    db = db_with(*[
        txn(f"s{i}", "a-check", 10.0 + i, days_ago=40, pfc="TRANSFER_OUT",
            plaid_category_detail="TRANSFER_OUT_SAVINGS")
        for i in range(5)
    ])
    assert detect_transfers(db, USER, full=True)["one_sided"] == 5


def test_idempotent_rerun_is_noop():
    db = db_with(
        txn("out", "a-check", 500.0, pfc="TRANSFER_OUT"),
        txn("in", "a-save", -500.0, pfc="TRANSFER_IN"),
        txn("lone", "a-check", 60.0, pfc="TRANSFER_OUT",
            plaid_category_detail="TRANSFER_OUT_SAVINGS"),
    )
    first = detect_transfers(db, USER)
    assert first == {"linked": 1, "one_sided": 1}
    snapshot = [dict(r) for r in db.rows("transactions")]
    assert detect_transfers(db, USER) == {"linked": 0, "one_sided": 0}
    assert db.rows("transactions") == snapshot


def test_lookback_vs_full():
    old = 60
    db = db_with(
        txn("out-old", "a-check", 900.0, days_ago=old, pfc="TRANSFER_OUT"),
        txn("in-old", "a-save", -900.0, days_ago=old - 1, pfc="TRANSFER_IN"),
    )
    assert detect_transfers(db, USER) == {"linked": 0, "one_sided": 0}, \
        "incremental run must not touch history beyond the lookback"
    assert detect_transfers(db, USER, full=True)["linked"] == 1


def test_freshly_ingested_backdated_leg_enters_incremental_matcher():
    """A leg whose transaction date predates the lookback but was just
    ingested (created_at ≈ now) must still be matched on an incremental run.
    Plaid delivers investment cash movements long after their date —
    scoping the matcher by transaction date alone hid them until a full rescan."""
    old = 200
    db = db_with(
        txn("out", "a-check", 300.0, days_ago=old, pfc="TRANSFER_OUT", created_at=d(0)),
        txn("in", "a-save", -300.0, days_ago=old + 1, created_at=d(0)),
    )
    assert detect_transfers(db, USER)["linked"] == 1
    assert db.one("transactions", id="out")["transfer_kind"] == "auto"


def test_backdated_and_old_ingest_stays_out_incrementally():
    """Mirror guard: a row old in BOTH date and ingest time stays out of an
    incremental scan — the created_at window must not reopen all history
    (full=True is the only full rescan)."""
    old = 200
    db = db_with(
        txn("out", "a-check", 300.0, days_ago=old, pfc="TRANSFER_OUT", created_at=d(old)),
        txn("in", "a-save", -300.0, days_ago=old + 1, created_at=d(old + 1)),
    )
    assert detect_transfers(db, USER)["linked"] == 0
    assert detect_transfers(db, USER, full=True)["linked"] == 1


def test_pairs_only_skips_one_sided_marking():
    db = db_with(
        txn("out", "a-check", 500.0, pfc="TRANSFER_OUT"),
        txn("in", "a-save", -500.0, pfc="TRANSFER_IN"),
        txn("lone", "a-check", 60.0, pfc="TRANSFER_OUT",
            plaid_category_detail="TRANSFER_OUT_SAVINGS"),
    )
    assert detect_transfers(db, USER, include_one_sided=False) == \
        {"linked": 1, "one_sided": 0}
    assert db.one("transactions", id="lone")["transfer_group_id"] is None


def test_dry_run_writes_nothing():
    db = db_with(
        txn("out", "a-check", 500.0, pfc="TRANSFER_OUT"),
        txn("in", "a-save", -500.0, pfc="TRANSFER_IN"),
    )
    assert detect_transfers(db, USER, dry_run=True) == {"linked": 1, "one_sided": 0}
    assert db.one("transactions", id="out")["transfer_group_id"] is None


def test_user_optout_never_relinked():
    """The web unlink sets transfer_opt_out on both legs; a later sync must not
    re-link or one-sided-mark them."""
    db = db_with(
        txn("out", "a-check", 500.0, pfc="TRANSFER_OUT", transfer_opt_out=True),
        txn("in", "a-save", -500.0, pfc="TRANSFER_IN", transfer_opt_out=True),
    )
    assert detect_transfers(db, USER) == {"linked": 0, "one_sided": 0}


def test_unlink_groups_respects_hidden_and_skips_optout():
    db = db_with(
        txn("a", "a-check", 500.0, transfer_group_id="g1", transfer_kind="auto",
            exclude_from_totals=True),
        txn("b", "a-save", -500.0, transfer_group_id="g1", transfer_kind="auto",
            exclude_from_totals=True, hidden=True),
    )
    unlink_groups(db, ["g1", None])
    a, b = db.one("transactions", id="a"), db.one("transactions", id="b")
    assert a["transfer_group_id"] is None and a["transfer_kind"] is None
    assert not a["exclude_from_totals"], "visible leg re-enters totals"
    assert b["exclude_from_totals"], "hidden leg stays excluded (hiding is orthogonal)"
    assert not a["transfer_opt_out"], "system unlink must not record user intent"


def test_removed_leg_unlinks_partner_via_sync():
    """Plaid removing one leg (pending → posted replacement) frees the survivor
    to re-pair with the replacement on the same run."""
    plaid = FakePlaid(accounts=[], pages=[{
        "added": [], "modified": [],
        "removed": [{"transaction_id": "p-gone"}],
        "next_cursor": "cur-1", "has_more": False,
    }])
    db = FakeSupabase(tables={
        "plaid_items": [{"id": "item-1", "user_id": USER, "access_token": "tok",
                         "institution_name": "Bank", "cursor": "cur-0",
                         "last_synced_at": None, "is_syncing": False}],
        "accounts": ACCOUNTS,
        "transactions": [
            txn("gone", "a-check", 500.0, transfer_group_id="g1",
                transfer_kind="auto", exclude_from_totals=True),
            txn("survivor", "a-save", -500.0, transfer_group_id="g1",
                transfer_kind="auto", exclude_from_totals=True),
        ],
    })
    db.tables["transactions"][0]["plaid_transaction_id"] = "p-gone"

    item = db.rows("plaid_items")[0]
    sync.sync_item(plaid, db, item, {"memory": {}, "rules": [], "income_id": None},
                   sync._new_stats(), USER, refresh_balances=False)

    assert db.one("transactions", id="gone") is None
    survivor = db.one("transactions", id="survivor")
    assert survivor["transfer_group_id"] is None
    assert not survivor["exclude_from_totals"]


def test_modified_amount_change_breaks_auto_pair_only():
    """An amount edit invalidates an auto pair (net-zero broken) but a manual
    link is the user's assertion and stays."""
    def page(txn_id, amount):
        return {"added": [], "removed": [], "next_cursor": "c", "has_more": False,
                "modified": [{"transaction_id": txn_id, "date": d(2),
                              "amount": amount, "merchant_name": "m", "name": "m",
                              "pending": False}]}

    for kind, expect_linked in (("auto", False), ("manual", True)):
        db = FakeSupabase(tables={
            "plaid_items": [{"id": "item-1", "user_id": USER, "access_token": "tok",
                             "institution_name": "Bank", "cursor": "cur-0",
                             "last_synced_at": None, "is_syncing": False}],
            "accounts": ACCOUNTS,
            "transactions": [
                txn("a", "a-check", 500.0, transfer_group_id="g1",
                    transfer_kind=kind, exclude_from_totals=True),
                txn("b", "a-save", -500.0, transfer_group_id="g1",
                    transfer_kind=kind, exclude_from_totals=True),
            ],
        })
        plaid = FakePlaid(accounts=[], pages=[page("p-a", 510.0)])
        item = db.rows("plaid_items")[0]
        sync.sync_item(plaid, db, item, {"memory": {}, "rules": [], "income_id": None},
                       sync._new_stats(), USER, refresh_balances=False)
        still_linked = db.one("transactions", id="b")["transfer_group_id"] is not None
        assert still_linked == expect_linked, f"kind={kind}"


def test_categorizer_exempts_transfer_legs_from_income():
    ctx = {"memory": {}, "rules": [], "income_id": "cat-income"}
    txns = [
        {"merchant_name": "Robinhood", "amount": -400.0, "plaid_category": "TRANSFER_IN"},
        {"merchant_name": "Employer", "amount": -4200.0, "plaid_category": "INCOME"},
    ]
    apply_learned(txns, ctx)
    assert txns[0].get("category_id") is None, "TRANSFER_IN is moved money, not income"
    assert txns[1]["category_id"] == "cat-income"
