"""Investment cash-movement ingest (investments.py) against the in-memory fakes.

sync_investment_transactions pulls Plaid /investments/transactions/get, keeps
only external cash movements (deposits/withdrawals/etc.), and writes them into
`transactions` with a synthesized transfer signal so transfers.detect_transfers
can pair or one-side them. These pin that end to end:

  - a brokerage deposit auto-pairs with its bank-withdrawal counterpart,
  - a lone deposit is marked one_sided (excluded, upgradable in place),
  - buys / dividends are NOT ingested (they'd leak as spend),
  - an item with no brokerage account is skipped (no Plaid call, no writes),
  - offset pagination ingests every page.

Run:  pytest tests/test_investments.py      (from finance-backend/sync-service)
"""
import datetime

from investments import _INVEST_PAGE, sync_investment_transactions
from tests.fakes import FakePlaid, FakeSupabase
from transfers import detect_transfers

USER = "user-1"

# acct_map is {plaid_account_id: db_uuid}; acct_types is {db_uuid: type} — the
# exact shapes sync._refresh_accounts_and_balances / _load_account_map build.
PA_BROK, A_BROK = "pa-brok", "a-brok"
PA_CHECK, A_CHECK = "pa-check", "a-check"
ACCT_MAP = {PA_BROK: A_BROK, PA_CHECK: A_CHECK}
ACCT_TYPES = {A_BROK: "investment", A_CHECK: "depository"}

ACCOUNTS = [
    {"id": A_BROK, "user_id": USER, "type": "investment"},
    {"id": A_CHECK, "user_id": USER, "type": "depository"},
]


def d(days_ago: int) -> str:
    return (datetime.date.today() - datetime.timedelta(days=days_ago)).isoformat()


def txn(id, account, amount, days_ago=2, pfc=None, **extra):
    """A regular (bank) transaction row, seeded directly into the fake DB.
    Copied from test_transfers.py's helper (kept local by design). created_at
    defaults to the transaction date; pass created_at=d(0) to model a backdated
    leg only just delivered by Plaid."""
    return {"id": id, "user_id": USER, "plaid_transaction_id": f"p-{id}",
            "account_id": account, "amount": amount, "date": d(days_ago),
            "created_at": d(days_ago),
            "pending": False, "plaid_category": pfc, **extra}


def itxn(id, account, amount, type, subtype, days_ago=2, name=None):
    """A raw Plaid investment transaction (pre-filter). `date` is a 'YYYY-MM-DD'
    string — the code stores str(itxn['date'])."""
    return {"investment_transaction_id": f"it-{id}", "account_id": account,
            "security_id": None, "date": d(days_ago), "name": name or id,
            "amount": amount, "type": type, "subtype": subtype,
            "iso_currency_code": "USD"}


def db_with(*txns):
    return FakeSupabase(tables={"accounts": ACCOUNTS, "transactions": list(txns)})


def ingest(db, plaid, acct_types=ACCT_TYPES, full=False):
    stats = {"transactions_added": 0}
    sync_investment_transactions(plaid, db, "tok", "item-1", ACCT_MAP,
                                 acct_types, USER, stats, full=full)
    return stats


def test_deposit_pairs_with_bank_withdrawal():
    """Brokerage deposit (cash IN, amount<0) ingests as TRANSFER_IN and
    auto-pairs with the checking-account TRANSFER_OUT that funded it."""
    db = db_with(txn("bank-out", A_CHECK, 5000.0, days_ago=2, pfc="TRANSFER_OUT"))
    plaid = FakePlaid(accounts=[], pages=[], investment_txns=[
        itxn("dep", PA_BROK, -5000.0, "cash", "deposit", days_ago=2),
    ])

    stats = ingest(db, plaid)
    assert stats["transactions_added"] == 1

    brok = db.one("transactions", plaid_transaction_id="it-dep")
    assert brok is not None
    assert brok["account_id"] == A_BROK
    assert brok["amount"] == -5000.0
    assert brok["plaid_category"] == "TRANSFER_IN"
    assert brok["plaid_category_detail"] == "TRANSFER_IN_INVESTMENT_AND_RETIREMENT_FUNDS"

    assert detect_transfers(db, USER) == {"linked": 1, "one_sided": 0}
    out = db.one("transactions", id="bank-out")
    brok = db.one("transactions", plaid_transaction_id="it-dep")
    assert out["transfer_group_id"] == brok["transfer_group_id"] is not None
    assert out["transfer_kind"] == brok["transfer_kind"] == "auto"
    assert out["exclude_from_totals"] and brok["exclude_from_totals"]


def test_lone_deposit_marked_one_sided():
    """No connected counterpart: the ingested self-move detail
    (TRANSFER_IN_INVESTMENT_AND_RETIREMENT_FUNDS ∈ ONE_SIDED_DETAILS) makes it
    one_sided + excluded, ready to upgrade in place if the other leg syncs."""
    db = db_with()
    plaid = FakePlaid(accounts=[], pages=[], investment_txns=[
        itxn("dep", PA_BROK, -5000.0, "cash", "deposit", days_ago=3),
    ])

    ingest(db, plaid)
    assert detect_transfers(db, USER) == {"linked": 0, "one_sided": 1}
    brok = db.one("transactions", plaid_transaction_id="it-dep")
    assert brok["transfer_kind"] == "one_sided"
    assert brok["exclude_from_totals"]


def test_buy_not_ingested():
    """A buy has amount>0 and no transfer signal — ingesting it would leak as
    spend, so type='buy' is filtered out entirely."""
    db = db_with()
    plaid = FakePlaid(accounts=[], pages=[], investment_txns=[
        itxn("buy", PA_BROK, 300.0, "buy", "buy", days_ago=1),
    ])

    stats = ingest(db, plaid)
    assert stats["transactions_added"] == 0
    assert db.one("transactions", plaid_transaction_id="it-buy") is None
    assert db.rows("transactions") == []


def test_dividend_not_ingested():
    """type='cash' but subtype='dividend' isn't in the cash-movement allowlist
    (dividends-as-income is a separate follow-up), so it's dropped."""
    db = db_with()
    plaid = FakePlaid(accounts=[], pages=[], investment_txns=[
        itxn("div", PA_BROK, -12.0, "cash", "dividend", days_ago=1),
    ])

    stats = ingest(db, plaid)
    assert stats["transactions_added"] == 0
    assert db.rows("transactions") == []


def test_non_brokerage_item_skipped():
    """No 'investment' account type on the item → skip before any Plaid call,
    don't spend a paid request, write nothing, and never raise."""
    db = db_with()
    plaid = FakePlaid(accounts=[], pages=[], investment_txns=[
        itxn("dep", PA_CHECK, -5000.0, "cash", "deposit", days_ago=1),
    ])

    stats = ingest(db, plaid, acct_types={A_CHECK: "depository"})
    assert stats["transactions_added"] == 0
    assert plaid.investments_get_count == 0
    assert db.rows("transactions") == []


def test_offset_pagination_ingests_all_pages():
    """More cash movements than one page (> _INVEST_PAGE): the offset loop must
    fetch every page and ingest all of them."""
    n = _INVEST_PAGE + 3  # forces exactly two offset pages
    seeded = [itxn(f"dep{i}", PA_BROK, -100.0 - i, "cash", "deposit", days_ago=2)
              for i in range(n)]
    db = db_with()
    plaid = FakePlaid(accounts=[], pages=[], investment_txns=seeded)

    stats = ingest(db, plaid)
    assert plaid.investments_get_count == 2
    assert stats["transactions_added"] == n
    assert len(db.rows("transactions")) == n


def test_backdated_deposit_pairs_on_the_sync_that_ingests_it():
    """Regression. Plaid readies the investments product asynchronously
    and delivers cash movements dated far beyond the 30-day incremental lookback
    (a backfill spans 730 days). The leg must still pair on the sync that
    ingests it — detect now scans by ingest time too, not just transaction date.
    Before the fix the deposit (date 200d ago) fell outside the date window and
    was never matched until a later full=True run."""
    db = db_with(txn("bank-out", A_CHECK, 5000.0, days_ago=200,
                     pfc="TRANSFER_OUT", created_at=d(0)))
    plaid = FakePlaid(accounts=[], pages=[], investment_txns=[
        itxn("dep", PA_BROK, -5000.0, "cash", "deposit", days_ago=200),
    ])
    ingest(db, plaid)   # ingested leg gets created_at≈today (fake mirrors default now())

    # Incremental detect (full=False) — the run that fires when investments ready
    # on a non-HISTORICAL webhook after the transaction cursor is already set.
    assert detect_transfers(db, USER) == {"linked": 1, "one_sided": 0}
    out = db.one("transactions", id="bank-out")
    brok = db.one("transactions", plaid_transaction_id="it-dep")
    assert out["transfer_group_id"] == brok["transfer_group_id"] is not None
    assert out["exclude_from_totals"] and brok["exclude_from_totals"]


def test_backdated_lone_deposit_excluded_on_ingesting_sync():
    """Even with no connected counterpart, a backdated freshly-ingested self-move
    leg must be marked one_sided (excluded) on the ingesting sync — not left
    counted as income until some later full run. This is the 12-unmatched-legs
    prod bug: every historical investment leg beyond the 30-day window
    stayed in totals."""
    db = db_with()
    plaid = FakePlaid(accounts=[], pages=[], investment_txns=[
        itxn("dep", PA_BROK, -2000.0, "cash", "deposit", days_ago=300),
    ])
    ingest(db, plaid)
    assert detect_transfers(db, USER) == {"linked": 0, "one_sided": 1}
    brok = db.one("transactions", plaid_transaction_id="it-dep")
    assert brok["transfer_kind"] == "one_sided" and brok["exclude_from_totals"]
