"""Logic tests for the alert evaluation engine + digest cron (Phase B).

Fakes-only tier (no docker/DB): drives the real production functions in
alerts.py / digests.py against tests/fakes.FakeSupabase. Covers the four on-sync
rules (budget_threshold, large_charge, low_balance, sync_failed), lazy-default
vs explicit prefs, dedup suppression, and the digest weekday/day-of-month
cadence gating.

Run:  pytest tests/test_alerts.py      (from finance-backend/sync-service)
"""
import datetime

import alerts
import digests
from tests.fakes import FakeSupabase

USER = "user-1"


def _notifs(db, type_=None):
    rows = db.rows("notifications")
    return [r for r in rows if type_ is None or r["type"] == type_]


# ── budget_threshold ─────────────────────────────────────────────────────────
def test_budget_threshold_fires_at_pct_and_respects_asof_limit():
    """Spend >= pct% of the as-of monthly limit fires once; the newest
    effective_month <= this month wins; a 0 limit (unbudgeted) never fires."""
    today = datetime.date(2026, 7, 15)
    month = today.replace(day=1).isoformat()

    db = FakeSupabase(tables={
        "budget_limits": [
            # cat-food: an old $200 limit superseded by a $400 limit this year.
            {"user_id": USER, "category_id": "cat-food",
             "effective_month": "2026-01-01", "monthly_limit": 200},
            {"user_id": USER, "category_id": "cat-food",
             "effective_month": "2026-06-01", "monthly_limit": 400},
            # cat-fun: explicitly unbudgeted (0) — must never fire.
            {"user_id": USER, "category_id": "cat-fun",
             "effective_month": "2026-01-01", "monthly_limit": 0},
            # cat-gas: $100 limit, spend under 90% → no alert.
            {"user_id": USER, "category_id": "cat-gas",
             "effective_month": "2026-01-01", "monthly_limit": 100},
        ],
        "category_spend": [
            {"user_id": USER, "month": month, "category_id": "cat-food", "spent": 380},   # 95% of 400
            {"user_id": USER, "month": month, "category_id": "cat-fun", "spent": 999},
            {"user_id": USER, "month": month, "category_id": "cat-gas", "spent": 50},      # 50% of 100
        ],
    })

    inserted = alerts.evaluate_user_alerts(db, USER, today=today)

    fired = _notifs(db, "budget_threshold")
    assert len(fired) == 1, fired
    assert fired[0]["payload"]["category_id"] == "cat-food"
    assert fired[0]["dedup_key"] == "budget_threshold:cat-food:2026-07"
    assert fired[0]["user_id"] == USER
    assert len(inserted) == 1


def test_budget_threshold_below_pct_does_not_fire():
    today = datetime.date(2026, 7, 15)
    month = today.replace(day=1).isoformat()
    db = FakeSupabase(tables={
        "budget_limits": [{"user_id": USER, "category_id": "cat-food",
                           "effective_month": "2026-01-01", "monthly_limit": 400}],
        "category_spend": [{"user_id": USER, "month": month,
                            "category_id": "cat-food", "spent": 100}],   # 25%
    })
    alerts.evaluate_user_alerts(db, USER, today=today)
    assert _notifs(db, "budget_threshold") == []


# ── large_charge ─────────────────────────────────────────────────────────────
def test_large_charge_only_fires_on_spend_not_income_transfers_or_pending():
    """A 'charge' is money OUT: positive amount >= threshold and not pending fires.
    Income (negative by sign — paychecks, refunds, incoming transfers), internal
    transfers (transfer_group_id set), excluded rows, and reimbursements do NOT
    fire — that abs()/no-exclusion bug flooded a user's inbox on backfill."""
    today = datetime.date(2026, 7, 7)
    recent = "2026-07-06"
    db = FakeSupabase(tables={
        "transactions": [
            {"id": "t-big", "user_id": USER, "account_id": "a1", "amount": 250.0,
             "pending": False, "merchant_name": "Best Buy", "date": recent},   # spend → fire
            {"id": "t-income", "user_id": USER, "account_id": "a1", "amount": -300.0,
             "pending": False, "merchant_name": "Payroll", "date": recent},    # income (neg) → skip
            {"id": "t-transfer", "user_id": USER, "account_id": "a1", "amount": 900.0,
             "pending": False, "transfer_group_id": "g1", "date": recent},     # transfer → skip
            {"id": "t-excluded", "user_id": USER, "account_id": "a1", "amount": 900.0,
             "pending": False, "exclude_from_totals": True, "date": recent},   # excluded → skip
            {"id": "t-reimb", "user_id": USER, "account_id": "a1", "amount": 900.0,
             "pending": False, "is_reimbursement": True, "date": recent},      # reimbursement → skip
            {"id": "t-small", "user_id": USER, "account_id": "a1", "amount": 20.0,
             "pending": False, "date": recent},                                # sub-threshold → skip
            {"id": "t-pending", "user_id": USER, "account_id": "a1", "amount": 999.0,
             "pending": True, "date": recent},                                 # pending → skip
        ],
    })
    alerts.evaluate_user_alerts(db, USER, today=today)

    fired = {n["payload"]["transaction_id"] for n in _notifs(db, "large_charge")}
    assert fired == {"t-big"}
    dedup = {n["dedup_key"] for n in _notifs(db, "large_charge")}
    assert dedup == {"large_charge:t-big"}


def test_large_charge_ignores_historical_backfill():
    """The recency guard prevents a first-link flood: a big charge dated far in
    the past isn't a 'just posted' charge, even if ingested this run."""
    today = datetime.date(2026, 7, 7)
    db = FakeSupabase(tables={
        "transactions": [
            {"id": "t-old", "user_id": USER, "account_id": "a1", "amount": 900.0,
             "pending": False, "date": "2026-01-15"},                          # weeks old → skip
            {"id": "t-fresh", "user_id": USER, "account_id": "a1", "amount": 900.0,
             "pending": False, "date": "2026-07-05"},                          # within 7d → fire
        ],
    })
    alerts.evaluate_user_alerts(db, USER, today=today)
    assert {n["payload"]["transaction_id"] for n in _notifs(db, "large_charge")} == {"t-fresh"}


def test_large_charge_pref_override_lowers_threshold():
    today = datetime.date(2026, 7, 7)
    db = FakeSupabase(tables={
        "notification_prefs": [{"user_id": USER, "type": "large_charge",
                                "enabled": True, "config": {"amount": 50}}],
        "transactions": [
            {"id": "t-med", "user_id": USER, "account_id": "a1", "amount": 75.0,
             "pending": False, "date": "2026-07-06"},
        ],
    })
    alerts.evaluate_user_alerts(db, USER, today=today)
    assert {n["payload"]["transaction_id"] for n in _notifs(db, "large_charge")} == {"t-med"}


def test_large_charge_disabled_pref_suppresses():
    today = datetime.date(2026, 7, 7)
    db = FakeSupabase(tables={
        "notification_prefs": [{"user_id": USER, "type": "large_charge",
                                "enabled": False, "config": {}}],
        "transactions": [{"id": "t-big", "user_id": USER, "account_id": "a1",
                          "amount": 5000.0, "pending": False, "date": "2026-07-06"}],
    })
    alerts.evaluate_user_alerts(db, USER, today=today)
    assert _notifs(db, "large_charge") == []


def test_large_charge_since_bounds_scan():
    """`since` limits large_charge to rows created at/after the run start."""
    today = datetime.date(2026, 7, 7)
    db = FakeSupabase(tables={
        "transactions": [
            # both recent by date; `since` (created_at) is what separates them.
            {"id": "t-old", "user_id": USER, "account_id": "a1", "amount": 900.0,
             "pending": False, "date": "2026-07-06",
             "created_at": "2026-07-01T00:00:00+00:00"},
            {"id": "t-new", "user_id": USER, "account_id": "a1", "amount": 900.0,
             "pending": False, "date": "2026-07-06",
             "created_at": "2026-07-07T10:00:00+00:00"},
        ],
    })
    alerts.evaluate_user_alerts(db, USER, today=today, since="2026-07-07T09:00:00+00:00")
    assert {n["payload"]["transaction_id"] for n in _notifs(db, "large_charge")} == {"t-new"}


# ── low_balance ──────────────────────────────────────────────────────────────
def test_low_balance_floor_excludes_liabilities_and_inactive():
    """A depository account below the floor fires (once, on the first-ever
    observation with no prior balance); a credit (liability) account and an
    inactive account do not, even below the floor."""
    today = datetime.date(2026, 7, 7)
    db = FakeSupabase(tables={
        "latest_balances": [
            {"user_id": USER, "account_id": "a-check", "current_balance": 40, "date": "2026-07-07"},   # < 100 → fire
            {"user_id": USER, "account_id": "a-card", "current_balance": 10, "date": "2026-07-07"},     # credit → skip
            {"user_id": USER, "account_id": "a-dead", "current_balance": 5, "date": "2026-07-07"},      # inactive → skip
            {"user_id": USER, "account_id": "a-flush", "current_balance": 5000, "date": "2026-07-07"},  # healthy → skip
        ],
        "accounts": [
            {"id": "a-check", "user_id": USER, "type": "depository", "name": "Checking", "is_active": True},
            {"id": "a-card", "user_id": USER, "type": "credit", "name": "Card", "is_active": True},
            {"id": "a-flush", "user_id": USER, "type": "depository", "name": "Savings", "is_active": True},
            # a-dead intentionally absent from active accounts
        ],
    })
    alerts.evaluate_user_alerts(db, USER, today=today)

    fired = _notifs(db, "low_balance")
    assert len(fired) == 1, fired
    assert fired[0]["payload"]["account_id"] == "a-check"
    # crossing-scoped key: no calendar date (that was the daily-repeat bug).
    assert fired[0]["dedup_key"] == "low_balance:a-check"


def _low_balance_db(current, *, prior=None, subtype=None, name="Checking",
                    date="2026-07-07"):
    """A one-account low_balance fixture: `current` today's balance, `prior` an
    optional earlier balance-history row so crossing detection has a previous
    observation to compare against."""
    history = [{"user_id": USER, "account_id": "a1", "current_balance": current,
                "date": date}]
    if prior is not None:
        prev_date, prev_bal = prior
        history.append({"user_id": USER, "account_id": "a1",
                        "current_balance": prev_bal, "date": prev_date})
    acct = {"id": "a1", "user_id": USER, "type": "depository",
            "name": name, "is_active": True}
    if subtype is not None:
        acct["subtype"] = subtype
    return FakeSupabase(tables={
        "latest_balances": [{"user_id": USER, "account_id": "a1",
                             "current_balance": current, "date": date}],
        "accounts": [acct],
        "account_balance_history": history,
    })


def test_low_balance_fires_once_on_fresh_crossing():
    """prev >= floor, now < floor → a genuine drop-through fires exactly once."""
    today = datetime.date(2026, 7, 7)
    db = _low_balance_db(40, prior=("2026-07-06", 500))
    inserted = alerts.evaluate_user_alerts(db, USER, today=today)
    fired = _notifs(db, "low_balance")
    assert len(fired) == 1 and len(inserted) == 1
    assert fired[0]["payload"]["account_id"] == "a1"


def test_low_balance_no_refire_while_still_below():
    """Once below, staying below across further syncs must NOT re-fire (Bug A:
    the old date-scoped key re-fired every day)."""
    today = datetime.date(2026, 7, 8)
    # yesterday it was already below the floor (30), today it's still below (25).
    db = _low_balance_db(25, prior=("2026-07-07", 30), date="2026-07-08")
    alerts.evaluate_user_alerts(db, USER, today=today)
    assert _notifs(db, "low_balance") == []


def test_low_balance_refires_after_recover_then_drop():
    """recover→drop cycle: the account climbs back above the floor (releasing the
    dedup key), then drops through again → a second, distinct alert fires."""
    today = datetime.date(2026, 7, 7)

    # 1) first crossing: 500 → 40 fires and lands a low_balance:a1 row.
    db = _low_balance_db(40, prior=("2026-07-06", 500))
    alerts.evaluate_user_alerts(db, USER, today=today)
    assert len(_notifs(db, "low_balance")) == 1
    assert db.rows("notifications")[0]["dedup_key"] == "low_balance:a1"

    # 2) recovery: balance back to 500. No new alert, and the stale key is freed.
    db.tables["latest_balances"] = [{"user_id": USER, "account_id": "a1",
                                     "current_balance": 500, "date": "2026-07-08"}]
    db.tables["account_balance_history"].append(
        {"user_id": USER, "account_id": "a1", "current_balance": 500, "date": "2026-07-08"})
    alerts.evaluate_user_alerts(db, USER, today=datetime.date(2026, 7, 8))
    assert len(_notifs(db, "low_balance")) == 1, "recovery must not add an alert"
    assert db.rows("notifications")[0]["dedup_key"] is None, "key released on recovery"

    # 3) second crossing: 500 → 40 again → a fresh alert (key slot is free).
    db.tables["latest_balances"] = [{"user_id": USER, "account_id": "a1",
                                     "current_balance": 40, "date": "2026-07-09"}]
    db.tables["account_balance_history"].append(
        {"user_id": USER, "account_id": "a1", "current_balance": 40, "date": "2026-07-09"})
    alerts.evaluate_user_alerts(db, USER, today=datetime.date(2026, 7, 9))
    fired = _notifs(db, "low_balance")
    assert len(fired) == 2, "recover→drop must alert again"
    assert any(n["dedup_key"] == "low_balance:a1" for n in fired)


def test_low_balance_excludes_zero_and_prepaid():
    """A $0 pass-through account (Bug B: the BillPay account) and a prepaid
    depository account are never actionable low-cash → no alert, even with a
    prior healthy balance that would otherwise look like a crossing."""
    today = datetime.date(2026, 7, 7)

    zero_db = _low_balance_db(0, prior=("2026-07-06", 500))
    alerts.evaluate_user_alerts(zero_db, USER, today=today)
    assert _notifs(zero_db, "low_balance") == [], "$0 account must not fire"

    prepaid_db = _low_balance_db(40, prior=("2026-07-06", 500), subtype="prepaid")
    alerts.evaluate_user_alerts(prepaid_db, USER, today=today)
    assert _notifs(prepaid_db, "low_balance") == [], "prepaid account must not fire"


# ── sync_failed ──────────────────────────────────────────────────────────────
def _sync_bucket(day: datetime.date) -> int:
    return day.toordinal() // alerts.SYNC_FAILED_COOLDOWN_DAYS


def test_sync_failed_emits_per_errored_item():
    today = datetime.date(2026, 7, 7)
    db = FakeSupabase(tables={})
    alerts.evaluate_user_alerts(db, USER, today=today, item_errors=[
        {"item_id": "item-1", "plaid_item_id": "plaid-1", "institution_name": "Chase"},
        {"item_id": "item-2", "plaid_item_id": "plaid-2", "institution_name": None},
    ])
    fired = _notifs(db, "sync_failed")
    assert {n["payload"]["item_id"] for n in fired} == {"item-1", "item-2"}
    bucket = _sync_bucket(today)
    assert {n["dedup_key"] for n in fired} == {
        f"sync_failed:item-1:{bucket}", f"sync_failed:item-2:{bucket}"}


def test_sync_failed_cooldown_no_daily_repeat_then_refires():
    """A persistently-failing item alerts once per cooldown window, not daily
    (Bug A's sibling), then reminds again after the window lapses."""
    item = [{"item_id": "item-1", "plaid_item_id": "p1", "institution_name": "Chase"}]

    # Day 1: fires. Day 2 (same cooldown window): suppressed — no daily nag.
    day1 = datetime.date(2026, 7, 7)
    db = FakeSupabase(tables={})
    alerts.evaluate_user_alerts(db, USER, today=day1, item_errors=item)
    alerts.evaluate_user_alerts(db, USER, today=day1 + datetime.timedelta(days=1),
                                item_errors=item)
    assert len(_notifs(db, "sync_failed")) == 1, "no re-fire within the cooldown window"

    # A day in a later cooldown window reminds once more.
    later = day1 + datetime.timedelta(days=alerts.SYNC_FAILED_COOLDOWN_DAYS)
    assert _sync_bucket(later) != _sync_bucket(day1)
    alerts.evaluate_user_alerts(db, USER, today=later, item_errors=item)
    assert len(_notifs(db, "sync_failed")) == 2, "re-fires after the cooldown lapses"


# ── dedup ────────────────────────────────────────────────────────────────────
def test_dedup_suppresses_repeat_across_runs_and_within_batch():
    """The same dedup_key never inserts twice: not across two evaluations, and
    not when the same candidate is produced twice within one batch."""
    today = datetime.date(2026, 7, 7)
    db = FakeSupabase(tables={
        "transactions": [{"id": "t-big", "user_id": USER, "account_id": "a1",
                          "amount": 900.0, "pending": False, "date": "2026-07-06"}],
    })
    first = alerts.evaluate_user_alerts(db, USER, today=today)
    assert len(first) == 1
    second = alerts.evaluate_user_alerts(db, USER, today=today)   # same key again
    assert second == []
    assert len(_notifs(db, "large_charge")) == 1, "one row, not two"

    # within-batch duplicate: two identical candidates → a single insert.
    db2 = FakeSupabase(tables={})
    dupes = [
        {"type": "large_charge", "title": "x", "body": "y", "payload": {},
         "dedup_key": "large_charge:same"},
        {"type": "large_charge", "title": "x", "body": "y", "payload": {},
         "dedup_key": "large_charge:same"},
    ]
    out = alerts._insert_new(db2, USER, dupes)
    assert len(out) == 1
    assert len(db2.rows("notifications")) == 1


# ── digests: cadence gating ──────────────────────────────────────────────────
def _txn(id_, user, date, amount, **kw):
    return {"id": id_, "user_id": user, "account_id": "a1", "date": date,
            "amount": amount, "pending": kw.get("pending", False),
            "exclude_from_totals": kw.get("exclude", False)}


def test_daily_spend_only_on_plain_day():
    """A plain weekday that isn't the 1st emits only daily_spend (yesterday's
    total spend), never a periodic digest. Pending/excluded rows don't count."""
    today = datetime.date(2026, 7, 7)          # Tuesday, not the 1st
    yesterday = "2026-07-06"
    db = FakeSupabase(tables={
        "transactions": [
            _txn("t1", USER, yesterday, 30.0),
            _txn("t2", USER, yesterday, 20.0),
            _txn("t3", USER, yesterday, 500.0, pending=True),    # pending → skip
            _txn("t4", USER, yesterday, 500.0, exclude=True),    # excluded → skip
            _txn("t5", USER, yesterday, -100.0),                 # income (<=0) → skip
        ],
    })
    digests.run_digests(db, today=today)

    daily = _notifs(db, "daily_spend")
    assert len(daily) == 1
    assert daily[0]["payload"]["total"] == 50.0
    assert daily[0]["dedup_key"] == f"daily_spend:{USER}:2026-07-06"
    assert _notifs(db, "periodic_digest") == []


def test_weekly_digest_on_monday():
    today = datetime.date(2026, 7, 6)          # Monday
    db = FakeSupabase(tables={
        "transactions": [
            _txn("t1", USER, "2026-07-05", 40.0),   # yesterday → daily + in weekly window
            _txn("t2", USER, "2026-06-30", 60.0),   # in trailing-7 window [06-29, 07-05]
            _txn("t3", USER, "2026-06-20", 100.0),  # older than window → excluded
        ],
    })
    digests.run_digests(db, today=today)

    weekly = _notifs(db, "periodic_digest")
    assert len(weekly) == 1
    assert weekly[0]["payload"]["cadence"] == "weekly"
    assert weekly[0]["payload"]["total"] == 100.0   # 40 + 60, not the 06-20 row
    assert weekly[0]["dedup_key"].startswith(f"periodic_digest:{USER}:weekly:")
    # daily still fires for yesterday (07-05)
    assert len(_notifs(db, "daily_spend")) == 1


def test_monthly_digest_on_first():
    today = datetime.date(2026, 7, 1)          # the 1st → previous calendar month
    db = FakeSupabase(tables={
        "transactions": [
            _txn("t1", USER, "2026-06-15", 200.0),  # in June → counts
            _txn("t2", USER, "2026-06-30", 50.0),   # last day of June → counts
            _txn("t3", USER, "2026-05-31", 999.0),  # May → excluded
        ],
    })
    digests.run_digests(db, today=today)

    monthly = _notifs(db, "periodic_digest")
    assert len(monthly) == 1
    assert monthly[0]["payload"]["cadence"] == "monthly"
    assert monthly[0]["payload"]["total"] == 250.0
    assert monthly[0]["dedup_key"] == f"periodic_digest:{USER}:monthly:2026-06"


def test_digest_respects_disabled_pref():
    today = datetime.date(2026, 7, 7)
    db = FakeSupabase(tables={
        "notification_prefs": [{"user_id": USER, "type": "daily_spend",
                                "enabled": False, "config": {}}],
        "transactions": [_txn("t1", USER, "2026-07-06", 50.0)],
    })
    digests.run_digests(db, today=today)
    assert _notifs(db, "daily_spend") == []


# ── digests: only the morning run of the twice-daily cron emits ──────────────
def test_is_digest_run_morning_vs_afternoon():
    """The cron fires 09:00 and 21:00 UTC. Only the first is a digest run, in
    both DST halves of the year (09:00 UTC = 5am EDT / 4am EST)."""
    utc = datetime.timezone.utc

    def at(month, day, hour):
        return datetime.datetime(2026, month, day, hour, 0, tzinfo=utc)

    assert digests.is_digest_run(at(7, 7, 9)) is True      # 05:00 EDT
    assert digests.is_digest_run(at(1, 7, 9)) is True      # 04:00 EST
    assert digests.is_digest_run(at(7, 7, 21)) is False    # 17:00 EDT
    assert digests.is_digest_run(at(1, 7, 21)) is False    # 16:00 EST
    # A late start still counts as the morning run; the evening one never does.
    assert digests.is_digest_run(at(7, 7, 15)) is True     # 11:00 EDT
    assert digests.is_digest_run(at(7, 7, 16)) is False    # 12:00 EDT
