"""
One-time net-worth history backfill, reconstructed from the transaction ledger.

Plaid only ever returns each account's *current* balance — it has no historical
balances — so `net_worth_snapshots` normally starts empty and gains just one
point per day going forward (see `write_net_worth_snapshot`). New users stare at
"Not enough history yet" until enough days accrue. This job fills in the past by
walking today's balance backward through the transactions we already pull (up to
730 days):

    balance(end of day D) = current_balance ± sum(transactions dated after D)

That is *exact* for accounts whose balance is fully explained by their ledger
(depository, credit) and for manual "separate" accounts (which carry a dated
value ledger). Investment and loan balances move with market prices / interest
accrual that no transaction records, so those are held flat at their current
balance and flagged — their contribution to older snapshots is approximate.

The net-worth math mirrors `write_net_worth_snapshot` exactly (assets vs
liabilities, negative balances clamp to 0, active accounts only), so a
reconstructed "today" equals the live snapshot. Existing snapshots are never
overwritten — only missing days are filled — so any real history you already
recorded wins over a reconstruction.

Runs once per user: if the window's oldest day already has a snapshot, the whole
reconstruction is skipped (one indexed lookup), so this is cheap to call on every
sync. `--dry-run` ignores the skip and always reports.

New links and app-triggered refreshes backfill automatically — `_finalize_user`
calls `backfill_user` (see sync.py). This CLI is a manual/ops lever and the
catch-up for users who linked before that hook shipped.

Usage: python backfill_net_worth.py [--days N] [--dry-run]
  --days N    how far back to reconstruct (default 730 — Plaid's max txn window)
  --dry-run   report what would be written without touching the database
"""
import argparse
import datetime
from collections import defaultdict
from decimal import Decimal

from sync import is_liability

# A Plaid account's balance is fully explained by its transaction ledger only
# for these types, so reconstruction is exact. Everything else (investment:
# market-priced; loan: interest accrual) is held flat at its current balance
# and flagged — the ledger can't reproduce those moves.
RECONSTRUCTABLE_TYPES = ('depository', 'credit')

# Plaid's maximum transaction window (see LinkTokenTransactions in api.py), so
# the furthest back a reconstruction can reach.
DEFAULT_DAYS = 730

_DAY = datetime.timedelta(days=1)


def _dec(x) -> Decimal:
    """Money as Decimal, via str so floats don't leak binary noise."""
    return Decimal(str(x if x is not None else 0))


def _day(s) -> datetime.date:
    return datetime.date.fromisoformat(str(s)[:10])


def _plaid_daily_balance(current, sign, deltas, days):
    """End-of-day balance for a Plaid account across `days` (oldest-first).

    Walks today's balance backward: undoing day D's transactions recovers the
    balance at the end of D-1. `sign` is +1 for assets, -1 for liabilities —
    Plaid amounts are positive when money leaves the account, which lowers a
    cash balance but raises what a card owes.
    """
    out = {}
    bal = current
    for d in reversed(days):           # today → start
        out[d] = bal
        bal = bal + sign * deltas.get(d, Decimal(0))
    return out


def _separate_daily_balance(values, days):
    """End-of-day balance for a manual account: cumulative sum of its dated
    ledger (entries dated on/before the window start seed the opening balance)."""
    start = days[0]
    opening = Decimal(0)
    by_day = defaultdict(Decimal)
    for v in values:
        vd, amt = _day(v['date']), _dec(v['amount'])
        if vd < start:
            opening += amt
        else:
            by_day[vd] += amt
    out = {}
    running = opening
    for d in days:                     # start → today
        running += by_day.get(d, Decimal(0))
        out[d] = running
    return out


def _fold(daily_balance, liability, assets, liabilities, days):
    """Add one account's daily balances into the running asset/liability totals,
    clamping negatives to 0 exactly as `write_net_worth_snapshot` does."""
    bucket = liabilities if liability else assets
    for d in days:
        bucket[d] += max(daily_balance[d], Decimal(0))


def _transaction_deltas(supabase, account_id, start):
    """Posted transactions for an account within the window, summed per day.

    Pending rows are excluded to match Plaid's `current_balance` (posted only)."""
    rows = supabase.table('transactions') \
        .select('date, amount') \
        .eq('account_id', account_id) \
        .eq('pending', False) \
        .gte('date', start.isoformat()) \
        .execute().data
    deltas = defaultdict(Decimal)
    for r in rows:
        deltas[_day(r['date'])] += _dec(r['amount'])
    return deltas


def reconstruct_history(supabase, user_id, days, today):
    """Reconstruct daily net worth for `user_id` over the last `days`.

    Returns (snapshots, flagged):
      snapshots — [{'date','total_assets','total_liabilities'}] oldest-first,
                  one row per day in [today - days, today] inclusive.
      flagged   — [(name, type)] accounts held flat because their balance can't
                  be reconstructed from the ledger.
    """
    start = today - days * _DAY
    day_list = [start + i * _DAY for i in range(days + 1)]
    assets = defaultdict(Decimal)
    liabilities = defaultdict(Decimal)
    flagged = []

    # ── Plaid accounts: current balance (per the same view the writer reads) ──
    balances = supabase.table('latest_balances') \
        .select('account_id, current_balance') \
        .eq('user_id', user_id).execute().data
    accounts = supabase.table('accounts') \
        .select('id, name, type, is_active') \
        .eq('user_id', user_id).eq('is_active', True).execute().data
    acct_by_id = {a['id']: a for a in accounts}

    for row in balances:
        acct = acct_by_id.get(row['account_id'])
        if acct is None:
            continue                   # inactive / removed — excluded, like the writer
        liability = is_liability(acct['type'])
        sign = Decimal(-1) if liability else Decimal(1)
        if acct['type'] in RECONSTRUCTABLE_TYPES:
            deltas = _transaction_deltas(supabase, acct['id'], start)
        else:
            deltas = {}                # held flat at current balance
            flagged.append((acct.get('name') or acct['id'], acct['type']))
        daily = _plaid_daily_balance(_dec(row['current_balance']), sign, deltas, day_list)
        _fold(daily, liability, assets, liabilities, day_list)

    # ── Manual "separate" accounts: dated ledger → always reconstructable ──
    sep_accounts = supabase.table('separate_accounts') \
        .select('id, type, is_active') \
        .eq('user_id', user_id).eq('is_active', True).execute().data
    for acct in sep_accounts:
        values = supabase.table('separate_account_values') \
            .select('date, amount') \
            .eq('separate_account_id', acct['id']).execute().data
        daily = _separate_daily_balance(values, day_list)
        _fold(daily, is_liability(acct['type']), assets, liabilities, day_list)

    snapshots = [{
        'date': d.isoformat(),
        'total_assets': float(assets[d]),
        'total_liabilities': float(liabilities[d]),
    } for d in day_list]
    return snapshots, flagged


def _already_backfilled(supabase, user_id, start, dry_run):
    """True if the window's oldest day already has a snapshot — the signal that
    a backfill ran before (it writes every day in the window). One indexed
    lookup, so a routine refresh short-circuits here instead of re-pulling every
    account's transactions. Skipped for --dry-run so it always reports the work."""
    if dry_run:
        return False
    return bool(supabase.table('net_worth_snapshots').select('date')
                .eq('user_id', user_id).eq('date', start).limit(1).execute().data)


def backfill_user(supabase, user_id, days, today, dry_run):
    """Reconstruct and fill missing snapshot days for one user, once. Returns a
    per-user summary dict. Never overwrites an existing snapshot, and skips the
    whole reconstruction if history already spans the window (see
    `_already_backfilled`) so repeated calls are cheap."""
    start = (today - days * _DAY).isoformat()
    if _already_backfilled(supabase, user_id, start, dry_run):
        return {'filled': 0, 'flagged': [], 'skipped': True}

    snapshots, flagged = reconstruct_history(supabase, user_id, days, today)
    existing = {r['date'][:10] for r in supabase.table('net_worth_snapshots')
                .select('date').eq('user_id', user_id).execute().data}
    missing = [s for s in snapshots if s['date'] not in existing]

    if not dry_run and missing:
        rows = [{'user_id': user_id, **s} for s in missing]
        for i in range(0, len(rows), 500):
            supabase.table('net_worth_snapshots').upsert(
                rows[i:i + 500], on_conflict='user_id,date', ignore_duplicates=True
            ).execute()

    return {'filled': len(missing), 'flagged': flagged, 'skipped': False}


def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--days', type=int, default=DEFAULT_DAYS,
                    help=f'how far back to reconstruct (default {DEFAULT_DAYS})')
    ap.add_argument('--dry-run', action='store_true',
                    help='report without writing')
    args = ap.parse_args()

    from supabase_client import get_supabase
    supabase = get_supabase()
    today = datetime.date.today()

    # Users with linked banks *or* only manual accounts both have net worth.
    items = supabase.table('plaid_items').select('user_id').eq('is_active', True).execute().data
    sep = supabase.table('separate_accounts').select('user_id').eq('is_active', True).execute().data
    user_ids = sorted({r['user_id'] for r in items} | {r['user_id'] for r in sep})

    grand = 0
    for uid in user_ids:
        res = backfill_user(supabase, uid, args.days, today, args.dry_run)
        grand += res['filled']
        if res['skipped']:
            print(f"→ {uid}: already backfilled — skipped")
            continue
        verb = 'would fill' if args.dry_run else 'filled'
        print(f"→ {uid}: {verb} {res['filled']} day(s)")
        for name, typ in res['flagged']:
            print(f"    ⚠ held flat (not reconstructable from ledger): {name} [{typ}]")

    verb = 'Would backfill' if args.dry_run else 'Backfilled'
    print(f"{verb} {grand} snapshot-day(s) across {len(user_ids)} user(s).")


if __name__ == '__main__':
    main()
