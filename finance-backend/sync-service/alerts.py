"""Alert evaluation engine (Phase B).

A pure-ish, testable core that runs after a user's sync
(`evaluate_user_alerts`) and inserts `notifications` rows for the alert types
that fire. Best-effort by contract: the caller in sync._finalize_user wraps this
so a failure here never breaks a sync.

Design notes
------------
* Lazy defaults — a user with no `notification_prefs` row for a type is treated
  as ENABLED with DEFAULTS[type]. Nothing seeds prefs at signup; absence == on.
  A pref row overrides `enabled` and merges its `config` over the defaults.
* Dedup — the `notifications` partial unique index
  `(user_id, dedup_key) WHERE dedup_key is not null` is a predicate (partial)
  index, so PostgREST `on_conflict` can't target it. Instead we read the
  existing dedup_keys for this user, drop candidates that already fired, and
  batch-insert the rest. Belt-and-suspenders: a race that still trips the unique
  index is swallowed (per-row retry), never fatal to the sync.

The money math (positive amount == spend, exclude pending / exclude_from_totals)
mirrors the category_spend view and the clients; the digest module reuses these
helpers.
"""
import datetime
import logging

logger = logging.getLogger('alerts')

# Per-type default thresholds. A notification_prefs row's `config` merges OVER
# these; a user with no row at all still gets the defaults (enabled). Types with
# no threshold (sync_failed / the cron digests) carry {} so _pref_for treats a
# missing row as enabled with an empty config.
DEFAULTS = {
    'budget_threshold': {'pct': 90},
    'large_charge': {'amount': 200},
    'low_balance': {'amount': 100},
    'sync_failed': {},
    'daily_spend': {},
    'periodic_digest': {},
    # TODO: bill_due — deferred. Needs recurring-debit prediction that
    # isn't modeled server-side yet. Extension point: add a DEFAULTS entry here
    # (e.g. {"days": 3}) and a `_bill_due_candidates(...)` builder wired into
    # evaluate_user_alerts below, once predicted bills exist.
}


# large_charge is "a big charge *just* posted", not "you once spent big". On a
# first link the sync ingests full history in one run, so every historical row's
# created_at lands inside this run's `since` window — bounding on created_at
# alone would fire an alert per historical charge (a first-link flood), and the
# reconcile path (since=None) would re-scan all history. So also require the
# charge to be recent by effective_date. 7 days covers authorized→posted lag and
# a weekend of missed webhooks the daily cron catches up on.
LARGE_CHARGE_LOOKBACK_DAYS = 7


# A connection that keeps failing shouldn't nag once per day. Bucketing the
# sync_failed dedup key into fixed-width windows lets a persistent failure remind
# the user at most once per window, then again after it lapses — a cooldown,
# without needing to track per-item alert state. See _sync_failed_candidates.
SYNC_FAILED_COOLDOWN_DAYS = 3


def _money(amount) -> str:
    return f"${float(amount):,.2f}"


def _is_liability(account_type) -> bool:
    """Mirrors sync.is_liability: credit/loan balances are debts, so a *low*
    balance on them isn't a concern. Inlined to keep alerts.py free of sync.py's
    (heavy, Plaid-importing) module graph."""
    return account_type in ('credit', 'loan')


# ── preferences ──────────────────────────────────────────────────────────────
def _load_prefs(supabase, user_id) -> dict:
    rows = supabase.table('notification_prefs') \
        .select('type, enabled, config') \
        .eq('user_id', user_id) \
        .execute().data
    return {r['type']: r for r in rows}


def _pref_for(prefs: dict, type_: str):
    """(enabled, config) for a type. No row → enabled with DEFAULTS (lazy)."""
    row = prefs.get(type_)
    defaults = dict(DEFAULTS.get(type_, {}))
    if row is None:
        return True, defaults
    config = {**defaults, **(row.get('config') or {})}
    return bool(row.get('enabled', True)), config


# ── candidate builders (each returns a list of notification dicts sans user_id) ─
def _budget_threshold_candidates(supabase, user_id, config, today) -> list:
    pct = float(config.get('pct', 90))
    month_first = today.replace(day=1).isoformat()   # 'YYYY-MM-01'
    ym = today.strftime('%Y-%m')

    # As-of limits: newest effective_month <= this month, per category.
    limit_rows = supabase.table('budget_limits') \
        .select('category_id, effective_month, monthly_limit') \
        .eq('user_id', user_id) \
        .lte('effective_month', month_first) \
        .execute().data
    limit_by_cat = {}
    for r in limit_rows:
        cur = limit_by_cat.get(r['category_id'])
        if cur is None or r['effective_month'] > cur['effective_month']:
            limit_by_cat[r['category_id']] = r

    # Month-to-date spend from the shared category_spend view (splits-aware,
    # exclude_from_totals-aware — the one source of truth both clients read).
    spend_rows = supabase.table('category_spend') \
        .select('category_id, spent') \
        .eq('user_id', user_id) \
        .eq('month', month_first) \
        .execute().data
    spend_by_cat = {r['category_id']: float(r['spent'] or 0) for r in spend_rows}

    out = []
    for cat_id, lim in limit_by_cat.items():
        monthly_limit = float(lim['monthly_limit'] or 0)
        if monthly_limit <= 0:
            continue   # 0 == explicitly unbudgeted
        spent = spend_by_cat.get(cat_id, 0.0)
        if spent >= (pct / 100.0) * monthly_limit:
            used = round(spent / monthly_limit * 100)
            out.append({
                'type': 'budget_threshold',
                'title': 'Budget alert',
                'body': f"You've used {used}% of a category budget this month.",
                'payload': {'category_id': cat_id},
                'dedup_key': f"budget_threshold:{cat_id}:{ym}",
            })
    return out


def _large_charge_candidates(supabase, user_id, config, since, today) -> list:
    threshold = float(config.get('amount', 200))
    cutoff = (today - datetime.timedelta(days=LARGE_CHARGE_LOOKBACK_DAYS)).isoformat()
    q = supabase.table('transactions') \
        .select('id, account_id, amount, pending, merchant_name, created_at, effective_date') \
        .eq('user_id', user_id) \
        .eq('pending', False) \
        .eq('exclude_from_totals', False) \
        .eq('is_reimbursement', False) \
        .is_('transfer_group_id', 'null') \
        .gte('effective_date', cutoff)   # recent charges only — see LARGE_CHARGE_LOOKBACK_DAYS
    # Also limit to rows written this sync so an incremental run doesn't re-scan
    # the whole window (dedup would suppress re-fires, but the scan is wasteful).
    # `since` is the run's start timestamp; None (reconcile / tests) skips it.
    if since is not None:
        q = q.gte('created_at', since)
    out = []
    for t in q.execute().data:
        # "Charge" == money OUT: positive == spend (the category_spend / client
        # convention). Using abs() here fired on income (paychecks, incoming Zelle)
        # and the credit legs of transfers — hence the flood of bogus alerts. Also
        # exclude transfers (transfer_group_id), excluded rows, and reimbursements
        # above, so an internal move or a refund never reads as a large charge.
        amt = float(t['amount'] or 0)
        if amt >= threshold:
            where = f" at {t['merchant_name']}" if t.get('merchant_name') else ''
            out.append({
                'type': 'large_charge',
                'title': 'Large transaction',
                'body': f"A charge of {_money(amt)} posted{where}.",
                'payload': {'transaction_id': t['id'], 'account_id': t.get('account_id')},
                'dedup_key': f"large_charge:{t['id']}",
            })
    return out


def _prior_balances(supabase, user_id, account_ids, current_date_by_acct) -> dict:
    """{account_id: prior current_balance} — the newest recorded non-null balance
    strictly BEFORE each account's current observation. Used to detect a low-balance
    *crossing* (prev >= floor, now < floor) instead of alerting on every evaluation.
    Missing (first-ever sync) → account absent from the returned dict."""
    if not account_ids:
        return {}
    rows = supabase.table('account_balance_history') \
        .select('account_id, current_balance, date') \
        .eq('user_id', user_id) \
        .in_('account_id', list(account_ids)) \
        .execute().data
    # Pick the max date < current per account in Python: history can be large and
    # PostgREST can't window-limit "two newest per group" in one call, and the
    # fakes tier doesn't sort — so don't lean on DB ordering. ISO 'YYYY-MM-DD'
    # sorts chronologically as text.
    best = {}   # account_id -> (date, balance)
    for r in rows:
        bal = r.get('current_balance')
        if bal is None:
            continue
        aid, d = r['account_id'], r.get('date')
        cur_d = current_date_by_acct.get(aid)
        if cur_d is not None and d is not None and d >= cur_d:
            continue   # skip the current observation (and anything not before it)
        cur_best = best.get(aid)
        if cur_best is None or (d is not None and d > cur_best[0]):
            best[aid] = (d, float(bal))
    return {aid: v[1] for aid, v in best.items()}


def _release_low_balance_keys(supabase, user_id, keys) -> None:
    """Free the crossing-scoped dedup key for accounts that have RECOVERED to/above
    the floor. The key is static per account (see _low_balance_candidates), so
    without this a later re-crossing would collide with the first crossing's row and
    be suppressed forever. Nulling dedup_key (not deleting the row) keeps the inbox
    history intact while releasing the unique slot; dedup_key isn't read anywhere
    but the insert path."""
    if not keys:
        return
    supabase.table('notifications') \
        .update({'dedup_key': None}) \
        .eq('user_id', user_id) \
        .in_('dedup_key', list(keys)) \
        .execute()


def _low_balance_candidates(supabase, user_id, config) -> list:
    floor = float(config.get('amount', 100))
    balances = supabase.table('latest_balances') \
        .select('account_id, current_balance, date') \
        .eq('user_id', user_id) \
        .execute().data
    accounts = supabase.table('accounts') \
        .select('id, name, type, subtype') \
        .eq('user_id', user_id) \
        .eq('is_active', True) \
        .execute().data
    active = {a['id']: a for a in accounts}

    # First pass: split the user's accounts into those currently below the floor
    # (candidates for a crossing) and those at/above it (recovered → release the
    # key). Non-actionable accounts are excluded outright.
    below, recovered_keys, cur_date_by_acct = [], [], {}
    for b in balances:
        acct = active.get(b['account_id'])
        if acct is None or _is_liability(acct.get('type')):
            continue   # skip inactive/removed and liabilities (low debt ≠ risk)
        if acct.get('subtype') == 'prepaid':
            continue   # prepaid depository isn't a spendable cash buffer
        bal = float(b['current_balance'] or 0)
        key = f"low_balance:{b['account_id']}"
        # A $0 (or negative) balance is an unfunded / closed / pass-through account
        # (e.g. a bill-pay account that sits at $0), not actionable low cash. This
        # <= 0 rule — not name matching, which is fragile — is what keeps those out.
        if bal <= 0:
            continue
        if bal >= floor:
            recovered_keys.append(key)
            continue
        cur_date_by_acct[b['account_id']] = b.get('date')
        below.append((b, acct, key, bal))

    _release_low_balance_keys(supabase, user_id, recovered_keys)
    if not below:
        return []

    prev_by_acct = _prior_balances(
        supabase, user_id, cur_date_by_acct.keys(), cur_date_by_acct)

    out = []
    for b, acct, key, bal in below:
        prev = prev_by_acct.get(b['account_id'])
        # Fire only on the CROSSING from at/above the floor to below it. If the
        # prior recorded balance was already below, the account has been low since
        # a previous sync — stay silent (this is the daily-repeat fix). No prior
        # record at all (first-ever sync) counts as one crossing → emit once.
        if prev is not None and prev < floor:
            continue
        name = acct.get('name') or 'An account'
        out.append({
            'type': 'low_balance',
            'title': 'Low balance',
            'body': f"{name} is below {_money(floor)} (now {_money(bal)}).",
            'payload': {'account_id': b['account_id']},
            # Crossing-scoped, NOT date-scoped: one live low-balance alert per
            # account, released by _release_low_balance_keys once it recovers so a
            # later recover→drop cycle can alert again. (The old key embedded the
            # calendar date, so it re-fired every single day the balance stayed low.)
            'dedup_key': key,
        })
    return out


def _sync_failed_candidates(item_errors, today) -> list:
    """item_errors: [{'item_id', 'plaid_item_id', 'institution_name'}, ...] for
    the items that raised during this sync (built in sync.run_sync)."""
    # Coarsen the calendar day into a cooldown window so a persistently-broken
    # item alerts at most once per window instead of every daily cron run (the
    # old key used the raw date, so it re-fired daily). The window resets on its
    # own, so a still-broken connection reminds the user again after the cooldown.
    bucket = today.toordinal() // SYNC_FAILED_COOLDOWN_DAYS
    out = []
    for it in (item_errors or []):
        item_id = it.get('item_id')
        if not item_id:
            continue
        name = it.get('institution_name') or 'A bank connection'
        out.append({
            'type': 'sync_failed',
            'title': 'Account needs attention',
            'body': f"{name} couldn't be updated. Please reconnect it.",
            'payload': {'item_id': item_id},
            'dedup_key': f"sync_failed:{item_id}:{bucket}",
        })
    return out


# ── dedup + insert ───────────────────────────────────────────────────────────
def _insert_new(supabase, user_id, candidates) -> list:
    """Drop candidates whose dedup_key already exists (or repeats within this
    batch), then insert the rest. Returns the rows actually inserted."""
    if not candidates:
        return []

    keys = [c['dedup_key'] for c in candidates if c.get('dedup_key')]
    existing = set()
    if keys:
        rows = supabase.table('notifications') \
            .select('dedup_key') \
            .eq('user_id', user_id) \
            .in_('dedup_key', keys) \
            .execute().data
        existing = {r['dedup_key'] for r in rows}

    fresh, seen = [], set()
    for c in candidates:
        k = c.get('dedup_key')
        if k is not None and (k in existing or k in seen):
            continue
        if k is not None:
            seen.add(k)
        fresh.append({'user_id': user_id, **c})
    if not fresh:
        return []

    try:
        supabase.table('notifications').insert(fresh).execute()
    except Exception:
        # A concurrent evaluation may have inserted the same dedup_key between
        # our read and write, tripping the partial unique index and failing the
        # whole batch. Retry per row so the survivors still land; never fatal.
        logger.warning('notifications batch insert failed; retrying per-row',
                       exc_info=True)
        for row in fresh:
            try:
                supabase.table('notifications').insert(row).execute()
            except Exception:
                logger.debug('notification insert skipped (dedup race)',
                             exc_info=True)

    # Phase C: fan the just-inserted rows out to APNs. Central here so both
    # the on-sync rules and the digest cron (which also route through _insert_new)
    # get push for free. Dormant no-op until the APNS_* env is set, and fully
    # isolated — a push failure must never affect evaluation or the sync.
    # ponytail: pushes `fresh` (the rows we tried to insert); in the rare per-row
    # retry above a row can fail to land yet still be pushed. Best-effort push
    # tolerates that over threading landed-row bookkeeping through the retry.
    _emit_push(supabase, user_id, fresh)
    return fresh


def _emit_push(supabase, user_id, rows) -> None:
    """Best-effort APNs fan-out for freshly-inserted notifications. Lazy import
    keeps push.py's httpx/jwt out of alerts' import graph, and the guard means a
    missing dependency or any send error can never break evaluation."""
    if not rows:
        return
    try:
        import push
        push.send_push_for_rows(supabase, user_id, rows)
    except Exception:
        logger.warning('push dispatch failed', exc_info=True)


# ── entry point ──────────────────────────────────────────────────────────────
def evaluate_user_alerts(supabase, user_id, *, item_errors=None, since=None,
                         today=None) -> list:
    """Evaluate every on-sync alert type for one user and insert the non-
    duplicate notifications. Returns the inserted rows (handy for tests).

    item_errors — per-item failure info for sync_failed (see _sync_failed_*).
    since        — ISO timestamp bounding large_charge to rows written this run.
    today        — injected for deterministic tests; defaults to date.today().
    """
    today = today or datetime.date.today()
    prefs = _load_prefs(supabase, user_id)
    candidates = []

    enabled, cfg = _pref_for(prefs, 'budget_threshold')
    if enabled:
        candidates += _budget_threshold_candidates(supabase, user_id, cfg, today)

    enabled, cfg = _pref_for(prefs, 'large_charge')
    if enabled:
        candidates += _large_charge_candidates(supabase, user_id, cfg, since, today)

    enabled, cfg = _pref_for(prefs, 'low_balance')
    if enabled:
        candidates += _low_balance_candidates(supabase, user_id, cfg)

    enabled, _cfg = _pref_for(prefs, 'sync_failed')
    if enabled and item_errors:
        candidates += _sync_failed_candidates(item_errors, today)

    # TODO: bill_due — evaluate predicted upcoming bills here once
    # recurring-debit prediction is modeled server-side (see DEFAULTS note).

    return _insert_new(supabase, user_id, candidates)
