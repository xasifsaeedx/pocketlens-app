"""Drift reconciler — nightly safety net behind the cursor-based sync.

Cursor sync only ever sees deltas, so any divergence between our copy and
Plaid's record (missed webhook events, rows lost to a bug or manual surgery,
historical rows written by since-fixed sync code) persists forever. This job
re-fetches each item's full transaction window with a cursor-less
/transactions/sync, diffs it against the DB, and heals:

  - missing    — in Plaid, not in DB          → insert (ON CONFLICT DO NOTHING)
  - mismatched — Plaid-owned fields differ    → targeted UPDATE of those fields
  - stale      — in DB, gone from Plaid       → delete (guarded, see below)

It only ever writes the Plaid-owned columns (sync.PLAID_OWNED); user-owned
data (category_id, notes, hidden, exclude_from_totals, transfer_*, tags,
splits) is never touched. The item cursor is never written — the incremental
sync's state is not ours to move.

Stale is the one destructive class, and absence-from-snapshot is weaker
evidence than a Plaid `removed` event (the snapshot only covers Plaid's
*currently stored* window, which can shrink on relink/migration/retention
aging, or come back empty on a bad night). So deletes are triple-guarded:
never on an empty snapshot, never when the raw divergence (DB rows the
snapshot didn't account for, measured before the window floor) exceeds an
anomaly cap — the fingerprint of a truncated/partial replay — and never for
rows older than the snapshot's own window. Anomalies log an error
instead of deleting.

Runs on the pocketlens-sync cron right after sync.py (see render.yaml), so a
non-zero drift count means the *sync itself* is leaking — the warning log is
the alert signal, the heal is the mitigation.
"""
import logging

import vault
from categorizer import apply_learned, load_guess_context
from plaid_client import get_plaid_for_item
from supabase_client import get_supabase, now_iso
from sync import (
    PLAID_OWNED,
    _acquire_item_lock,
    _finalize_user,
    _is_demo_item,
    amounts_equal,
    plaid_txn_fields,
    txn_sync_request,
)
from transfers import unlink_groups

logger = logging.getLogger('reconcile')

DB_PAGE = 1000            # PostgREST caps responses at ~1000 rows; page explicitly
DRIFT_KEYS = ('missing', 'mismatched', 'stale')
# Anomaly cap for stale deletes: more than this many rows vanishing from the
# snapshot at once is a truncated replay until proven otherwise, not drift.
STALE_CAP_MIN, STALE_CAP_FRACTION = 20, 0.10


def _fetch_plaid_snapshot(plaid, access_token) -> dict:
    """Full-window ground truth: {plaid_transaction_id: txn}. A fresh cursor
    replays everything as `added`; modified/removed are applied anyway in case
    Plaid interleaves them mid-pagination."""
    snapshot = {}
    cursor = None
    while True:
        resp = plaid.transactions_sync(txn_sync_request(access_token, cursor)).to_dict()
        for txn in resp.get('added', []) + resp.get('modified', []):
            snapshot[txn['transaction_id']] = txn
        for txn in resp.get('removed', []):
            snapshot.pop(txn['transaction_id'], None)
        cursor = resp['next_cursor']
        if not resp['has_more']:
            return snapshot


def _fetch_db_rows(supabase, account_ids) -> list:
    rows = []
    start = 0
    while True:
        # order() is load-bearing: PostgREST gives no stable row order without
        # it, so unordered .range() pages can skip/duplicate rows across the
        # separate requests.
        page = supabase.table('transactions') \
            .select('plaid_transaction_id, ' + ', '.join(PLAID_OWNED)
                    + ', transfer_group_id, transfer_kind') \
            .in_('account_id', account_ids) \
            .order('plaid_transaction_id') \
            .range(start, start + DB_PAGE - 1) \
            .execute().data
        rows.extend(page)
        if len(page) < DB_PAGE:
            return rows
        start += DB_PAGE


def _differs(db_row, want) -> bool:
    for key, val in want.items():
        have = db_row.get(key)
        if key == 'amount':
            # Cents compare — DB is decimal(12,2), Plaid floats can carry
            # sub-cent precision; raw != would flag those rows nightly forever.
            if not amounts_equal(have, val):
                return True
        elif have != val:
            return True
    return False


def _lock_token(supabase, item_id):
    return supabase.table('plaid_items').select('sync_started_at') \
        .eq('id', item_id).single().execute().data['sync_started_at']


def _still_owner(supabase, item_id, token) -> bool:
    """The item lock has a 15-min stale timeout (sync.py) — a long reconcile
    can have it stolen by a webhook sync. Re-check before destructive writes."""
    return _lock_token(supabase, item_id) == token


def reconcile_item(plaid, supabase, item, ctx, user_id) -> dict | None:
    """Diff one item against Plaid and heal. Returns drift counts, or None if
    the item lock was busy (a live sync is running — skip, next night catches it)."""
    item_id = item['id']
    if not _acquire_item_lock(supabase, item_id):
        logger.info('skipping item, sync in progress',
                    extra={'institution': item.get('institution_name')})
        return None
    token = _lock_token(supabase, item_id)
    try:
        return _reconcile_item_locked(plaid, supabase, item, ctx, user_id, token)
    finally:
        # Release only if still ours — unconditionally clearing is_syncing
        # would drop the lock out from under a thief that stole it (stale
        # timeout) and is now legitimately syncing.
        supabase.table('plaid_items').update({'is_syncing': False}) \
            .eq('id', item_id).eq('sync_started_at', token).execute()


def _reconcile_item_locked(plaid, supabase, item, ctx, user_id, token) -> dict:
    drift = {k: 0 for k in DRIFT_KEYS}
    access_token = vault.decrypt(item['access_token'])

    accounts = supabase.table('accounts') \
        .select('id, plaid_account_id, is_active, type') \
        .eq('plaid_item_id', item['id']).execute().data
    # Diff scope = active accounts only. A deactivated account should be absent
    # from the snapshot too (Plaid dropped it); if its history replays anyway,
    # the inactive set below swallows it silently instead of warning nightly.
    acct_map = {a['plaid_account_id']: a['id'] for a in accounts if a['is_active']}
    # {uuid: type} so apply_learned can auto-flag card refunds on healed
    # rows too — otherwise the reconciler re-introduces the income-not-refund bug.
    acct_types = {a['id']: a.get('type') for a in accounts if a['is_active']}
    inactive_pids = {a['plaid_account_id'] for a in accounts if not a['is_active']}
    if not acct_map:
        return drift

    # DB first, Plaid second: a row inserted concurrently mid-run then shows up
    # in the snapshot but not our read → "missing" → ON CONFLICT no-op. The
    # reverse order would classify it "stale" and delete it.
    db_by_pid = {r['plaid_transaction_id']: r
                 for r in _fetch_db_rows(supabase, list(acct_map.values()))}
    snapshot = _fetch_plaid_snapshot(plaid, access_token)

    # ── missing: in Plaid, not in DB ─────────────────────────────────
    missing, unknown_accts = [], set()
    for pid, txn in snapshot.items():
        if pid in db_by_pid:
            continue
        acct_uuid = acct_map.get(txn['account_id'])
        if acct_uuid is None:
            if txn['account_id'] not in inactive_pids:
                unknown_accts.add(txn['account_id'])
            continue
        missing.append({
            'user_id': user_id,
            'plaid_transaction_id': pid,
            'account_id': acct_uuid,
            'category_id': None,
            'is_reimbursement': False,
            **plaid_txn_fields(txn),
        })
    if unknown_accts:
        # sync.py owns account creation and runs right before us on the cron;
        # one aggregated warning per run, not one per transaction.
        logger.warning('snapshot txns on unmapped accounts, skipping', extra={
            'accounts': sorted(unknown_accts),
            'institution': item.get('institution_name')})
    missing = apply_learned(missing, ctx, acct_types)
    if missing:
        res = supabase.table('transactions').upsert(
            missing, on_conflict='plaid_transaction_id', ignore_duplicates=True,
        ).execute()
        # Count what actually landed: DO NOTHING returns only inserted rows,
        # so a row that slipped in since our read doesn't fire a false alert.
        drift['missing'] = len(res.data)

    # ── mismatched: Plaid-owned fields differ ────────────────────────
    broken_groups = []
    for pid, row in db_by_pid.items():
        txn = snapshot.get(pid)
        if txn is None:
            continue
        want = plaid_txn_fields(txn)
        if not _differs(row, want):
            continue
        # Same invariant as sync.py's modified path: an amount change breaks
        # an auto-detected transfer pair's net-zero — unlink so detect re-pairs.
        # Manual links are the user's assertion; left alone.
        if row.get('transfer_kind') == 'auto' and not amounts_equal(row['amount'], want['amount']):
            broken_groups.append(row['transfer_group_id'])
        supabase.table('transactions') \
            .update({**want, 'updated_at': now_iso()}) \
            .eq('plaid_transaction_id', pid).execute()
        drift['mismatched'] += 1
    unlink_groups(supabase, broken_groups)

    # ── stale: in DB, gone from Plaid (guarded — deletes are irreversible
    #    for user-owned columns, so absence alone isn't trusted) ───────
    stale_ids = [pid for pid in db_by_pid if pid not in snapshot]
    if stale_ids and not snapshot:
        logger.error('empty Plaid snapshot but DB has rows — refusing stale delete',
                     extra={'db_rows': len(db_by_pid),
                            'institution': item.get('institution_name')})
        return drift
    # Anomaly cap on the RAW divergence — how many DB rows the snapshot failed to
    # account for, measured BEFORE the window-floor filter below. A truncated or
    # partial replay drops a whole slice of the window at once; when the dropped
    # slice is the older end, the floor filter writes it off as retention aging
    # and lets the *remaining* handful be deleted as "stale" — nuking live rows on
    # an incomplete replay. Gating on the pre-floor count means a suspect replay
    # heals nothing, not just its unaged remainder. (Post-floor stale is always
    # ≤ this raw count, so this subsumes the earlier post-floor cap check.)
    if stale_ids:
        cap = max(STALE_CAP_MIN, int(len(db_by_pid) * STALE_CAP_FRACTION))
        if len(stale_ids) > cap:
            logger.error('stale delete over anomaly cap — refusing (truncated replay?)',
                         extra={'stale': len(stale_ids), 'cap': cap,
                                'institution': item.get('institution_name')})
            return drift
    if stale_ids:
        # Window floor: the snapshot only proves absence within the window
        # Plaid actually replayed. Rows older than its oldest transaction may
        # simply have aged out of Plaid's retention — never stale.
        floor = min(str(t['date']) for t in snapshot.values())
        stale_ids = [pid for pid in stale_ids if db_by_pid[pid]['date'] >= floor]
    if stale_ids:
        if not _still_owner(supabase, item['id'], token):
            logger.warning('item lock stolen mid-reconcile — skipping stale delete',
                           extra={'institution': item.get('institution_name')})
            return drift
        # Deleting a transfer leg orphans its partner — unlink those groups so
        # the survivor re-pairs on the finalize pass (same as sync's removed path).
        linked = {db_by_pid[pid].get('transfer_group_id') for pid in stale_ids}
        supabase.table('transactions').delete() \
            .in_('plaid_transaction_id', stale_ids).execute()
        unlink_groups(supabase, linked)
        drift['stale'] = len(stale_ids)

    return drift


def run_reconcile(user_id: str = None) -> dict:
    """Reconcile every active item (or one user's). Heals drift, re-runs the
    per-user finalize pass for users whose data changed, and returns totals."""
    supabase = get_supabase()

    q = supabase.table('plaid_items').select('*').eq('is_active', True)
    if user_id:
        q = q.eq('user_id', user_id)
    items = q.execute().data

    totals = {k: 0 for k in DRIFT_KEYS}
    drifted_users = set()
    failed = 0
    ctx_by_user = {}
    for item in items:
        uid = item['user_id']
        if _is_demo_item(item):
            continue
        if uid not in ctx_by_user:
            ctx_by_user[uid] = load_guess_context(uid)
        try:
            plaid = get_plaid_for_item(supabase, item)
            drift = reconcile_item(plaid, supabase, item, ctx_by_user[uid], uid)
        except Exception:
            failed += 1
            # Partial heals may have landed before the exception — finalize the
            # user anyway so healed rows get paired and totals refreshed.
            drifted_users.add(uid)
            logger.exception('item reconcile failed', extra={
                'institution': item.get('institution_name'),
                'plaid_item_id': item.get('plaid_item_id'), 'user_id': uid,
            })
            continue
        if drift and any(drift.values()):
            drifted_users.add(uid)
            for k in DRIFT_KEYS:
                totals[k] += drift[k]
            # warning, not info: post-sync drift means something upstream is
            # leaking — this is the alert signal, the heal is the mitigation.
            logger.warning('drift found and healed', extra={
                'institution': item.get('institution_name'), 'user_id': uid, **drift,
            })

    # Healed rows change pairing/net-worth inputs — full-history rescan, since
    # healed rows can be anywhere in the window (same reason first-history
    # syncs scan full). Isolated per user: one failure must not skip the rest.
    for uid in drifted_users:
        try:
            _finalize_user(supabase, uid, full=True)
        except Exception:
            failed += 1
            logger.exception('reconcile finalize failed', extra={'user_id': uid})

    if any(totals.values()) or failed:
        logger.warning('reconcile complete', extra={**totals, 'failed_items': failed})
    else:
        logger.info('reconcile complete, no drift', extra=totals)
    return totals


if __name__ == '__main__':
    from logging_setup import setup_logging
    setup_logging()
    run_reconcile()
