"""Logic / calculation-correctness tests for the sync-service backend.

Scope: the *Python* in sync.py and categorizer.py — the transform, aggregation,
precedence and date math where the bugs actually live. Each test drives a real
production function against an in-memory Supabase/Plaid (tests/fakes.py) that just
feeds inputs and captures outputs. No network, no credentials, no live DB.

This deliberately does NOT test anything Postgres enforces — RLS isolation,
generated columns, triggers, the latest_balances view, constraints. Those are
covered by tests/test_integration.py against a real local Supabase.

Features covered:
  1. Transaction sync   — Plaid→row mapping, account map, cursor loop, stats
  2. Categorization     — learned memory > keyword (by specificity) > income-by-sign
  3. Net worth math     — assets vs liabilities, negative clamp, inactive + manual accts
  4. Recurring flows    — one delta per elapsed period, then last_applied_date advances

Run:  pytest tests/test_logic.py      (from finance-backend/sync-service)
"""
import datetime

import sync
from categorizer import _merchant_key, apply_learned
from tests.fakes import FakePlaid, FakeSupabase

USER = "user-1"


# ── 1. Transaction sync ─────────────────────────────────────────────────────
def test_transaction_sync_logic():
    """A two-page cursor sync: adds are mapped to the right account and stamped +
    auto-categorized, an edit updates fields but preserves the user's category, a
    removal deletes the row, and the cursor + stats end up correct."""
    plaid = FakePlaid(
        accounts=[
            {"account_id": "pa-check", "name": "Checking", "type": "depository",
             "subtype": "checking", "balances": {"current": 500, "available": 480}},
            {"account_id": "pa-card", "name": "Card", "type": "credit",
             "subtype": "credit card", "balances": {"current": 120, "available": None}},
        ],
        pages=[
            {  # page 1
                "added": [
                    {"transaction_id": "t-groc", "account_id": "pa-check",
                     "date": "2026-06-10", "authorized_date": "2026-06-09",
                     "amount": 42.50, "merchant_name": "Whole Foods", "name": "WHOLEFDS",
                     "pending": False,
                     "personal_finance_category": {"primary": "FOOD", "detailed": "FOOD_GROCERIES"}},
                    {"transaction_id": "t-pay", "account_id": "pa-check",
                     "date": "2026-06-15", "authorized_date": None,
                     "amount": -3000.0, "merchant_name": "Acme Payroll", "name": "ACME",
                     "pending": False, "personal_finance_category": {"primary": "INCOME", "detailed": "INCOME_WAGES"}},
                ],
                "modified": [], "removed": [], "next_cursor": "cur-1", "has_more": True,
            },
            {  # page 2
                "added": [
                    {"transaction_id": "t-card", "account_id": "pa-card",
                     "date": "2026-06-20", "authorized_date": "2026-06-20",
                     "amount": 9.99, "merchant_name": "Spotify", "name": "SPOTIFY",
                     "pending": True, "personal_finance_category": {"primary": "ENTERTAINMENT", "detailed": "ENT_MUSIC"}},
                ],
                "modified": [
                    {"transaction_id": "t-existing", "account_id": "pa-check",
                     "date": "2026-06-05", "amount": 55.00, "merchant_name": "Costco",
                     "name": "COSTCO", "pending": False},
                ],
                "removed": [{"transaction_id": "t-gone"}],
                "next_cursor": "cur-2", "has_more": False,
            },
        ],
    )

    db = FakeSupabase(tables={
        "plaid_items": [{"id": "item-1", "user_id": USER, "access_token": "tok",
                         "institution_name": "Bank", "cursor": None, "last_synced_at": None,
                         "is_syncing": False}],
        "transactions": [
            # pre-existing rows the sync will modify / remove
            {"id": "x-mod", "plaid_transaction_id": "t-existing", "user_id": USER,
             "account_id": "acct-check", "amount": 40.00, "merchant_name": "Costco",
             "category_id": "cat-user", "pending": True},   # user hand-set category
            {"id": "x-del", "plaid_transaction_id": "t-gone", "user_id": USER,
             "account_id": "acct-check", "amount": 5.0},
        ],
    })

    ctx = {
        "memory": {"whole foods": "cat-groceries"},   # user previously taught this merchant
        "rules": [],
        "income_id": "cat-income",
    }
    stats = sync._new_stats()

    item = db.rows("plaid_items")[0]
    sync.sync_item(plaid, db, item, ctx, stats, USER, refresh_balances=True)

    # account map resolved from Plaid → generated uuids (no per-txn lookup)
    check_id = db.one("accounts", plaid_account_id="pa-check")["id"]
    card_id = db.one("accounts", plaid_account_id="pa-card")["id"]
    assert plaid.accounts_get_count == 1, "accounts_get must run once, not per-txn"

    groc = db.one("transactions", plaid_transaction_id="t-groc")
    pay = db.one("transactions", plaid_transaction_id="t-pay")
    card = db.one("transactions", plaid_transaction_id="t-card")

    # added rows: correct account, owner, fields mapped from Plaid
    assert groc["account_id"] == check_id and card["account_id"] == card_id
    assert all(t["user_id"] == USER for t in (groc, pay, card))
    assert groc["amount"] == 42.50 and groc["date"] == "2026-06-10"
    assert groc["authorized_date"] == "2026-06-09"
    assert pay["authorized_date"] is None
    assert groc["plaid_category"] == "FOOD" and groc["plaid_category_detail"] == "FOOD_GROCERIES"
    assert card["pending"] is True

    # auto-categorization at sync time
    assert groc["category_id"] == "cat-groceries", "learned merchant memory should apply"
    assert pay["category_id"] == "cat-income", "negative amount → Income"
    assert card["category_id"] is None, "no memory/rule/income → left for in-app review"

    # modified: fields updated, user's category preserved
    mod = db.one("transactions", plaid_transaction_id="t-existing")
    assert mod["amount"] == 55.00 and mod["merchant_name"] == "Costco"
    assert mod["pending"] is False
    assert mod["category_id"] == "cat-user", "modify must NOT clobber user category"

    # removed: gone
    assert db.one("transactions", plaid_transaction_id="t-gone") is None

    # cursor advanced to the last page, balances written
    assert db.one("plaid_items", id="item-1")["cursor"] == "cur-2"
    assert len(db.rows("account_balance_history")) == 2

    assert stats == {"transactions_added": 3, "transactions_modified": 1,
                     "transactions_removed": 1, "accounts_updated": 2}

    # no N+1: account_id came from the in-memory map, never a per-txn SELECT,
    # and each page's adds went out as a single batch upsert.
    per_txn_lookup = [c for c in db.calls if c[0] == "accounts" and c[1] == "select"
                      and any(f[1] == "plaid_account_id" for f in c[2])]
    assert not per_txn_lookup, "added txns must not trigger per-transaction account SELECTs"
    txn_upserts = [c for c in db.calls if c[0] == "transactions" and c[1] == "upsert"]
    assert len(txn_upserts) == 2, "one batch upsert per page-with-adds, not per row"


def test_merchant_location_and_currency_sync():
    """Plaid `location` + `iso_currency_code` are Plaid-owned columns: they map
    through on the added path and get overwritten on the modified path, while a
    txn with neither leaves every location/currency column NULL."""
    plaid = FakePlaid(
        accounts=[
            {"account_id": "pa-check", "name": "Checking", "type": "depository",
             "subtype": "checking", "balances": {"current": 500, "available": 480}},
        ],
        pages=[
            {
                "added": [
                    # Foreign purchase with full location + non-USD currency.
                    {"transaction_id": "t-paris", "account_id": "pa-check",
                     "date": "2026-06-10", "authorized_date": "2026-06-09",
                     "amount": 42.50, "merchant_name": "Le Bistro", "name": "LE BISTRO",
                     "pending": False, "iso_currency_code": "EUR",
                     "location": {"city": "Paris", "region": "IDF", "country": "FR",
                                  "postal_code": "75001", "store_number": "12",
                                  "lat": 48.8566, "lon": 2.3522}},
                    # Domestic online txn: no location, USD.
                    {"transaction_id": "t-online", "account_id": "pa-check",
                     "date": "2026-06-11", "authorized_date": None,
                     "amount": 9.99, "merchant_name": "Cloud Co", "name": "CLOUD",
                     "pending": False, "iso_currency_code": "USD"},
                ],
                "modified": [
                    # A row that gains location + currency on a later edit.
                    {"transaction_id": "t-existing", "account_id": "pa-check",
                     "date": "2026-06-05", "amount": 55.00, "merchant_name": "Cafe",
                     "name": "CAFE", "pending": False, "iso_currency_code": "GBP",
                     "location": {"city": "London", "region": "England", "country": "GB"}},
                ],
                "removed": [], "next_cursor": "cur-1", "has_more": False,
            },
        ],
    )
    db = FakeSupabase(tables={
        "plaid_items": [{"id": "item-1", "user_id": USER, "access_token": "tok",
                         "institution_name": "Bank", "cursor": None, "last_synced_at": None,
                         "is_syncing": False}],
        "transactions": [
            {"id": "x-mod", "plaid_transaction_id": "t-existing", "user_id": USER,
             "account_id": "acct-check", "amount": 50.00, "merchant_name": "Cafe"},
        ],
    })
    ctx = {"memory": {}, "rules": [], "income_id": "cat-income"}
    stats = sync._new_stats()

    item = db.rows("plaid_items")[0]
    sync.sync_item(plaid, db, item, ctx, stats, USER, refresh_balances=True)

    # Added: foreign txn carries full location + currency.
    paris = db.one("transactions", plaid_transaction_id="t-paris")
    assert paris["merchant_city"] == "Paris" and paris["merchant_region"] == "IDF"
    assert paris["merchant_country"] == "FR" and paris["merchant_postal_code"] == "75001"
    assert paris["merchant_store_number"] == "12"
    assert paris["merchant_lat"] == 48.8566 and paris["merchant_lon"] == 2.3522
    assert paris["iso_currency_code"] == "EUR"

    # Added: domestic txn has USD but every location column NULL.
    online = db.one("transactions", plaid_transaction_id="t-online")
    assert online["iso_currency_code"] == "USD"
    assert online["merchant_city"] is None and online["merchant_country"] is None
    assert online["merchant_lat"] is None

    # Modified: location + currency are Plaid-owned and get written on update.
    mod = db.one("transactions", plaid_transaction_id="t-existing")
    assert mod["merchant_city"] == "London" and mod["merchant_country"] == "GB"
    assert mod["iso_currency_code"] == "GBP"

    # PLAID_OWNED and the projection stay in lockstep (no field-list drift): the
    # dict plaid_txn_fields returns is exactly the Plaid-owned column set.
    projected = sync.plaid_txn_fields(plaid.pages[0]["added"][0])
    assert set(projected) == set(sync.PLAID_OWNED)


def test_unofficial_currency_code_fallback():
    """iso_currency_code falls back to unofficial_currency_code (crypto / non-ISO)."""
    fields = sync.plaid_txn_fields({
        "transaction_id": "t", "date": "2026-06-01", "amount": 1.0,
        "name": "X", "pending": False,
        "iso_currency_code": None, "unofficial_currency_code": "BTC",
    })
    assert fields["iso_currency_code"] == "BTC"


# ── 2. Categorization ───────────────────────────────────────────────────────
def test_categorization_logic():
    """Precedence on sync: learned memory > keyword rule (longest wins, no priority)
    > income-by-sign; an already-categorized txn is untouched; unknowns stay blank."""
    ctx = {
        "memory": {"amazon": "cat-shopping"},          # user taught Amazon → Shopping
        "rules": [
            {"keyword": "coffee bar", "category_id": "cat-dining"},   # longer, more specific
            {"keyword": "coffee", "category_id": "cat-drinks"},
        ],
        "income_id": "cat-income",
    }
    txns = [
        {"merchant_name": "  Amazon ", "description": "AMZN MKTP", "amount": 20.0},   # memory (normalized)
        {"merchant_name": "Blue Coffee Bar", "description": "", "amount": 5.0},       # longest keyword
        {"merchant_name": "Corner Coffee", "description": "", "amount": 4.0},         # shorter keyword
        {"merchant_name": "Employer", "description": "DIRECT DEP", "amount": -4200.0},# income by sign
        {"merchant_name": "Mystery LLC", "description": "", "amount": 12.0},          # nothing matches
        {"merchant_name": "Amazon", "description": "", "amount": 30.0,
         "category_id": "cat-manual"},                                               # already set
    ]

    apply_learned(txns, ctx)

    assert txns[0]["category_id"] == "cat-shopping", "memory should win, merchant normalized"
    assert txns[1]["category_id"] == "cat-dining", "longest matching keyword should win"
    assert txns[2]["category_id"] == "cat-drinks"
    assert txns[3]["category_id"] == "cat-income", "money-in maps to Income"
    assert txns[4].get("category_id") is None, "unknown stays uncategorized for review"
    assert txns[5]["category_id"] == "cat-manual", "existing category must be preserved"

    assert _merchant_key({"merchant_name": "  Amazon "}) == "amazon"
    assert _merchant_key({"description": "PAYPAL *X"}) == "paypal *x", "falls back to description"


def test_conditional_rules_on_import():
    """Conditional rules: a rule can additionally gate on money direction
    and amount magnitude, and can flag the row as a reimbursement. The motivating
    case — a roommate's monthly rent-share Zelle nets against Rent, while their
    small Zelles are ignored."""
    ctx = {
        "memory": {},
        "rules": [
            # money IN + "Ved Rao" + amount > $1500 -> Rent + reimbursement
            {"keyword": "ved rao", "category_id": "cat-rent", "direction": "in",
             "min_amount": 1500, "max_amount": None, "set_reimbursement": True},
        ],
        "income_id": "cat-income",
    }
    txns = [
        # Rent share: credit (negative), |amount| >= 1500 -> Rent + reimbursement.
        {"merchant_name": "Ved Rao", "description": "Zelle", "amount": -1800.0},
        # Small Zelle below threshold -> rule ignored, money-in falls to Income.
        {"merchant_name": "Ved Rao", "description": "Zelle", "amount": -22.0},
        # Right amount but wrong direction (a payment OUT to Ved) -> rule ignored.
        {"merchant_name": "Ved Rao", "description": "Zelle", "amount": 1800.0},
    ]

    apply_learned(txns, ctx)

    assert txns[0]["category_id"] == "cat-rent", "rule sets the category"
    assert txns[0].get("is_reimbursement") is True, "rule flags the reimbursement"
    assert txns[1]["category_id"] == "cat-income", "below threshold: rule skipped, income by sign"
    assert txns[1].get("is_reimbursement") is None, "no reimbursement below threshold"
    assert txns[2].get("is_reimbursement") is None, "wrong direction: rule does not fire"
    assert txns[2].get("category_id") is None, "outgoing payment stays uncategorized"


def test_card_refund_flagged_as_reimbursement():
    """A credit on a credit/loan account is a refund/return/statement
    credit — a contra-expense that nets down spend, not income. Depository credits
    stay income; card payoffs (LOAN_PAYMENTS) are transfers, not refunds."""
    ctx = {
        "memory": {"target": "cat-shopping"},
        "rules": [],
        "income_id": "cat-income",
    }
    acct_types = {"card-1": "credit", "loan-1": "loan", "checking-1": "depository"}
    txns = [
        # Card refund, no memory/rule match: flagged reimbursement, stays uncategorized
        # (surfaces in the review queue), NOT income.
        {"account_id": "card-1", "merchant_name": "Mystery Store", "amount": -30.0},
        # Card refund with a memory match: gets the category AND the reimbursement flag,
        # so the category_spend view nets that slice.
        {"account_id": "card-1", "merchant_name": "Target", "amount": -15.0},
        # Card payoff from checking (LOAN_PAYMENTS) is a transfer, not a refund.
        {"account_id": "card-1", "merchant_name": "Payment", "amount": -500.0,
         "plaid_category": "LOAN_PAYMENTS"},
        # Loan-account credit behaves like a card credit.
        {"account_id": "loan-1", "merchant_name": "Overpayment Refund", "amount": -40.0},
        # Depository credit is real income, unchanged.
        {"account_id": "checking-1", "merchant_name": "Employer", "amount": -4200.0},
        # A card DEBIT (spend) is untouched by the refund path.
        {"account_id": "card-1", "merchant_name": "Coffee", "amount": 5.0},
    ]

    apply_learned(txns, ctx, acct_types)

    assert txns[0].get("is_reimbursement") is True, "card refund flagged"
    assert txns[0].get("category_id") is None, "unmatched refund stays uncategorized for review"
    assert txns[1].get("is_reimbursement") is True, "memory-matched refund still flagged"
    assert txns[1]["category_id"] == "cat-shopping", "memory category applies for per-category netting"
    assert txns[2].get("is_reimbursement") is None, "card payoff (LOAN_PAYMENTS) is a transfer, not a refund"
    assert txns[2].get("category_id") is None, "card payoff stays uncategorized (transfer detection excludes it)"
    assert txns[3].get("is_reimbursement") is True, "loan-account credit is a refund too"
    assert txns[4].get("is_reimbursement") is None, "depository credit is real income"
    assert txns[4]["category_id"] == "cat-income", "depository credit maps to Income"
    assert txns[5].get("is_reimbursement") is None, "a card debit (spend) is never a reimbursement"


# ── is_reimbursement NOT NULL guard (regression: the crash that stalled a
#    fresh item's initial sync — one null row 23502'd the whole batch upsert) ──
def test_fill_user_owned_defaults_coalesces_reimbursement():
    rows = [
        {"plaid_transaction_id": "a"},                       # key absent
        {"plaid_transaction_id": "b", "is_reimbursement": None},   # explicit None
        {"plaid_transaction_id": "c", "is_reimbursement": True},   # keep True
    ]
    out = sync._fill_user_owned_defaults(rows)
    assert out[0]["is_reimbursement"] is False, "absent -> false (never send NULL)"
    assert out[1]["is_reimbursement"] is False, "explicit None -> false"
    assert out[2]["is_reimbursement"] is True, "an already-flagged reimbursement is preserved"
    assert all(r["is_reimbursement"] is not None for r in out), "no row leaves a NULL for the NOT NULL column"


# ── PRODUCT_NOT_READY is a soft skip, not a sync failure ────────────────────
def test_is_product_not_ready_detects_plaid_code():
    import json as _json

    import plaid

    not_ready = plaid.ApiException(status=400)
    not_ready.body = _json.dumps({"error_code": "PRODUCT_NOT_READY"})
    assert sync._is_product_not_ready(not_ready) is True

    other = plaid.ApiException(status=400)
    other.body = _json.dumps({"error_code": "ITEM_LOGIN_REQUIRED"})
    assert sync._is_product_not_ready(other) is False, "a different Plaid error must still surface"

    malformed = plaid.ApiException(status=400)
    malformed.body = "not json"
    assert sync._is_product_not_ready(malformed) is False, "unparseable body must not be swallowed as not-ready"

    non_object = plaid.ApiException(status=400)
    non_object.body = "[]"  # valid JSON, but not an object -> no error_code, must not raise
    assert sync._is_product_not_ready(non_object) is False, "non-object JSON body must not crash the check"

    assert sync._is_product_not_ready(ValueError("nope")) is False, "non-Plaid errors are never not-ready"


# ── 3. Net worth snapshot ───────────────────────────────────────────────────
def test_net_worth_math():
    """Assets vs liabilities from the latest balance per account: credit/loan are
    liabilities, negative balances clamp to 0, inactive accounts are excluded, and
    manual 'separate' accounts fold in from their signed ledger.

    NOTE: latest_balances is a DB view; here it's seeded directly to exercise the
    Python aggregation. The view itself (latest-per-account, RLS) is covered in
    test_integration.py."""
    db = FakeSupabase(tables={
        "latest_balances": [
            {"user_id": USER, "account_id": "a-check", "current_balance": 1000},   # asset
            {"user_id": USER, "account_id": "a-card", "current_balance": 200},     # liability (credit)
            {"user_id": USER, "account_id": "a-neg", "current_balance": -50},      # asset, negative → clamps to 0
            {"user_id": USER, "account_id": "a-dead", "current_balance": 9999},    # inactive → excluded
        ],
        "accounts": [   # active accounts only; a-dead intentionally absent
            {"id": "a-check", "user_id": USER, "type": "depository", "is_active": True},
            {"id": "a-card", "user_id": USER, "type": "credit", "is_active": True},
            {"id": "a-neg", "user_id": USER, "type": "depository", "is_active": True},
        ],
        "separate_accounts": [
            {"id": "s-invest", "user_id": USER, "type": "investment", "is_active": True},   # asset
            {"id": "s-loan", "user_id": USER, "type": "loan", "is_active": True},           # liability
        ],
        "separate_account_values": [
            {"separate_account_id": "s-invest", "amount": 4000},
            {"separate_account_id": "s-invest", "amount": 1000},   # summed → 5000
            {"separate_account_id": "s-loan", "amount": 1500},
        ],
    })

    sync.write_net_worth_snapshot(db, USER)

    snap = db.one("net_worth_snapshots", user_id=USER)
    assert snap is not None, "snapshot must be user-stamped"
    assert snap["total_assets"] == 6000.0, snap        # 1000 + 0(clamped) + 5000
    assert snap["total_liabilities"] == 1700.0, snap   # 200 + 1500
    assert snap["net_worth"] == 4300.0                 # generated column mirror
    assert snap["date"] == datetime.date.today().isoformat()


# ── 4. Recurring contributions ──────────────────────────────────────────────
def test_recurring_contributions_logic():
    """Each elapsed period since anchor/last posts exactly one ledger delta, then
    last_applied_date advances to the last posted date. Non-positive frequency is
    skipped; a flow already caught up posts nothing."""
    today = datetime.date.today()
    anchor = today - datetime.timedelta(days=70)   # with freq=30 → posts at +0,+30,+60 (3), +90 is future

    db = FakeSupabase(tables={
        "recurring_contributions": [
            {"id": "r-due", "user_id": USER, "separate_account_id": "s-1",
             "delta_balance": 250.0, "frequency_in_days": 30,
             "anchor_date": anchor.isoformat(), "last_applied_date": None, "is_active": True},
            {"id": "r-badfreq", "user_id": USER, "separate_account_id": "s-2",
             "delta_balance": 10.0, "frequency_in_days": 0,
             "anchor_date": anchor.isoformat(), "last_applied_date": None, "is_active": True},
            {"id": "r-current", "user_id": USER, "separate_account_id": "s-3",
             "delta_balance": 99.0, "frequency_in_days": 30,
             "anchor_date": anchor.isoformat(), "last_applied_date": today.isoformat(),
             "is_active": True},
        ],
    })

    sync.materialize_recurring_contributions(db, USER)

    due = [v for v in db.rows("separate_account_values") if v["separate_account_id"] == "s-1"]
    expected_dates = [(anchor + datetime.timedelta(days=30 * i)).isoformat() for i in range(3)]
    assert [v["date"] for v in due] == expected_dates, "one delta per elapsed period"
    assert all(v["amount"] == 250.0 and v["user_id"] == USER for v in due)
    assert db.one("recurring_contributions", id="r-due")["last_applied_date"] == expected_dates[-1]

    # freq <= 0 and already-current flows post nothing and don't advance
    assert not [v for v in db.rows("separate_account_values") if v["separate_account_id"] in ("s-2", "s-3")]
    assert db.one("recurring_contributions", id="r-current")["last_applied_date"] == today.isoformat()


def test_cron_finalizes_manual_only_recurring_users(monkeypatch):
    """The cron sweep (user_id=None) derived its finalize set from plaid_items only,
    so a user whose only data is manual — a recurring contribution with no Plaid item
    to drive a sync — was never finalized and their contributions never materialized
. The sweep must union in the owners of active recurring flows; inactive
    flows must not pull their owner in."""
    db = FakeSupabase(tables={
        "plaid_items": [],   # no Plaid items at all → the item loop finalizes no one
        "recurring_contributions": [
            {"id": "r-active", "user_id": "manual-only", "separate_account_id": "s-1",
             "delta_balance": 100.0, "frequency_in_days": 30,
             "anchor_date": "2026-01-01", "last_applied_date": None, "is_active": True},
            {"id": "r-inactive", "user_id": "paused-user", "separate_account_id": "s-2",
             "delta_balance": 5.0, "frequency_in_days": 30,
             "anchor_date": "2026-01-01", "last_applied_date": None, "is_active": False},
        ],
    })
    monkeypatch.setattr(sync, "get_supabase", lambda: db)
    finalized = []
    monkeypatch.setattr(sync, "_finalize_user",
                        lambda supabase, uid, **kw: finalized.append(uid))

    sync.run_sync()   # cron sweep (no user_id)

    assert "manual-only" in finalized, "manual-only recurring user must be finalized"
    assert "paused-user" not in finalized, "inactive flows don't pull their owner in"


# ── 5. Plaid webhook signature verification ─────────────────────────────────
# A key-service outage must be distinguished from a bad signature: dropping a
# genuine webhook as "invalid signature" during a Plaid outage silently halts
# real-time sync. Infra failure -> raise (caller 5xxes, Plaid retries);
# genuinely bad token -> False (reject).
import base64
import json as _json

import plaid
import pytest

import api


def _es256_token(kid="k1"):
    """A token whose *unverified* header is a valid ES256/kid header (enough to
    reach the key fetch); the signature itself is never checked in these tests."""
    def _seg(d):
        return base64.urlsafe_b64encode(_json.dumps(d).encode()).rstrip(b"=").decode()
    return f"{_seg({'alg': 'ES256', 'kid': kid})}.{_seg({})}.sig"


class _RaisingPlaid:
    """Plaid client whose verification-key fetch always raises `exc`."""

    def __init__(self, exc):
        self.exc = exc
        self.calls = 0

    def webhook_verification_key_get(self, req):
        self.calls += 1
        raise self.exc


def test_webhook_key_service_outage_raises_not_false():
    """A network error / Plaid outage while fetching the key surfaces as
    WebhookKeyUnavailable — NOT swallowed as a valid-signature failure."""
    api._key_cache.clear()
    client = _RaisingPlaid(ConnectionError("plaid key service unreachable"))
    with pytest.raises(api.WebhookKeyUnavailable):
        api._verify_plaid_webhook(client, "client-1", _es256_token(), b"{}")
    assert client.calls == 1, "must actually attempt the key fetch"


def test_webhook_plaid_5xx_is_infra_failure():
    """A 5xx from Plaid's key service is infra (Plaid failing us), not a bad
    signature -> raise so the handler 5xxes and Plaid retries."""
    api._key_cache.clear()
    client = _RaisingPlaid(plaid.ApiException(status=503))
    with pytest.raises(api.WebhookKeyUnavailable):
        api._verify_plaid_webhook(client, "client-1", _es256_token(), b"{}")


def test_webhook_unknown_kid_4xx_is_bad_signature():
    """A 4xx (Plaid refusing the key_id — a kid not owned by this account) means
    the token is unverifiable, i.e. a bad signature -> False, not an infra 5xx."""
    api._key_cache.clear()
    client = _RaisingPlaid(plaid.ApiException(status=400))
    assert api._verify_plaid_webhook(client, "client-1", _es256_token(), b"{}") is False


def test_webhook_malformed_token_is_bad_signature_without_key_fetch():
    """Missing / non-ES256 / garbage tokens are rejected as bad signatures
    (False) and never even reach the key service."""
    client = _RaisingPlaid(AssertionError("key fetch must not be attempted"))
    assert api._verify_plaid_webhook(client, "client-1", "", b"{}") is False
    assert api._verify_plaid_webhook(client, "client-1", "not-a-jwt", b"{}") is False
    hs256 = base64.urlsafe_b64encode(b'{"alg":"HS256"}').rstrip(b"=").decode() + ".x.y"
    assert api._verify_plaid_webhook(client, "client-1", hs256, b"{}") is False
    assert client.calls == 0


# ── 6. Recurring contributions: no double-count under overlapping syncs ──────
def test_recurring_contributions_no_double_count_on_overlapping_sync():
    """Two overlapping syncs that both read the same (pre-advance)
    last_applied_date must not double-post the same periods. The unique
    (recurring_contribution_id, date) key + on-conflict-do-nothing upsert makes the
    racing sync's re-insert a no-op instead of inflating net worth."""
    today = datetime.date.today()
    anchor = today - datetime.timedelta(days=70)   # freq 30 → posts at +0,+30,+60

    db = FakeSupabase(tables={
        "recurring_contributions": [
            {"id": "r-due", "user_id": USER, "separate_account_id": "s-1",
             "delta_balance": 250.0, "frequency_in_days": 30,
             "anchor_date": anchor.isoformat(), "last_applied_date": None, "is_active": True},
        ],
    })

    sync.materialize_recurring_contributions(db, USER)
    first = [v for v in db.rows("separate_account_values") if v["separate_account_id"] == "s-1"]
    assert len(first) == 3

    # Simulate the racing sync: it read last_applied_date *before* the first run
    # advanced it, so it recomputes and re-posts the very same periods.
    db.one("recurring_contributions", id="r-due")["last_applied_date"] = None
    sync.materialize_recurring_contributions(db, USER)

    again = [v for v in db.rows("separate_account_values") if v["separate_account_id"] == "s-1"]
    assert len(again) == 3, "overlapping sync must not double-count materialized periods"
