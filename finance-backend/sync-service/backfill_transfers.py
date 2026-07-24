"""
One-time transfer-detection backfill over full transaction history.

Incremental syncs only look LOOKBACK_DAYS back (see transfers.py); this runs
the same detector with full=True for every active user so historical
credit-card payments and account moves get linked/excluded retroactively.

Safe to re-run: the detector only touches unlinked (or one-sided) rows and
never rows the user opted out of.

Usage: python backfill_transfers.py [--dry-run] [--pairs-only]
  --dry-run     report what would be linked without writing anything
  --pairs-only  link two-leg pairs only; skip one-sided exclusions (lone
                Plaid-flagged legs like Zelle/Venmo/ATM), which bulk-shift
                historical totals and are better reviewed in the web UI
"""
import sys

from supabase_client import get_supabase
from transfers import detect_transfers


def main():
    dry_run = '--dry-run' in sys.argv
    pairs_only = '--pairs-only' in sys.argv
    supabase = get_supabase()

    items = supabase.table('plaid_items').select('user_id').eq('is_active', True).execute().data
    user_ids = sorted({i['user_id'] for i in items})

    total = {'linked': 0, 'one_sided': 0}
    for uid in user_ids:
        stats = detect_transfers(supabase, uid, full=True, dry_run=dry_run,
                                 include_one_sided=not pairs_only)
        total['linked'] += stats['linked']
        total['one_sided'] += stats['one_sided']
        print(f"→ {uid}: {stats['linked']} pair(s), {stats['one_sided']} one-sided")

    print(f"{'Would link' if dry_run else 'Done'}: {total['linked']} pair(s), "
          f"{total['one_sided']} one-sided across {len(user_ids)} user(s)")


if __name__ == '__main__':
    main()
