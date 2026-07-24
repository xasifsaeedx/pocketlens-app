"""Integration tests against a REAL local Supabase (Postgres + GoTrue + PostgREST).

These cover what the in-memory fakes cannot — the things Postgres itself enforces:
  1. RLS user isolation   — one user can never see or mutate another's rows
  2. Signup trigger       — a new auth user auto-gets the default categories
  3. Generated columns    — effective_date + net_worth are computed by the DB
  4. latest_balances view — latest balance per account, RLS-scoped

Run locally:
    cd finance-backend && supabase start
    cd sync-service && eval "$(cd ../supabase >/dev/null; \\
        supabase status -o env | sed 's/^/export /; s/API_URL/SUPABASE_URL/; \\
        s/ANON_KEY/SUPABASE_ANON_KEY/; s/SERVICE_ROLE_KEY/SUPABASE_SERVICE_ROLE_KEY/')"
    pytest tests/test_integration.py

If the SUPABASE_* env vars are unset the whole module is skipped, so the fast
logic suite still runs without docker. As a hard safety net we refuse to run
against any non-local URL — these tests create and delete auth users.
"""
import datetime
import os
import uuid

import pytest

try:
    from supabase import create_client
except Exception:  # pragma: no cover - supabase always present via requirements
    create_client = None

URL = os.environ.get("SUPABASE_URL")
ANON = os.environ.get("SUPABASE_ANON_KEY")
SERVICE = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")

_LOCAL = URL and ("127.0.0.1" in URL or "localhost" in URL)

pytestmark = [
    # Tier tag: CI routes this file to the `integration` job (needs `supabase start`).
    # The logic job runs `-m "not integration"`, so new fakes-only files are picked
    # up automatically without touching CI.
    pytest.mark.integration,
    pytest.mark.skipif(
        not (create_client and URL and ANON and SERVICE and _LOCAL),
        reason="local Supabase not configured (set SUPABASE_URL/ANON/SERVICE_ROLE_KEY to a 127.0.0.1 stack)",
    ),
]


@pytest.fixture(scope="module")
def service():
    return create_client(URL, SERVICE)


@pytest.fixture
def make_user(service):
    """Factory → (user_id, signed_in_client). All created users are deleted after
    the test (cascade wipes their data)."""
    created = []

    def _make():
        email = f"itest-{uuid.uuid4().hex}@example.com"
        password = "test-password-123"
        res = service.auth.admin.create_user(
            {"email": email, "password": password, "email_confirm": True}
        )
        uid = res.user.id
        created.append(uid)
        client = create_client(URL, ANON)
        session = client.auth.sign_in_with_password({"email": email, "password": password})
        # Pin the user's JWT onto PostgREST so table requests run as `authenticated`
        # (not `anon`), regardless of the SDK's auth-event wiring.
        client.postgrest.auth(session.session.access_token)
        return uid, client

    yield _make

    for uid in created:
        try:
            service.auth.admin.delete_user(uid)
        except Exception:
            pass


def _account(client, name="Checking", type="depository"):
    """Insert a minimal account as the signed-in user; user_id auto-stamps."""
    row = client.table("accounts").insert({
        "plaid_account_id": f"pa-{uuid.uuid4().hex}",
        "name": name,
        "type": type,
    }).execute().data[0]
    return row["id"]


# ── 1. RLS user isolation ────────────────────────────────────────────────────
def test_rls_user_isolation(make_user):
    a_id, a = make_user()
    b_id, b = make_user()

    a_acct = _account(a, name="A-Checking")
    b_acct = _account(b, name="B-Savings")

    # each user auto-stamped as owner
    assert a.table("accounts").select("user_id").eq("id", a_acct).single().execute().data["user_id"] == a_id
    assert b.table("accounts").select("user_id").eq("id", b_acct).single().execute().data["user_id"] == b_id

    # each sees ONLY its own rows
    a_rows = a.table("accounts").select("id").execute().data
    b_rows = b.table("accounts").select("id").execute().data
    assert {r["id"] for r in a_rows} == {a_acct}, "A must not see B's accounts"
    assert {r["id"] for r in b_rows} == {b_acct}, "B must not see A's accounts"

    # A cannot read B's row by id
    assert a.table("accounts").select("id").eq("id", b_acct).execute().data == []

    # A cannot mutate B's row (RLS filters the update to 0 rows)
    a.table("accounts").update({"name": "HACKED"}).eq("id", b_acct).execute()
    assert b.table("accounts").select("name").eq("id", b_acct).single().execute().data["name"] == "B-Savings"

    # A cannot delete B's row
    a.table("accounts").delete().eq("id", b_acct).execute()
    assert b.table("accounts").select("id").eq("id", b_acct).execute().data, "B's row must survive A's delete"


# ── 2. Signup trigger seeds default categories ───────────────────────────────
def test_signup_trigger_seeds_categories(make_user):
    _uid, client = make_user()

    cats = client.table("categories").select("name, kind").execute().data
    by_name = {c["name"]: c["kind"] for c in cats}

    assert set(by_name) == {"Groceries", "Dining", "Rent", "Utilities",
                            "Transport", "Other", "Income"}, by_name
    assert by_name["Income"] == "income"
    assert all(k == "spend" for n, k in by_name.items() if n != "Income")


# ── 3. Generated columns (effective_date, net_worth) ─────────────────────────
def test_generated_columns(make_user):
    _uid, client = make_user()
    acct = _account(client)

    def insert_txn(date, authorized_date):
        return client.table("transactions").insert({
            "plaid_transaction_id": f"pt-{uuid.uuid4().hex}",
            "account_id": acct,
            "date": date,
            "authorized_date": authorized_date,
            "amount": 10.00,
        }).execute().data[0]

    # effective_date = coalesce(authorized_date, date)
    t1 = insert_txn("2026-07-01", "2026-06-30")
    assert t1["effective_date"] == "2026-06-30", "should prefer authorized_date"
    t2 = insert_txn("2026-07-05", None)
    assert t2["effective_date"] == "2026-07-05", "should fall back to date"

    # net_worth = total_assets - total_liabilities
    snap = client.table("net_worth_snapshots").insert({
        "date": "2026-07-02",
        "total_assets": 10000,
        "total_liabilities": 3500,
    }).execute().data[0]
    assert float(snap["net_worth"]) == 6500.0


# ── 4. latest_balances view ──────────────────────────────────────────────────
def test_latest_balances_view(make_user):
    _uid, client = make_user()
    acct = _account(client)

    for date, bal in [("2026-05-01", 100), ("2026-06-01", 250), ("2026-07-01", 400),
                      ("2026-07-02", None)]:  # null balance (Plaid can return one)
        client.table("account_balance_history").insert({
            "account_id": acct,
            "date": date,
            "current_balance": bal,
            "available_balance": bal,
        }).execute()

    view = client.table("latest_balances").select("account_id, current_balance, date") \
        .eq("account_id", acct).execute().data
    assert len(view) == 1, "one row per account"
    assert view[0]["date"] == "2026-07-01", "null-balance rows skipped — newest non-null wins"
    assert float(view[0]["current_balance"]) == 400.0

    # security_invoker: another user sees nothing through the view
    _b_uid, other = make_user()
    assert other.table("latest_balances").select("account_id").eq("account_id", acct).execute().data == []


# ── 5. category_spend view (splits-aware spend per category per month) ──────
def test_category_spend_view(make_user):
    _uid, client = make_user()
    acct = _account(client)
    dining, groceries = _spend_cats(client, 2)  # name-ordered: Dining, Groceries

    def insert_txn(amount, category_id=None, exclude=False, date="2026-07-10"):
        return client.table("transactions").insert({
            "plaid_transaction_id": f"pt-{uuid.uuid4().hex}",
            "account_id": acct,
            "date": date,
            "amount": amount,
            "category_id": category_id,
            "exclude_from_totals": exclude,
        }).execute().data[0]

    # Plain txn: counts under its own category.
    insert_txn(30, category_id=dining)
    # Split txn: counts per split; the parent's own category must NOT double-count
    # (even though the split editor normally nulls it, the view must ignore it).
    split_parent = insert_txn(100, category_id=dining)
    client.table("transaction_splits").insert([
        {"transaction_id": split_parent["id"], "category_id": groceries, "amount": 60},
        {"transaction_id": split_parent["id"], "category_id": dining, "amount": 40},
    ]).execute()
    # Excluded txn (hidden/transfer path): absent from the view.
    insert_txn(50, category_id=dining, exclude=True)
    # Income (negative amount): not spend, absent.
    insert_txn(-200, category_id=dining)
    # Different month: lands in its own month bucket, not July's.
    insert_txn(7, category_id=dining, date="2026-08-02")

    rows = client.table("category_spend").select("month, category_id, spent") \
        .eq("month", "2026-07-01").execute().data
    spent = {r["category_id"]: float(r["spent"]) for r in rows}
    assert spent == {dining: 70.0, groceries: 60.0}, \
        "dining = 30 plain + 40 split (parent's 100 not double-counted); groceries = 60 split"

    aug = client.table("category_spend").select("category_id, spent") \
        .eq("month", "2026-08-01").execute().data
    assert {r["category_id"]: float(r["spent"]) for r in aug} == {dining: 7.0}

    # security_invoker: another user sees nothing through the view.
    _b_uid, other = make_user()
    assert other.table("category_spend").select("category_id").execute().data == []


def test_category_spend_nets_reimbursements(make_user):
    # A reimbursement (is_reimbursement, negative amount) folds into its category and
    # nets its spend down — the rule the web `categorySpend` client fn used to encode
    # before it was deleted in favour of this view.
    _uid, client = make_user()
    acct = _account(client)
    (rent,) = _spend_cats(client, 1)

    def insert_txn(amount, reimbursement=False):
        client.table("transactions").insert({
            "plaid_transaction_id": f"pt-{uuid.uuid4().hex}",
            "account_id": acct, "date": "2026-07-10", "amount": amount,
            "category_id": rent, "is_reimbursement": reimbursement,
        }).execute()

    insert_txn(3000)                        # rent spend
    insert_txn(-1500, reimbursement=True)   # roommate pays half back
    spent = {r["category_id"]: float(r["spent"]) for r in
             client.table("category_spend").select("category_id, spent")
             .eq("month", "2026-07-01").execute().data}
    assert spent == {rent: 1500.0}, "reimbursement nets rent 3000 → 1500"

    # Over-reimbursed goes negative (do not clamp) — money genuinely came back.
    insert_txn(-1600, reimbursement=True)
    over = {r["category_id"]: float(r["spent"]) for r in
            client.table("category_spend").select("category_id, spent")
            .eq("month", "2026-07-01").execute().data}
    assert over == {rent: -100.0}


# ── 5b. current_net_worth view (live net worth, snapshot-writer semantics) ──
def test_current_net_worth_view(make_user):
    """The view must mirror sync.write_net_worth_snapshot: latest balance per
    account, active accounts only, per-account clamp at zero, credit/loan =
    liability, separate-account balance = signed ledger sum."""
    _uid, client = make_user()

    checking = _account(client, name="Checking")
    overdrawn = _account(client, name="Overdrawn")
    card = _account(client, name="Card", type="credit")
    closed = _account(client, name="Closed")

    for acct, rows in {
        checking: [("2026-06-01", 100), ("2026-07-01", 500)],   # latest wins
        overdrawn: [("2026-07-01", -50)],                       # clamped to 0
        card: [("2026-07-01", 200)],                            # liability
        closed: [("2026-07-01", 999)],                          # inactive → excluded
    }.items():
        for date, bal in rows:
            client.table("account_balance_history").insert({
                "account_id": acct,
                "date": date,
                "current_balance": bal,
                "available_balance": bal,
            }).execute()
    client.table("accounts").update({"is_active": False}).eq("id", closed).execute()

    brokerage = client.table("separate_accounts").insert(
        {"name": "Brokerage", "type": "investment"}).execute().data[0]["id"]
    car_loan = client.table("separate_accounts").insert(
        {"name": "Car loan", "type": "loan"}).execute().data[0]["id"]
    client.table("separate_account_values").insert([
        {"separate_account_id": brokerage, "date": "2026-06-15", "amount": 100},
        {"separate_account_id": brokerage, "date": "2026-07-01", "amount": 50},
        {"separate_account_id": car_loan, "date": "2026-06-20", "amount": 300},
    ]).execute()

    row = client.table("current_net_worth").select("*").single().execute().data
    assert float(row["total_assets"]) == 650.0, \
        "checking latest 500 + overdrawn clamped 0 + brokerage ledger 150; inactive excluded"
    assert float(row["total_liabilities"]) == 500.0, "card 200 + car-loan ledger 300"
    assert float(row["net_worth"]) == 150.0
    assert row["as_of"] == "2026-07-01"

    # security_invoker: another user sees no rows through the view.
    _b_uid, other = make_user()
    assert other.table("current_net_worth").select("user_id").execute().data == []


# ── 5b. split-sum invariant (DEFERRABLE constraint trigger) ──────────────────
def test_split_sum_invariant(make_user):
    _uid, client = make_user()
    acct = _account(client)
    dining, groceries = _spend_cats(client, 2)

    parent = client.table("transactions").insert({
        "plaid_transaction_id": f"pt-{uuid.uuid4().hex}",
        "account_id": acct, "date": "2026-07-10", "amount": 100,
    }).execute().data[0]["id"]

    def legs(*amounts):
        return [{"transaction_id": parent, "category_id": c, "amount": a}
                for c, a in zip((groceries, dining), amounts, strict=True)]

    # Balanced (60 + 40 = 100): accepted.
    client.table("transaction_splits").insert(legs(60, 40)).execute()

    # Unbalancing an existing txn by deleting one leg (remaining 60 ≠ 100) must be
    # rejected at COMMIT — this is the "undercount" the invariant exists to stop.
    a_leg = client.table("transaction_splits").select("id") \
        .eq("transaction_id", parent).eq("amount", 40).single().execute().data["id"]
    with pytest.raises(Exception) as exc:
        client.table("transaction_splits").delete().eq("id", a_leg).execute()
    assert "splits sum" in str(exc.value)

    # Clearing ALL splits (txn reverts to single-category) is fine — invariant N/A.
    client.table("transaction_splits").delete().eq("transaction_id", parent).execute()
    assert client.table("transaction_splits").select("id") \
        .eq("transaction_id", parent).execute().data == []

    # A fresh imbalanced insert (60 + 30 = 90 ≠ 100) is rejected outright.
    with pytest.raises(Exception) as exc:
        client.table("transaction_splits").insert(legs(60, 30)).execute()
    assert "splits sum" in str(exc.value)


# ── 6. ZBB (zero-sum budgeting) RLS isolation ────────────────────────────────
def _spend_cats(client, n=1):
    rows = client.table("categories").select("id, name").eq("kind", "spend") \
        .order("name").limit(n).execute().data
    return [r["id"] for r in rows]


def test_zbb_rls_isolation(make_user):
    a_id, a = make_user()
    b_id, b = make_user()

    # settings — one row per user, auto-stamped, isolated
    a.table("zbb_settings").insert({"enabled": True, "monthly_income": 5000}).execute()
    b.table("zbb_settings").insert({"enabled": False, "monthly_income": 1000}).execute()
    a_settings = a.table("zbb_settings").select("*").execute().data
    assert len(a_settings) == 1 and a_settings[0]["user_id"] == a_id
    assert float(a_settings[0]["monthly_income"]) == 5000.0
    assert {r["user_id"] for r in a.table("zbb_settings").select("user_id").execute().data} == {a_id}

    # months
    a.table("zbb_months").insert({"year": 2026, "month": 7, "income": 5000}).execute()
    assert a.table("zbb_months").select("id").execute().data
    assert b.table("zbb_months").select("id").execute().data == [], "B must not see A's months"

    # assignments (category auto-seeded by signup trigger, RLS-scoped per user)
    (a_cat,) = _spend_cats(a, 1)
    a.table("zbb_assignments").insert(
        {"category_id": a_cat, "year": 2026, "month": 7, "assigned": 300}
    ).execute()
    assert a.table("zbb_assignments").select("id").execute().data
    assert b.table("zbb_assignments").select("id").execute().data == [], "B must not see A's assignments"


# ── 7. zbb_move_money RPC: atomic shift + guards ─────────────────────────────
def test_zbb_move_money(make_user):
    _uid, client = make_user()
    c_from, c_to = _spend_cats(client, 2)
    client.table("zbb_assignments").insert(
        {"category_id": c_from, "year": 2026, "month": 7, "assigned": 100}
    ).execute()

    client.rpc("zbb_move_money", {
        "p_year": 2026, "p_month": 7, "p_from": c_from, "p_to": c_to, "p_amount": 40,
    }).execute()

    rows = {r["category_id"]: float(r["assigned"]) for r in client.table("zbb_assignments")
            .select("category_id, assigned").eq("year", 2026).eq("month", 7).execute().data}
    assert rows[c_from] == 60.0, "source debited"
    assert rows[c_to] == 40.0, "dest credited (row auto-created)"

    with pytest.raises(Exception):
        client.rpc("zbb_move_money", {
            "p_year": 2026, "p_month": 7, "p_from": c_from, "p_to": c_from, "p_amount": 10,
        }).execute()
    with pytest.raises(Exception):
        client.rpc("zbb_move_money", {
            "p_year": 2026, "p_month": 7, "p_from": c_from, "p_to": c_to, "p_amount": -5,
        }).execute()


# ── 8. zbb_move_money is caller-scoped (security definer, but auth.uid()-bound) ─
def test_zbb_move_money_scoped(make_user):
    _a_id, a = make_user()
    _b_id, b = make_user()
    b_from, b_to = _spend_cats(b, 2)
    b.table("zbb_assignments").insert(
        {"category_id": b_from, "year": 2026, "month": 7, "assigned": 100}
    ).execute()

    # A calls the RPC referencing B's category ids — it runs as A, so it can only
    # create/adjust A's own rows and must never mutate B's.
    a.rpc("zbb_move_money", {
        "p_year": 2026, "p_month": 7, "p_from": b_from, "p_to": b_to, "p_amount": 10,
    }).execute()

    b_rows = {r["category_id"]: float(r["assigned"]) for r in b.table("zbb_assignments")
              .select("category_id, assigned").execute().data}
    assert b_rows[b_from] == 100.0, "B's assignment must be untouched by A's move"


# ── 9. zbb_month_overview RPC: server-side rollover chain ────────────────────
# The RPC must reproduce the pure client math (ZbbMathTests / zbb.test.ts) — the
# scenario below mirrors chainStrictCarriesParkedBalance / chainFlexibleDeficit-
# SurfacesLater / activityReducesAvailableNotRTA, plus a split transaction so
# activity provably comes from the category_spend view.
def _zbb_overview(client, year, month):
    res = client.rpc("zbb_month_overview", {"p_year": year, "p_month": month}).execute().data
    res["by_cat"] = {r["category_id"]: r for r in res["rows"]}
    return res


def test_zbb_month_overview_rpc(make_user):
    uid, client = make_user()
    acct = _account(client)
    dining, groceries = _spend_cats(client, 2)  # name-ordered: Dining, Groceries

    # Budget runs May→Jul 2026. May+Jul have explicit incomes; June falls back
    # to settings.monthly_income (800).
    client.table("zbb_settings").insert({
        "enabled": True, "rollover_mode": "strict", "monthly_income": 800,
        "budget_start_year": 2026, "budget_start_month": 5,
    }).execute()
    client.table("zbb_months").insert([
        {"year": 2026, "month": 5, "income": 1000},
        {"year": 2026, "month": 7, "income": 1200},
    ]).execute()
    client.table("zbb_assignments").insert([
        {"category_id": dining, "year": 2026, "month": 5, "assigned": 300},
        {"category_id": groceries, "year": 2026, "month": 5, "assigned": 200},
        {"category_id": dining, "year": 2026, "month": 6, "assigned": 100},
        {"category_id": groceries, "year": 2026, "month": 7, "assigned": 50},
    ]).execute()

    def txn(amount, category_id, date, exclude=False):
        return client.table("transactions").insert({
            "plaid_transaction_id": f"pt-{uuid.uuid4().hex}",
            "account_id": acct, "date": date, "amount": amount,
            "category_id": category_id, "exclude_from_totals": exclude,
        }).execute().data[0]

    # May: dining spends 100 → available 200 rolls into June.
    txn(100, dining, "2026-05-10")
    # June: dining 360 plain + 40 via split = 400 (overspends its 200+100);
    # groceries 60 via split. Excluded + income rows must not count.
    txn(360, dining, "2026-06-08")
    split_parent = txn(100, dining, "2026-06-15")
    client.table("transaction_splits").insert([
        {"transaction_id": split_parent["id"], "category_id": groceries, "amount": 60},
        {"transaction_id": split_parent["id"], "category_id": dining, "amount": 40},
    ]).execute()
    txn(999, dining, "2026-06-20", exclude=True)
    txn(-50, dining, "2026-06-21")

    # ── June (mid-chain month): rollover in, overspend out ──
    jun = _zbb_overview(client, 2026, 6)
    d, g = jun["by_cat"][dining], jun["by_cat"][groceries]
    assert float(jun["income"]) == 800.0, "June has no zbb_months row → settings.monthly_income"
    assert (d["rollover"], d["assigned"], d["activity"], d["available"]) == (200, 100, 400, -100)
    assert (g["rollover"], g["assigned"], g["activity"], g["available"]) == (200, 0, 60, 140)
    assert float(jun["total_assigned"]) == 100.0
    assert float(jun["ready_to_assign"]) == 700.0  # 800 - 100; strict: no deficit charge

    # Activity must equal the category_spend view for the same month (splits-aware).
    view = {r["category_id"]: float(r["spent"])
            for r in client.table("category_spend").select("category_id, spent")
            .eq("month", "2026-06-01").execute().data}
    assert view == {dining: 400.0, groceries: 60.0}
    assert {c: float(jun["by_cat"][c]["activity"]) for c in view} == view

    # ── July viewed, strict: June's -100 carries INSIDE dining, not against RTA ──
    jul = _zbb_overview(client, 2026, 7)
    d, g = jul["by_cat"][dining], jul["by_cat"][groceries]
    assert (d["rollover"], d["assigned"], d["activity"], d["available"]) == (-100, 0, 0, -100)
    assert (g["rollover"], g["assigned"], g["activity"], g["available"]) == (140, 50, 0, 190)
    assert float(jul["total_assigned"]) == 50.0
    assert float(jul["ready_to_assign"]) == 1150.0  # 1200 - 50
    assert {k: float(v) for k, v in jul["assignments"].items()} == {groceries: 50.0}
    s = jul["settings"]
    assert (s["enabled"], s["rollover_mode"], float(s["monthly_income"])) == (True, "strict", 800.0)
    assert (s["budget_start_year"], s["budget_start_month"]) == (2026, 5)
    # Untouched spend categories stay all-zero rows.
    assert all(r["assigned"] == 0 and r["available"] == 0
               for r in jul["rows"] if r["category_id"] not in (dining, groceries))

    # ── July viewed, flexible: the -100 is forgiven in-category but charged to RTA ──
    client.table("zbb_settings").update({"rollover_mode": "flexible"}).eq("user_id", uid).execute()
    jul_flex = _zbb_overview(client, 2026, 7)
    d, g = jul_flex["by_cat"][dining], jul_flex["by_cat"][groceries]
    assert (d["rollover"], d["available"]) == (0, 0)
    assert (g["rollover"], g["available"]) == (140, 190)
    assert float(jul_flex["ready_to_assign"]) == 1050.0  # 1200 - 50 assigned - 100 deficit

    # ── Month before budget_start collapses to a fresh single-month chain ──
    apr = _zbb_overview(client, 2026, 4)
    assert float(apr["ready_to_assign"]) == 800.0  # income fallback, nothing assigned
    assert all(r["rollover"] == 0 and r["available"] == 0 for r in apr["rows"])


# ── 10. suggest_transfers RPC: SQL matching for client suggestions ──────────
# The shared client-side matcher (migration 20260718140418). The parity
# scenario below was run through the OLD web pairSuggestions before it was
# deleted and must keep producing the identical pairs:
#   [(out2b, in2b), (out1, in1a), (out4, in4)]
def _d(days_ago):
    return (datetime.date.today() - datetime.timedelta(days=days_ago)).isoformat()


def _txns(client, acct_ids, rows):
    """Insert labelled txns; returns {label: id}. rows = (label, account_label,
    amount, days_ago, plaid_category, extra_cols)."""
    ids = {}
    for label, acct, amount, days_ago, pfc, extra in rows:
        r = client.table("transactions").insert({
            "plaid_transaction_id": f"pt-{uuid.uuid4().hex}",
            "account_id": acct_ids[acct],
            "date": _d(days_ago),
            "amount": amount,
            "plaid_category": pfc,
            "merchant_name": label,
            **extra,
        }).execute().data[0]
        ids[label] = r["id"]
    return ids


def _suggest(client, **params):
    res = client.rpc("suggest_transfers", params).execute().data
    return [(r["out_txn"], r["in_txn"], r["days_apart"]) for r in res]


def _three_accounts(client):
    return {
        "checking": _account(client, name="Checking"),
        "savings": _account(client, name="Savings", type="depository"),
        "card": _account(client, name="Card", type="credit"),
    }


def test_suggest_transfers_parity_scenario(make_user):
    """The exact dataset the old web pairSuggestions was run on (see the PR):
    closest-date-wins, ambiguous-tie skip freeing legs for a later outflow,
    LOAN_PAYMENTS tie NOT broken at the suggestions tier, window boundary in,
    out-of-window and amount-mismatch out."""
    _uid, client = make_user()
    accts = _three_accounts(client)
    ids = _txns(client, accts, [
        # closest-date-wins: out1 → in1a (1d) over in1b (4d)
        ("out1", "checking", 500.0, 8, "TRANSFER_OUT", {}),
        ("in1a", "savings", -500.0, 7, None, {}),
        ("in1b", "card", -500.0, 4, None, {}),
        # ambiguous tie for out2 (both 1d) → skip, legs stay free;
        # out2b then takes in2b (in2a is same-account for it)
        ("out2", "checking", 100.0, 13, None, {}),
        ("in2a", "savings", -100.0, 12, None, {}),
        ("in2b", "card", -100.0, 12, None, {}),
        ("out2b", "savings", 100.0, 11, None, {}),
        # LOAN_PAYMENTS equidistant credit + depository: the sync auto-linker
        # breaks this tie toward the card, but suggestions deliberately don't → skip
        ("out3", "checking", 800.0, 5, "LOAN_PAYMENTS", {}),
        ("in3a", "card", -800.0, 5, None, {}),
        ("in3b", "savings", -800.0, 5, None, {}),
        # window boundary: 4 days apart → pairs
        ("out4", "checking", 250.0, 2, None, {}),
        ("in4", "savings", -250.0, 6, None, {}),
        # out of window (8d) and amount mismatch → no pair
        ("out5", "checking", 60.0, 12, None, {}),
        ("in5", "savings", -60.0, 4, None, {}),
        ("out6", "checking", 42.0, 9, None, {}),
        ("in6", "savings", -42.5, 9, None, {}),
    ])
    got = _suggest(client)
    pairs = [(o["merchant_name"], i["merchant_name"], dd) for o, i, dd in got]
    assert pairs == [("out2b", "in2b", 1), ("out1", "in1a", 1), ("out4", "in4", 4)], \
        "must match the old web pairSuggestions output on the same dataset"
    # The embedded rows are full transactions — everything the UI renders.
    o, i, _dd = got[0]
    assert o["id"] == ids["out2b"] and i["id"] == ids["in2b"]
    for row in (o, i):
        for col in ("id", "account_id", "amount", "effective_date",
                    "merchant_name", "description", "transfer_group_id"):
            assert col in row, col
    assert float(o["amount"]) == 100.0 and float(i["amount"]) == -100.0


def test_suggest_transfers_excludes_linked_pending_hidden_optout(make_user):
    _uid, client = make_user()
    accts = _three_accounts(client)
    _txns(client, accts, [
        # already-linked pair: never suggested again
        ("l-out", "checking", 500.0, 3, None,
         {"transfer_group_id": str(uuid.uuid4()), "transfer_kind": "manual",
          "exclude_from_totals": True}),
        ("l-in", "savings", -500.0, 3, None, {}),
        # counterpart pending / hidden / opted out: outflow finds no candidate
        ("p-out", "checking", 75.0, 3, None, {}),
        ("p-in", "savings", -75.0, 3, None, {"pending": True}),
        ("h-out", "checking", 85.0, 3, None, {}),
        ("h-in", "savings", -85.0, 3, None, {"hidden": True}),
        ("o-out", "checking", 95.0, 3, None, {}),
        ("o-in", "savings", -95.0, 3, None, {"transfer_opt_out": True}),
    ])
    assert _suggest(client) == [], "linked/pending/hidden/opted-out rows never pair"
    # Lookback: the same clean pair outside the window is not scanned.
    _txns(client, accts, [
        ("old-out", "checking", 111.0, 65, None, {}),
        ("old-in", "savings", -111.0, 64, None, {}),
    ])
    assert _suggest(client) == []
    assert len(_suggest(client, p_lookback_days=90)) == 1, "wider lookback finds it"


def test_suggest_transfers_rls_isolation(make_user):
    _a_id, a = make_user()
    _b_id, b = make_user()
    accts = _three_accounts(a)
    _txns(a, accts, [
        ("a-out", "checking", 200.0, 3, None, {}),
        ("a-in", "savings", -200.0, 2, None, {}),
    ])
    assert len(_suggest(a)) == 1
    assert _suggest(b) == [], "B must see none of A's suggestions"


def test_zbb_month_overview_rpc_rls(make_user):
    a_id, a = make_user()
    _b_id, b = make_user()
    a_cat, = _spend_cats(a, 1)

    a.table("zbb_settings").insert({
        "enabled": True, "monthly_income": 1000,
        "budget_start_year": 2026, "budget_start_month": 7,
    }).execute()
    a.table("zbb_assignments").insert(
        {"category_id": a_cat, "year": 2026, "month": 7, "assigned": 300}).execute()

    # B (no zbb data) sees only zeros — none of A's assignments, income, or categories.
    res = _zbb_overview(b, 2026, 7)
    assert float(res["ready_to_assign"]) == 0.0
    assert float(res["total_assigned"]) == 0.0
    assert res["assignments"] == {}
    assert a_cat not in res["by_cat"], "B must not see A's categories"
    assert all(r["assigned"] == 0 and r["activity"] == 0 and r["available"] == 0
               for r in res["rows"])
    assert res["settings"]["enabled"] is False and float(res["settings"]["monthly_income"]) == 0.0

    # A still computes its own numbers.
    mine = _zbb_overview(a, 2026, 7)
    assert float(mine["ready_to_assign"]) == 700.0
    assert float(mine["by_cat"][a_cat]["assigned"]) == 300.0


# ── 11. search_transactions RPC: server-side transaction search ──────────────
# Migration 20260719163154. Returns matching ids only (newest first); clients
# re-fetch full rows with their usual embedded selects.
def _search(client, q, **params):
    res = client.rpc("search_transactions", {"p_query": q, **params}).execute().data
    return [r["id"] for r in res]


def test_search_transactions_matching(make_user):
    _uid, client = make_user()
    accts = {"checking": _account(client)}
    ids = _txns(client, accts, [
        ("Starbucks", "checking", 6.5, 1, None, {}),
        ("Whole Foods Market", "checking", 82.13, 2, None,
         {"notes": "weekly groceries"}),
        ("Shell", "checking", 42.5, 3, None, {"description": "SHELL OIL 5731"}),
    ])
    # case-insensitive substring on merchant_name
    assert _search(client, "starbu") == [ids["Starbucks"]]
    # description and notes are searched too
    assert _search(client, "oil 57") == [ids["Shell"]]
    assert _search(client, "groceries") == [ids["Whole Foods Market"]]
    # trigram typo tolerance (word_similarity >= 0.4)
    assert _search(client, "strabucks") == [ids["Starbucks"]]
    # numeric query matches |amount|, tolerating "$" and commas
    assert _search(client, "$42.50") == [ids["Shell"]]
    # blank query returns nothing rather than everything
    assert _search(client, "   ") == []
    # LIKE wildcards are matched literally, not as "match anything"
    assert _search(client, "%") == []
    assert _search(client, "_") == []


def test_search_transactions_order_and_limit(make_user):
    _uid, client = make_user()
    accts = {"checking": _account(client)}
    ids = _txns(client, accts, [
        ("Cafe older", "checking", 5.0, 9, None, {}),
        ("Cafe newer", "checking", 7.0, 2, None, {}),
    ])
    assert _search(client, "cafe") == [ids["Cafe newer"], ids["Cafe older"]], \
        "newest effective_date first (day-grouped UIs assume this)"
    assert _search(client, "cafe", p_limit=1) == [ids["Cafe newer"]]


def test_search_transactions_rls_isolation(make_user):
    _a_id, a = make_user()
    _b_id, b = make_user()
    accts = {"checking": _account(a)}
    _txns(a, accts, [("Secret Merchant", "checking", 12.0, 1, None, {})])
    assert len(_search(a, "secret")) == 1
    assert _search(b, "secret") == [], "B must not see A's transactions"
