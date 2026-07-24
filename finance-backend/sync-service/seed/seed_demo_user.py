"""
Seed a self-contained DEMO user with realistic fake finances.

Purpose: log in as this user to demo the app without exposing real personal data.
Everything is scoped to the demo user's auth.users id, so it is fully isolated by
RLS from any real account and can be wiped by deleting the auth user (cascades).

Usage:
    cd finance-backend/sync-service
    python3 seed/seed_demo_user.py            # create/refresh the demo user + data
    python3 seed/seed_demo_user.py --delete   # remove the demo user + all its data

Login (in the iOS app):
    email:    demo@pocketlens.app
    password: demofinance123

Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in .env (already used by the sync
service). Service role bypasses RLS, so we stamp user_id explicitly on every row
(client inserts normally rely on the auth.uid() default, which is null here).
"""

import os
import random
import sys
from datetime import date

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from supabase_client import get_supabase  # noqa: E402

DEMO_EMAIL = "demo@pocketlens.app"
DEMO_PASSWORD = "demofinance123"

TODAY = date(2026, 7, 2)          # keep deterministic; app's "today" per memory
START = date(2026, 3, 1)          # ~4 months of history
rng = random.Random(42)           # reproducible fake data


# ── user lifecycle ────────────────────────────────────────────────────────
def find_demo_user(sb):
    # admin.list_users paginates; scan for our email.
    page = 1
    while True:
        users = sb.auth.admin.list_users(page=page, per_page=200)
        if not users:
            return None
        for u in users:
            if (u.email or "").lower() == DEMO_EMAIL:
                return u
        if len(users) < 200:
            return None
        page += 1


def delete_demo_user(sb):
    existing = find_demo_user(sb)
    if existing:
        # on delete cascade wipes every user-owned row.
        sb.auth.admin.delete_user(existing.id)
        print(f"deleted demo user {existing.id} (+ all its data)")
    else:
        print("no demo user to delete")


def create_demo_user(sb):
    # email_confirm=True so sign-in works even if confirmations are enabled.
    res = sb.auth.admin.create_user({
        "email": DEMO_EMAIL,
        "password": DEMO_PASSWORD,
        "email_confirm": True,
        "user_metadata": {"full_name": "Alex Demo", "is_demo": True},
    })
    uid = res.user.id
    print(f"created demo user {uid} ({DEMO_EMAIL})")
    return uid


# ── data ──────────────────────────────────────────────────────────────────
def get_categories(sb, uid):
    # The on_auth_user_created trigger seeds default categories for the new user.
    rows = sb.table("categories").select("id, name").eq("user_id", uid).execute().data
    return {r["name"]: r["id"] for r in rows}


def seed_accounts(sb, uid):
    """A Plaid item + 4 accounts. Returns {key: account_id} and target balances."""
    item = sb.table("plaid_items").insert({
        "user_id": uid,
        "plaid_item_id": f"demo-item-{uid[:8]}",
        "access_token": "demo-access-token-not-real",
        "institution_id": "ins_demo",
        "institution_name": "Demo Bank",
        "is_active": True,
    }).execute().data[0]
    item_id = item["id"]

    specs = [
        # key         name                  type          subtype        mask   order  balance
        ("checking",  "Everyday Checking",  "depository", "checking",    "4821", 0,   4_285.63),
        ("savings",   "High-Yield Savings", "depository", "savings",     "7730", 1,  18_500.00),
        ("brokerage", "Brokerage",          "investment", "brokerage",   "0091", 2,  32_140.00),
        ("credit",    "Sapphire Card",      "credit",     "credit card", "1188", 3,   1_243.57),
    ]
    accounts, balances = {}, {}
    for key, name, typ, subtype, mask, order, bal in specs:
        row = sb.table("accounts").insert({
            "user_id": uid,
            "plaid_account_id": f"demo-acct-{key}-{uid[:8]}",
            "plaid_item_id": item_id,
            "name": name,
            "type": typ,
            "subtype": subtype,
            "mask": mask,
            "currency": "USD",
            "is_active": True,
            "display_order": order,
        }).execute().data[0]
        accounts[key] = row["id"]
        balances[key] = bal
    print(f"seeded {len(accounts)} accounts")
    return accounts, balances


# merchant pools per category (positive amount = money out; income is negative)
SPEND = {
    "Groceries": (["Whole Foods", "Trader Joe's", "Safeway", "Costco"], 28, 180),
    "Dining":    (["Chipotle", "Starbucks", "Sweetgreen", "Shake Shack", "DoorDash", "Blue Bottle"], 9, 65),
    "Transport": (["Uber", "Lyft", "Shell", "Chevron", "BART"], 6, 55),
    "Other":     (["Amazon", "Target", "Netflix", "Spotify", "Apple"], 10, 120),
}
FIXED = {  # charged monthly on checking
    "Rent":      ("Sunset Apartments", 2450.00, 1),
    "Utilities": ("PG&E", 145.00, 8),
}
UTIL_EXTRA = [("Comcast Xfinity", 89.99, 12), ("AT&T Wireless", 75.00, 18)]

# Uncategorized: seeded with a null category_id so they surface in the
# swipe-to-categorize review flow. Each carries a Plaid PFC (primary, detail)
# pair so CategorySuggester guesses a *varied* category to confirm or correct;
# the trailing None/None ones are ambiguous and fall back to "Other".
#           merchant                primary                detail
UNCATEGORIZED = [
    ("SQ *CORNER MARKET",  "FOOD_AND_DRINK",     "FOOD_AND_DRINK_GROCERIES"),
    ("BLUE BOTTLE COFFEE", "FOOD_AND_DRINK",     "FOOD_AND_DRINK_COFFEE"),
    ("SHELL OIL 57721",    "TRANSPORTATION",     "TRANSPORTATION_GAS"),
    ("MTA*NYCT SUBWAY",    "TRANSPORTATION",     "TRANSPORTATION_PUBLIC_TRANSIT"),
    ("PG&E WEB ONLINE",    "RENT_AND_UTILITIES", None),
    ("VENMO PAYMENT",       None,                 None),
    ("PAYPAL *ETSY",        None,                 None),
    ("CVS/PHARMACY #4471",  None,                 None),
]


def seed_transactions(sb, uid, accounts, categories):
    txns = []
    seq = 0

    def add(acct_key, d, amount, merchant, cat_name,
            plaid_category=None, plaid_category_detail=None):
        nonlocal seq
        seq += 1
        txns.append({
            "user_id": uid,
            "plaid_transaction_id": f"demo-txn-{uid[:8]}-{seq:04d}",
            "account_id": accounts[acct_key],
            "date": d.isoformat(),
            "authorized_date": d.isoformat(),
            "amount": round(amount, 2),
            "merchant_name": merchant,
            "description": merchant,
            "category_id": categories.get(cat_name),
            "plaid_category": plaid_category,
            "plaid_category_detail": plaid_category_detail,
            "pending": False,
        })

    # iterate month by month
    m = date(START.year, START.month, 1)
    while m <= TODAY:
        # income: biweekly-ish salary on the 1st and 15th (credited to checking)
        for day in (1, 15):
            pay_d = date(m.year, m.month, day)
            if START <= pay_d <= TODAY:
                add("checking", pay_d, -2650.00, "Acme Corp Payroll", "Income")

        # fixed bills on checking
        for cat_name, (merchant, amt, dom) in FIXED.items():
            d = date(m.year, m.month, dom)
            if START <= d <= TODAY:
                add("checking", d, amt, merchant, cat_name)
        for merchant, amt, dom in UTIL_EXTRA:
            d = date(m.year, m.month, dom)
            if START <= d <= TODAY:
                add("checking", d, amt, merchant, "Utilities")

        # variable spend on the credit card, spread through the month
        for cat_name, (merchants, lo, hi) in SPEND.items():
            n = rng.randint(4, 9)
            for _ in range(n):
                dom = rng.randint(1, 28)
                d = date(m.year, m.month, dom)
                if not (START <= d <= TODAY):
                    continue
                amt = round(rng.uniform(lo, hi), 2)
                add("credit", d, amt, rng.choice(merchants), cat_name)

        # uncategorized spend: a few per month, null category_id (cat_name=None)
        # so they land in the swipe-to-categorize review flow.
        for _ in range(rng.randint(3, 5)):
            dom = rng.randint(1, 28)
            d = date(m.year, m.month, dom)
            if not (START <= d <= TODAY):
                continue
            amt = round(rng.uniform(8, 140), 2)
            acct = rng.choice(("credit", "checking"))
            merchant, pri, det = rng.choice(UNCATEGORIZED)
            add(acct, d, amt, merchant, None,
                plaid_category=pri, plaid_category_detail=det)

        # advance one month
        m = date(m.year + (m.month // 12), (m.month % 12) + 1, 1)

    sb.table("transactions").insert(txns).execute()
    print(f"seeded {len(txns)} transactions")


def seed_balance_and_networth(sb, uid, accounts, balances):
    """Monthly balance-history points (trending to current) + net-worth snapshots."""
    # month starts from START to TODAY, plus TODAY itself as the latest point.
    months = []
    m = date(START.year, START.month, 1)
    while m <= TODAY:
        months.append(m)
        m = date(m.year + (m.month // 12), (m.month % 12) + 1, 1)
    points = months + [TODAY]
    n = len(points)

    # linear ramp so the latest point equals the target current balance.
    def ramp(target, start_frac):
        start = target * start_frac
        return [round(start + (target - start) * i / (n - 1), 2) for i in range(n)]

    trajectories = {
        "checking":  ramp(balances["checking"], 0.85),
        "savings":   ramp(balances["savings"], 0.72),
        "brokerage": ramp(balances["brokerage"], 0.80),
        "credit":    ramp(balances["credit"], 1.15),   # debt trending down
    }

    bal_rows, snap_rows = [], []
    for i, d in enumerate(points):
        assets = 0.0
        liabilities = 0.0
        for key, acct_id in accounts.items():
            val = trajectories[key][i]
            bal_rows.append({
                "user_id": uid,
                "account_id": acct_id,
                "date": d.isoformat(),
                "current_balance": val,
                "available_balance": val,
            })
            if key == "credit":
                liabilities += val
            else:
                assets += val
        snap_rows.append({
            "user_id": uid,
            "date": d.isoformat(),
            "total_assets": round(assets, 2),
            "total_liabilities": round(liabilities, 2),
        })

    # dedupe (account_id,date) and (user_id,date) — points[-1] may equal a month start
    sb.table("account_balance_history").upsert(
        bal_rows, on_conflict="account_id,date").execute()
    sb.table("net_worth_snapshots").upsert(
        snap_rows, on_conflict="user_id,date").execute()
    net = snap_rows[-1]["total_assets"] - snap_rows[-1]["total_liabilities"]
    print(f"seeded {len(bal_rows)} balance rows, {len(snap_rows)} net-worth snapshots "
          f"(current net worth ≈ ${net:,.2f})")


def seed_budgets(sb, uid, categories):
    limits = {"Groceries": 600, "Dining": 400, "Transport": 250,
              "Rent": 2450, "Utilities": 350, "Other": 500}
    rows = [{"user_id": uid, "category_id": categories[name], "monthly_limit": amt,
             "is_active": True}
            for name, amt in limits.items() if name in categories]
    sb.table("budgets").upsert(rows, on_conflict="user_id,category_id").execute()
    print(f"seeded {len(rows)} budgets")


def main():
    sb = get_supabase()

    if "--delete" in sys.argv:
        delete_demo_user(sb)
        return

    # idempotent: wipe any prior demo user, then rebuild fresh
    delete_demo_user(sb)
    uid = create_demo_user(sb)

    categories = get_categories(sb, uid)
    if "Income" not in categories:
        raise SystemExit("expected default categories (trigger) not found for demo user")

    accounts, balances = seed_accounts(sb, uid)
    seed_transactions(sb, uid, accounts, categories)
    seed_balance_and_networth(sb, uid, accounts, balances)
    seed_budgets(sb, uid, categories)

    print("\n✅ demo user ready")
    print(f"   email:    {DEMO_EMAIL}")
    print(f"   password: {DEMO_PASSWORD}")


if __name__ == "__main__":
    main()
