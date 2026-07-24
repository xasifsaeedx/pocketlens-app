"""Digest cron (Phase B).

Runs from the `pocketlens-sync` cron (see render.yaml), which now fires **twice**
a day (09:00 and 21:00 UTC — morning and late-afternoon ET). Digests are a
morning thing: `is_digest_run` gates `__main__` so only the ~5am ET run emits
them, and the afternoon run is sync/reconcile only. Dedup by `dedup_key` is the
backstop, not the mechanism.

On a digest run every emission is for `yesterday`; the weekly/monthly
`periodic_digest`s are gated inside run_digests by weekday / day-of-month, so
the one cron drives all three cadences:

  * daily_spend      — yesterday's total spend, every digest run.
  * periodic_digest  — weekly on Monday (trailing 7 days), monthly on the 1st
                       (the previous calendar month).

Money math reuses alerts' semantics (positive amount == spend; exclude pending
and exclude_from_totals), consistent with the category_spend view and the
clients. Dedup + lazy-default prefs reuse the alerts helpers, so a digest fires
at most once per user per period and respects a user's disabled pref.
"""
import datetime
import logging
from zoneinfo import ZoneInfo

from alerts import _insert_new, _load_prefs, _money, _pref_for

logger = logging.getLogger('digests')

# Digests are dated and worded in the user-facing timezone (the app's audience is
# US Eastern), so "yesterday" and "is this the morning run?" are both answered in
# ET rather than UTC. ZoneInfo handles DST, so the 09:00 UTC run is 5am EDT /
# 4am EST and the 21:00 UTC run is 5pm EDT / 4pm EST.
DIGEST_TZ = ZoneInfo('America/New_York')

# Any run landing before local noon is the morning run. A wide window, not an
# equality check on the hour: a delayed or retried cron start still counts, and
# the schedule can shift within the morning without silently dropping digests.
DIGEST_CUTOFF_HOUR = 12


def is_digest_run(now) -> bool:
    """True only for the morning (~5am ET) cron run. The afternoon run syncs and
    reconciles but must not emit digests — a user should get one daily spend
    notification a day, in the morning. `now` must be timezone-aware."""
    return now.astimezone(DIGEST_TZ).hour < DIGEST_CUTOFF_HOUR


def _spend_by_user(supabase, start, end) -> dict:
    """Total spend per user over [start, end] (inclusive), by effective_date —
    the same date column category_spend groups on. One query, aggregated in
    Python. Splits don't affect a *total* (a split parent keeps its full amount),
    so summing transaction amounts is correct without expanding splits."""
    rows = supabase.table('transactions') \
        .select('user_id, amount, pending, exclude_from_totals, effective_date') \
        .gte('effective_date', start.isoformat()) \
        .lte('effective_date', end.isoformat()) \
        .execute().data
    totals = {}
    for t in rows:
        if t.get('pending') or t.get('exclude_from_totals'):
            continue
        amt = float(t['amount'] or 0)
        if amt > 0:
            totals[t['user_id']] = totals.get(t['user_id'], 0.0) + amt
    return totals


def _daily_spend(supabase, day) -> None:
    ymd = day.isoformat()
    for uid, total in _spend_by_user(supabase, day, day).items():
        if total <= 0:
            continue
        enabled, _cfg = _pref_for(_load_prefs(supabase, uid), 'daily_spend')
        if not enabled:
            continue
        _insert_new(supabase, uid, [{
            'type': 'daily_spend',
            'title': 'Daily spending',
            'body': f"You spent {_money(total)} on {day:%b %-d}.",
            'payload': {'date': ymd, 'total': round(total, 2)},
            'dedup_key': f"daily_spend:{uid}:{ymd}",
        }])


def _periodic(supabase, cadence, start, end, period_key) -> None:
    for uid, total in _spend_by_user(supabase, start, end).items():
        if total <= 0:
            continue
        enabled, _cfg = _pref_for(_load_prefs(supabase, uid), 'periodic_digest')
        if not enabled:
            continue
        _insert_new(supabase, uid, [{
            'type': 'periodic_digest',
            'title': f"{cadence.capitalize()} summary",
            'body': f"You spent {_money(total)} ({start:%b %-d}–{end:%b %-d}).",
            'payload': {'cadence': cadence, 'start': start.isoformat(),
                        'end': end.isoformat(), 'total': round(total, 2)},
            'dedup_key': f"periodic_digest:{uid}:{cadence}:{period_key}",
        }])


def run_digests(supabase, *, today) -> None:
    """Emit the daily digest, plus the weekly/monthly ones when today's date
    lands on their cadence boundary. `today` is injected for testability."""
    yesterday = today - datetime.timedelta(days=1)
    _daily_spend(supabase, yesterday)

    if today.weekday() == 0:   # Monday → trailing 7 days [today-7, yesterday]
        start = today - datetime.timedelta(days=7)
        # ISO week of the week that just ended.
        period_key = yesterday.strftime('%G-W%V')
        _periodic(supabase, 'weekly', start, yesterday, period_key)

    if today.day == 1:         # 1st → the previous calendar month
        last_month_end = today - datetime.timedelta(days=1)
        last_month_start = last_month_end.replace(day=1)
        period_key = last_month_start.strftime('%Y-%m')
        _periodic(supabase, 'monthly', last_month_start, last_month_end, period_key)


if __name__ == '__main__':
    from logging_setup import setup_logging
    from supabase_client import get_supabase
    setup_logging()
    now = datetime.datetime.now(datetime.timezone.utc)
    if is_digest_run(now):
        run_digests(get_supabase(), today=now.astimezone(DIGEST_TZ).date())
    else:
        logger.info('skipping digests: not the morning run (%s ET)',
                    now.astimezone(DIGEST_TZ).strftime('%Y-%m-%d %H:%M'))
