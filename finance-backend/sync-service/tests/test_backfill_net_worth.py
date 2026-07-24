"""Net-worth history backfill: reconstructing past daily net worth from the
transaction ledger, mirroring write_net_worth_snapshot's asset/liability math.

Same tier as test_logic.py — FakeSupabase only, no network, no live database.
"""
import datetime

import backfill_net_worth as bf
import sync
from tests.fakes import FakeSupabase

USER = "00000000-0000-0000-0000-000000000001"
TODAY = datetime.date(2026, 7, 3)


def _seed():
    """A user whose current net worth is known, with a few dated transactions so
    the reconstructed past differs from today in a checkable way.

    Plaid amount convention: positive = money out of the account.
      • a-check (depository, asset), now $1000:
          07-01  −500 (deposit in)   07-02  +100 (spent)
          → end-of-day: 06-30 $600 · 07-01 $1100 · 07-02 $1000 · 07-03 $1000
      • a-card (credit, liability), now owes $500:
          07-02  +300 (purchase)     → 07-01 $200 · 07-02 $500 · 07-03 $500
      • a-brk (investment, asset), now $8000: NOT reconstructable → flat $8000.
      • s-invest (manual asset): 01-01 +500 (opening) · 06-30 +4000 · 07-02 +1000
          → 06-29 $500 · 06-30 $4500 · 07-02 $5500 · 07-03 $5500
    """
    return FakeSupabase(tables={
        "latest_balances": [
            {"user_id": USER, "account_id": "a-check", "current_balance": 1000},
            {"user_id": USER, "account_id": "a-card", "current_balance": 500},
            {"user_id": USER, "account_id": "a-brk", "current_balance": 8000},
        ],
        "accounts": [
            {"id": "a-check", "user_id": USER, "name": "Checking", "type": "depository", "is_active": True},
            {"id": "a-card", "user_id": USER, "name": "Card", "type": "credit", "is_active": True},
            {"id": "a-brk", "user_id": USER, "name": "Brokerage", "type": "investment", "is_active": True},
        ],
        "transactions": [
            {"account_id": "a-check", "date": "2026-07-01", "amount": -500, "pending": False},
            {"account_id": "a-check", "date": "2026-07-02", "amount": 100, "pending": False},
            {"account_id": "a-card", "date": "2026-07-02", "amount": 300, "pending": False},
            # A pending row must not move the reconstruction (excluded, like current_balance).
            {"account_id": "a-check", "date": "2026-07-02", "amount": 9999, "pending": True},
            # Investment txns are ignored (account held flat).
            {"account_id": "a-brk", "date": "2026-07-02", "amount": 400, "pending": False},
        ],
        "separate_accounts": [
            {"id": "s-invest", "user_id": USER, "type": "investment", "is_active": True},
        ],
        "separate_account_values": [
            {"separate_account_id": "s-invest", "date": "2026-01-01", "amount": 500},
            {"separate_account_id": "s-invest", "date": "2026-06-30", "amount": 4000},
            {"separate_account_id": "s-invest", "date": "2026-07-02", "amount": 1000},
        ],
        "net_worth_snapshots": [],
    })


def _by_date(snapshots):
    return {s["date"]: s for s in snapshots}


def test_reconstructs_daily_net_worth_from_ledger():
    snaps, flagged = bf.reconstruct_history(_seed(), USER, days=4, today=TODAY)
    day = _by_date(snaps)

    # One row per day, oldest-first, inclusive of both ends.
    assert [s["date"] for s in snaps] == [
        "2026-06-29", "2026-06-30", "2026-07-01", "2026-07-02", "2026-07-03"]

    # assets = check + brokerage(flat 8000) + s-invest ; liabilities = card
    assert day["2026-06-29"]["total_assets"] == 600 + 8000 + 500        # 9100
    assert day["2026-06-29"]["total_liabilities"] == 200
    assert day["2026-06-30"]["total_assets"] == 600 + 8000 + 4500       # 13100
    assert day["2026-07-01"]["total_assets"] == 1100 + 8000 + 4500      # 13600
    assert day["2026-07-01"]["total_liabilities"] == 200
    assert day["2026-07-02"]["total_assets"] == 1000 + 8000 + 5500      # 14500
    assert day["2026-07-02"]["total_liabilities"] == 500
    assert day["2026-07-03"]["total_assets"] == 1000 + 8000 + 5500      # 14500
    assert day["2026-07-03"]["total_liabilities"] == 500

    # The market-priced account is surfaced as approximate, not silently flat.
    assert flagged == [("Brokerage", "investment")]


def test_reconstructed_today_matches_the_live_snapshot_writer():
    """Reconstruction and write_net_worth_snapshot must agree on 'today' — the
    same asset/liability aggregation, so the curve joins the live series cleanly."""
    reconstructed = _by_date(
        bf.reconstruct_history(_seed(), USER, days=4, today=TODAY)[0])["2026-07-03"]

    db = _seed()
    sync.write_net_worth_snapshot(db, USER)
    live = db.one("net_worth_snapshots", user_id=USER)

    assert reconstructed["total_assets"] == live["total_assets"]
    assert reconstructed["total_liabilities"] == live["total_liabilities"]


def test_backfill_fills_gaps_without_overwriting_existing_history():
    db = _seed()
    # A real snapshot already recorded on 07-01 must survive untouched.
    db.table("net_worth_snapshots").insert(
        {"user_id": USER, "date": "2026-07-01", "total_assets": 42, "total_liabilities": 0}
    ).execute()

    res = bf.backfill_user(db, USER, days=4, today=TODAY, dry_run=False)

    rows = {r["date"]: r for r in db.tables["net_worth_snapshots"]}
    assert len(rows) == 5                       # 4 filled + 1 pre-existing
    assert res["filled"] == 4
    assert rows["2026-07-01"]["total_assets"] == 42   # untouched, not reconstructed


def test_dry_run_writes_nothing():
    db = _seed()
    res = bf.backfill_user(db, USER, days=4, today=TODAY, dry_run=True)
    assert res["filled"] == 5
    assert db.tables["net_worth_snapshots"] == []


def test_skips_reconstruction_once_history_spans_the_window():
    # The window's oldest day (today - days) is already present → we've backfilled
    # before, so a repeat call must short-circuit without rebuilding all 730 days.
    db = _seed()
    start = (TODAY - datetime.timedelta(days=4)).isoformat()   # 2026-06-29
    db.table("net_worth_snapshots").insert(
        {"user_id": USER, "date": start, "total_assets": 1, "total_liabilities": 0}
    ).execute()

    calls_before = len(db.calls)
    res = bf.backfill_user(db, USER, days=4, today=TODAY, dry_run=False)

    assert res["skipped"] is True
    assert res["filled"] == 0
    # Only the one cheap guard query ran — no per-account transaction reconstruction.
    assert len(db.calls) - calls_before == 1
    assert len(db.tables["net_worth_snapshots"]) == 1   # nothing added


# ── Auto-hook: a full sync backfills history; an incremental one does not ──────

def _finalize(monkeypatch, db, full, backfill=False):
    """Run sync._finalize_user with the transfer/recurring steps stubbed, so the
    test isolates the net-worth backfill hook."""
    monkeypatch.setattr(sync, "detect_transfers", lambda *a, **k: {"linked": 0, "one_sided": 0})
    monkeypatch.setattr(sync, "materialize_recurring_contributions", lambda *a, **k: None)
    sync._finalize_user(db, USER, full=full, backfill=backfill)


def test_full_sync_finalize_backfills_history(monkeypatch):
    # Simulates an initial link / historical update: history should fill in, not
    # just today's point. (Uses the real today, so assert range-independently.)
    db = _seed()
    _finalize(monkeypatch, db, full=True)
    dates = {r["date"] for r in db.tables["net_worth_snapshots"]}
    assert len(dates) > 1
    assert datetime.date.today().isoformat() in dates


def test_app_refresh_finalize_backfills_history(monkeypatch):
    # Pull-to-refresh / the Balances refresh button on an already-linked user is
    # an incremental sync (full=False), but must still fill history.
    db = _seed()
    _finalize(monkeypatch, db, full=False, backfill=True)
    dates = {r["date"] for r in db.tables["net_worth_snapshots"]}
    assert len(dates) > 1


def test_cron_incremental_finalize_writes_only_today(monkeypatch):
    # The routine cron sweep (neither full nor app-triggered) must not backfill —
    # just the daily forward point.
    db = _seed()
    _finalize(monkeypatch, db, full=False, backfill=False)
    dates = {r["date"] for r in db.tables["net_worth_snapshots"]}
    assert dates == {datetime.date.today().isoformat()}


def test_backfill_failure_does_not_break_finalize(monkeypatch):
    # The essential daily snapshot writes before the backfill; a backfill blow-up
    # must be swallowed (logged), not propagated — so the sync and other users
    # in a cron sweep survive.
    monkeypatch.setattr(sync, "detect_transfers", lambda *a, **k: {"linked": 0, "one_sided": 0})
    monkeypatch.setattr(sync, "materialize_recurring_contributions", lambda *a, **k: None)
    import backfill_net_worth
    monkeypatch.setattr(backfill_net_worth, "backfill_user",
                        lambda *a, **k: (_ for _ in ()).throw(RuntimeError("boom")))

    db = _seed()
    sync._finalize_user(db, USER, full=True)   # must not raise

    # Today's forward snapshot still landed despite the backfill failure.
    assert any(r["date"] == datetime.date.today().isoformat()
               for r in db.tables["net_worth_snapshots"])
